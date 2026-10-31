const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { config } = require('../config');
const { Transaction, User } = require('../models');
const { requireAuth } = require('../middleware');
const vtpass = require('../services/vtpass');
const wallet = require('../services/wallet');
const platform = require('../services/platform');
const { ApiError, ah, toKobo, vtpassRequestId, isPin, requireFields } = require('../utils');

const router = express.Router();
router.use(requireAuth);

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;

function service(serviceID) {
  const s = vtpass.CABLE_SERVICES[String(serviceID || '').toLowerCase()];
  if (!s) throw new ApiError(400, 'Unknown provider. Use dstv, gotv or startimes.');
  return s;
}

function cleanNumber(v) {
  const n = String(v || '').replace(/\D/g, '');
  if (n.length < 8 || n.length > 14) throw new ApiError(400, 'Enter a valid smartcard / IUC number');
  return n;
}

/** Check the transaction PIN with lockout after repeated failures. */
async function checkPin(user, pin) {
  if (!user.pinHash) throw new ApiError(403, 'Create a transaction PIN first', { code: 'PIN_NOT_SET' });
  if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
    const mins = Math.ceil((user.pinLockedUntil - Date.now()) / 60000);
    throw new ApiError(423, `Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
  if (!isPin(pin) || !(await bcrypt.compare(pin, user.pinHash))) {
    const attempts = (user.pinFailedAttempts || 0) + 1;
    const locked = attempts >= MAX_PIN_ATTEMPTS;
    await User.updateOne(
      { _id: user._id },
      locked
        ? { pinFailedAttempts: 0, pinLockedUntil: new Date(Date.now() + PIN_LOCK_MS) }
        : { pinFailedAttempts: attempts },
    );
    const left = MAX_PIN_ATTEMPTS - attempts;
    throw new ApiError(
      401,
      locked ? 'Too many wrong PINs. Try again in 15 minutes.' : `Incorrect PIN. ${left} attempt${left === 1 ? '' : 's'} left.`,
      { code: 'WRONG_PIN' },
    );
  }
  if (user.pinFailedAttempts || user.pinLockedUntil) {
    await User.updateOne({ _id: user._id }, { pinFailedAttempts: 0, pinLockedUntil: null });
  }
}

// GET /api/cable/providers
router.get('/providers', (req, res) => {
  res.json({
    success: true,
    data: Object.values(vtpass.CABLE_SERVICES).map((s) => ({
      serviceID: s.serviceID,
      name: s.name,
      supportsMonths: s.supportsMonths,
    })),
    serviceFee: config.serviceFeeNaira,
  });
});

// GET /api/cable/:serviceID/packages
router.get(
  '/:serviceID/packages',
  ah(async (req, res) => {
    const s = service(req.params.serviceID);
    const packages = await vtpass.getVariations(s.serviceID);
    res.json({
      success: true,
      data: packages,
      serviceFee: config.serviceFeeNaira,
      supportsMonths: s.supportsMonths,
      // DStv: pay any amount, and Extra View as an add-on at the admin's price.
      customAmount: s.customAmount ? { min: MIN_CUSTOM_NAIRA, max: MAX_CUSTOM_NAIRA } : null,
      extraView: s.extraView ? { amount: await platform.extraViewNaira() } : null,
    });
  }),
);

// POST /api/cable/verify { serviceID, billersCode }
router.post(
  '/verify',
  ah(async (req, res) => {
    requireFields(req.body || {}, ['serviceID', 'billersCode']);
    const s = service(req.body.serviceID);
    const billersCode = cleanNumber(req.body.billersCode);
    const data = await vtpass.verifyCustomer(s.serviceID, billersCode);
    res.json({ success: true, data: { ...data, serviceID: s.serviceID, billersCode } });
  }),
);

// Limits for "pay any amount" (naira).
const MIN_CUSTOM_NAIRA = 100;
const MAX_CUSTOM_NAIRA = 500000;

/**
 * Charge one cable payment: debit the user, hold it from the Paypoint wallet,
 * send it to VTPass and settle it. Returns the settled transaction.
 */
async function charge(user, item) {
  const { s, billersCode, mode, amountNaira, variationCode, packageName, months, customerName, feeKobo } = item;
  const description = `${s.name} ${packageName}`;
  const totalKobo = toKobo(amountNaira) + feeKobo;
  const poolKobo = toKobo(amountNaira);
  const txId = new mongoose.Types.ObjectId();

  await wallet.debit(user._id, totalKobo);
  // Every payment is also covered by the Paypoint wallet. When it can't
  // cover it, nothing goes through, whatever the user's balance.
  if (!(await platform.holdForPayment(poolKobo, txId, description))) {
    await User.updateOne({ _id: user._id }, { $inc: { balanceKobo: totalKobo } });
    throw new ApiError(503, 'Payments are temporarily unavailable. Please try again shortly.', {
      code: 'SERVICE_UNAVAILABLE',
    });
  }

  let tx;
  try {
    tx = await Transaction.create({
      _id: txId,
      poolKobo,
      user: user._id,
      type: 'cable',
      status: 'pending',
      amountKobo: totalKobo,
      feeKobo,
      description,
      serviceID: s.serviceID,
      billersCode,
      customerName,
      variationCode,
      packageName,
      months,
      phone: user.phone,
      requestId: vtpassRequestId(),
    });
  } catch (e) {
    // Could not record it: put both balances back before failing.
    await User.updateOne({ _id: user._id }, { $inc: { balanceKobo: totalKobo } });
    await platform.releasePayment({ _id: txId, poolKobo, description });
    throw e;
  }

  let result;
  try {
    result = await vtpass.pay({
      requestId: tx.requestId,
      serviceID: s.serviceID,
      billersCode,
      variationCode,
      amount: amountNaira,
      phone: user.phone,
      months,
      // "amount" (any amount / Extra View) is sent to VTPass as a renew with
      // that exact amount, which credits the decoder account with it.
      mode: mode === 'change' ? 'change' : 'renew',
    });
  } catch (e) {
    // Not configured / unexpected error before VTPass accepted it: refund.
    result = { status: 'failed', code: null, message: e.message || 'Payment could not be started' };
  }
  return wallet.settleCable(tx, result);
}

// POST /api/cable/pay
//   change: { serviceID, billersCode, variationCode, months?, pin, customerName? }
//   renew:  { serviceID, billersCode, mode: "renew", pin }            (DStv / GOtv)
//   amount: { serviceID, billersCode, mode: "amount", amount, pin }   (DStv: pay any amount)
//   extraView: true adds DStv Extra View as a second payment of exactly the
//   Extra View price set by the admin.
router.post(
  '/pay',
  ah(async (req, res) => {
    const body = req.body || {};
    const mode = ['renew', 'amount'].includes(body.mode) ? body.mode : 'change';
    requireFields(
      body,
      mode === 'change' ? ['serviceID', 'billersCode', 'variationCode', 'pin'] : ['serviceID', 'billersCode', 'pin'],
    );
    const s = service(body.serviceID);
    const billersCode = cleanNumber(body.billersCode);
    if (mode === 'renew' && !s.supportsMonths) throw new ApiError(400, `${s.name} does not support renewal. Choose a package.`);
    if (mode === 'amount' && !s.customAmount) throw new ApiError(400, `${s.name} does not support paying a custom amount.`);
    const wantsExtraView = body.extraView === true || body.extraView === 'true';
    if (wantsExtraView && !s.extraView) throw new ApiError(400, `Extra View is not available for ${s.name}.`);
    const months = mode === 'change' && s.supportsMonths ? Math.min(Math.max(parseInt(body.months, 10) || 1, 1), 12) : 1;

    // Validate the custom amount before asking for the PIN.
    let customNaira;
    if (mode === 'amount') {
      customNaira = Math.round(Number(body.amount) * 100) / 100;
      if (!Number.isFinite(customNaira) || customNaira < MIN_CUSTOM_NAIRA || customNaira > MAX_CUSTOM_NAIRA) {
        throw new ApiError(
          400,
          `Enter an amount between ₦${MIN_CUSTOM_NAIRA.toLocaleString()} and ₦${MAX_CUSTOM_NAIRA.toLocaleString()}`,
        );
      }
    }

    await checkPin(req.user, String(body.pin));

    // Prices always come from VTPass (or the admin's Extra View price), never from the client,
    // except a custom amount, which is exactly what the user chose to pay.
    let amountNaira;
    let variationCode;
    let packageName;
    let customerName = body.customerName ? String(body.customerName).slice(0, 80) : undefined;
    if (mode === 'renew') {
      const info = await vtpass.verifyCustomer(s.serviceID, billersCode);
      if (!info.renewalAmount || info.renewalAmount <= 0) {
        throw new ApiError(400, 'Renewal is not available for this decoder. Please choose a package.');
      }
      amountNaira = info.renewalAmount;
      packageName = info.currentBouquet ? `${info.currentBouquet} (renewal)` : 'Bouquet renewal';
      customerName = info.customerName;
    } else if (mode === 'amount') {
      amountNaira = customNaira;
      packageName = 'Custom amount';
    } else {
      const packages = await vtpass.getVariations(s.serviceID);
      const pkg = packages.find((p) => p.code === String(body.variationCode));
      if (!pkg) throw new ApiError(400, 'That package is no longer available. Please choose another.');
      amountNaira = pkg.amount * months;
      variationCode = pkg.code;
      packageName = pkg.name;
    }

    const feeKobo = toKobo(config.serviceFeeNaira);
    const extraViewNaira = wantsExtraView ? await platform.extraViewNaira() : 0;

    // Check both can be paid before starting, so Extra View isn't left half done.
    const needKobo = toKobo(amountNaira) + feeKobo + toKobo(extraViewNaira);
    const fresh = await User.findById(req.user._id);
    if (fresh.balanceKobo < needKobo) throw new ApiError(402, 'Insufficient wallet balance. Please fund your wallet.');
    if (!(await platform.canCover(toKobo(amountNaira) + toKobo(extraViewNaira)))) {
      throw new ApiError(503, 'Payments are temporarily unavailable. Please try again shortly.', {
        code: 'SERVICE_UNAVAILABLE',
      });
    }

    const base = { s, billersCode, customerName, feeKobo };
    const tx = await charge(req.user, { ...base, mode, amountNaira, variationCode, packageName, months });

    // Extra View: a second payment of exactly its price, only if the main one went through.
    let extraTx = null;
    let extraError = null;
    if (wantsExtraView && tx.status !== 'failed') {
      try {
        extraTx = await charge(req.user, {
          ...base,
          feeKobo: 0,
          mode: 'amount',
          amountNaira: extraViewNaira,
          packageName: 'Extra View',
          months: 1,
        });
      } catch (e) {
        extraError = e.message || 'Extra View could not be paid';
      }
    }

    const user = await User.findById(req.user._id);
    let message =
      tx.status === 'success'
        ? 'Subscription successful'
        : tx.status === 'pending'
          ? 'Payment is processing. We will confirm shortly.'
          : `Payment failed${tx.vtpassMessage ? `: ${tx.vtpassMessage}` : ''}. Your wallet has been refunded.`;
    if (wantsExtraView && tx.status !== 'failed') {
      if (extraError || (extraTx && extraTx.status === 'failed')) {
        message += ' Extra View could not be paid and was refunded.';
      } else if (extraTx && extraTx.status === 'pending') {
        message += ' Extra View is processing.';
      } else if (extraTx) {
        message += ' Extra View paid.';
      }
    }
    res.status(tx.status === 'failed' ? 422 : 200).json({
      success: tx.status !== 'failed',
      message,
      data: {
        transaction: tx.toPublic(),
        extraViewTransaction: extraTx ? extraTx.toPublic() : null,
        balance: user.toPublic().balance,
      },
    });
  }),
);

// POST /api/cable/requery/:id — refresh a pending payment.
router.post(
  '/requery/:id',
  ah(async (req, res) => {
    let tx = await Transaction.findOne({ _id: req.params.id, user: req.user._id, type: 'cable' });
    if (!tx) throw new ApiError(404, 'Transaction not found');
    if (tx.status === 'pending') {
      tx = await wallet.settleCable(tx, await vtpass.requery(tx.requestId));
    }
    const user = await User.findById(req.user._id);
    res.json({ success: true, data: { transaction: tx.toPublic(), balance: user.toPublic().balance } });
  }),
);

module.exports = router;
