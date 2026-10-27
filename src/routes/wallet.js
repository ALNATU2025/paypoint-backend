const express = require('express');
const { requireAuth } = require('../middleware');
const { ah, toNaira } = require('../utils');

const router = express.Router();

// GET /api/wallet — current balance
router.get(
  '/',
  requireAuth,
  ah(async (req, res) => {
    res.json({ success: true, data: { balance: toNaira(req.user.balanceKobo) } });
  }),
);

module.exports = { router };
