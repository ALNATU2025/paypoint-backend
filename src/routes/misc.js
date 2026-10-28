const express = require('express');
const { Transaction } = require('../models');
const { requireAuth } = require('../middleware');
const { ApiError, ah } = require('../utils');

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

module.exports = { transactions };
