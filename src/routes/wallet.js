const express = require('express');
const { config } = require('../config');
const { Transaction, User } = require('../models');
const { requireAuth } = require('../middleware');
const paystack = require('../services/paystack');
const wallet = require('../services/wallet');
const { ApiError, ah, toKobo, toNaira, randomRef } = require('../utils');

const router = express.Router();

/**
 * Verify a Paystack reference with Paystack itself and credit the wallet once.
 * Shared by the app's verify call, the browser callback and the webhook.
 */
async function confirmFunding(reference) {
  const tx = await Transaction.findOne({ reference, type: 'funding' });
  if (!tx) throw new ApiError(404, 'Funding reference not found');
  if (tx.status !== 'pending') return tx;

  const data = await paystack.verify(reference);
  if (data.status === 'success') {
    if (Number(data.amount) !== tx.amountKobo || (data.currency && data.currency !== 'NGN')) {
      console.error('[paystack] amount/currency mismatch', reference, data.amount, data.currency);
      await wallet.failFunding(reference, 'Amount mismatch. Contact support.');
    } else {
      await wallet.completeFunding(reference);
    }
  } else if (['failed', 'abandoned', 'reversed'].includes(data.status)) {
    await wallet.failFunding(reference, `Payment ${data.status}`);
  }
  return Transaction.findOne({ reference });
}

// GET /api/wallet — current balance
router.get(
  '/',
  requireAuth,
  ah(async (req, res) => {
    res.json({ success: true, data: { balance: toNaira(req.user.balanceKobo) } });
  }),
);

// POST /api/wallet/fund/initialize { amount } → Paystack checkout URL
router.post(
  '/fund/initialize',
  requireAuth,
  ah(async (req, res) => {
    const amount = Number((req.body || {}).amount);
    if (!Number.isFinite(amount) || amount < config.minFundNaira || amount > config.maxFundNaira) {
      throw new ApiError(
        400,
        `Enter an amount between ₦${config.minFundNaira.toLocaleString()} and ₦${config.maxFundNaira.toLocaleString()}`,
      );
    }
    const amountKobo = toKobo(Math.round(amount));
    const reference = randomRef('PPF');
    const email = req.user.email || `${req.user.phone}@users.paypoint.app`;

    const tx = await Transaction.create({
      user: req.user._id,
      type: 'funding',
      status: 'pending',
      amountKobo,
      channel: 'paystack',
      reference,
      description: 'Wallet funding',
    });

    let data;
    try {
      data = await paystack.initialize({
        email,
        amountKobo,
        reference,
        metadata: { userId: req.user._id.toString(), purpose: 'wallet_funding' },
      });
    } catch (e) {
      await wallet.failFunding(reference, e.message);
      throw e;
    }
    res.json({
      success: true,
      data: { authorizationUrl: data.authorization_url, reference, transaction: tx.toPublic() },
    });
  }),
);

// GET /api/wallet/fund/verify/:reference — the app calls this after checkout.
router.get(
  '/fund/verify/:reference',
  requireAuth,
  ah(async (req, res) => {
    const owned = await Transaction.exists({ reference: req.params.reference, user: req.user._id, type: 'funding' });
    if (!owned) throw new ApiError(404, 'Funding reference not found');
    const tx = await confirmFunding(req.params.reference);
    const user = await User.findById(req.user._id);
    res.json({ success: true, data: { transaction: tx.toPublic(), balance: toNaira(user.balanceKobo) } });
  }),
);

// GET /api/wallet/fund/callback?reference=… — Paystack redirects the browser here.
router.get(
  '/fund/callback',
  ah(async (req, res) => {
    const reference = String(req.query.reference || req.query.trxref || '');
    let ok = false;
    try {
      const tx = reference ? await confirmFunding(reference) : null;
      ok = Boolean(tx && tx.status === 'success');
    } catch (e) {
      console.error('[paystack callback]', e.message);
    }
    res
      .type('html')
      .send(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>Paypoint</title><body style="font-family:system-ui;background:#0B1A55;color:#fff;` +
          `display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">` +
          `<div><h2>${ok ? 'Payment received ✅' : 'Payment is being confirmed'}</h2>` +
          `<p>You can return to the Paypoint app now.</p></div></body>`,
      );
  }),
);

module.exports = { router, confirmFunding };
