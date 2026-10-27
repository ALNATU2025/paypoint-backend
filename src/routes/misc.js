const express = require('express');
const { Transaction, User } = require('../models');
const { requireAuth, requireAdmin } = require('../middleware');
const paystack = require('../services/paystack');
const { confirmFunding } = require('./wallet');
const { ApiError, ah, toKobo, toNaira, normalizePhone, randomRef } = require('../utils');

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

const transactions = express.Router();
transactions.use(requireAuth);

// GET /api/transactions?type=cable&limit=50&before=<ISO date>
transactions.get(
  '/',
  ah(async (req, res) => {
    const q = { user: req.user._id };
    if (['cable', 'funding'].includes(req.query.type)) q.type = req.query.type;
    if (req.query.before) {
      const d = new Date(req.query.before);
      if (!Number.isNaN(d.getTime())) q.createdAt = { $lt: d };
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const list = await Transaction.find(q).sort({ createdAt: -1 }).limit(limit);
    res.json({ success: true, data: list.map((t) => t.toPublic()) });
  }),
);

// GET /api/transactions/:id
transactions.get(
  '/:id',
  ah(async (req, res) => {
    const tx = await Transaction.findOne({ _id: req.params.id, user: req.user._id });
    if (!tx) throw new ApiError(404, 'Transaction not found');
    res.json({ success: true, data: tx.toPublic() });
  }),
);

// ---------------------------------------------------------------------------
// Webhooks (raw body is attached by app.js for signature checks)
// ---------------------------------------------------------------------------

const webhooks = express.Router();

// POST /api/webhooks/paystack
webhooks.post(
  '/paystack',
  ah(async (req, res) => {
    if (!paystack.isValidSignature(req.rawBody, req.get('x-paystack-signature'))) {
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }
    const event = req.body || {};
    if (event.event === 'charge.success' && event.data && event.data.reference) {
      try {
        // Re-verify with Paystack rather than trusting the payload.
        await confirmFunding(String(event.data.reference));
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
    }
    res.json({ success: true });
  }),
);

// ---------------------------------------------------------------------------
// Admin (only when ADMIN_API_KEY is set; send it as x-admin-key)
// ---------------------------------------------------------------------------

const admin = express.Router();
admin.use(requireAdmin);

// POST /api/admin/wallet/credit { phone, amount, note? }
admin.post(
  '/wallet/credit',
  ah(async (req, res) => {
    const phone = normalizePhone((req.body || {}).phone);
    const amount = Number((req.body || {}).amount);
    if (!phone) throw new ApiError(400, 'Enter a valid phone number');
    if (!Number.isFinite(amount) || amount <= 0 || amount > 5000000) throw new ApiError(400, 'Enter a valid amount');
    const amountKobo = toKobo(amount);
    const user = await User.findOneAndUpdate({ phone }, { $inc: { balanceKobo: amountKobo } }, { new: true });
    if (!user) throw new ApiError(404, 'No account with that phone number');
    const tx = await Transaction.create({
      user: user._id,
      type: 'funding',
      status: 'success',
      amountKobo,
      channel: 'admin',
      reference: randomRef('PPA'),
      description: String((req.body || {}).note || 'Wallet credit').slice(0, 120),
    });
    res.json({ success: true, data: { balance: toNaira(user.balanceKobo), transaction: tx.toPublic() } });
  }),
);

module.exports = { transactions, webhooks, admin };
