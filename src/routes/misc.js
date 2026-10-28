const express = require('express');
const { Transaction, User } = require('../models');
const { requireAuth, requireAdmin } = require('../middleware');
const { ApiError, ah, toKobo, toNaira, normalizePhone, normalizeEmail, isEmail, randomRef } = require('../utils');

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
// Admin (only when ADMIN_API_KEY is set; send it as x-admin-key)
// ---------------------------------------------------------------------------

const admin = express.Router();
admin.use(requireAdmin);

// POST /api/admin/wallet/credit { email (or phone), amount, note? }
admin.post(
  '/wallet/credit',
  ah(async (req, res) => {
    const body = req.body || {};
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 5000000) throw new ApiError(400, 'Enter a valid amount');
    let filter;
    if (body.email) {
      const email = normalizeEmail(body.email);
      if (!isEmail(email)) throw new ApiError(400, 'Enter a valid email address');
      filter = { email };
    } else {
      const phone = normalizePhone(body.phone);
      if (!phone) throw new ApiError(400, 'Send the user\'s email (or phone)');
      if ((await User.countDocuments({ phone })) > 1) {
        throw new ApiError(409, 'Several accounts use that phone number. Use their email instead.');
      }
      filter = { phone };
    }
    const amountKobo = toKobo(amount);
    const user = await User.findOneAndUpdate(filter, { $inc: { balanceKobo: amountKobo } }, { new: true });
    if (!user) throw new ApiError(404, 'No account found');
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

module.exports = { transactions, admin };
