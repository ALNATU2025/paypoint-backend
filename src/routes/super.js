// Super admin API (SUPER_ADMIN_EMAILS, logged in only). Super admins also use
// /api/admin/* to monitor everything; there they see all accounts.

const express = require('express');
const { requireSuperAdmin } = require('../middleware');
const platform = require('../services/platform');
const { ApiError, ah, toKobo } = require('../utils');

const router = express.Router();
router.use(requireSuperAdmin);

function parseAmount(v) {
  const amount = Number(v);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) throw new ApiError(400, 'Enter a valid amount');
  return amount;
}

async function walletsResponse(res, message) {
  const p = await platform.get();
  res.json({
    success: true,
    message,
    data: {
      ...platform.summary(p, { isSuper: true }),
      ledger: await platform.ledger({ isSuper: true, limit: 50 }),
    },
  });
}

// POST /api/super/pool/credit { amount, note? } — fund the Paypoint wallet
router.post(
  '/pool/credit',
  ah(async (req, res) => {
    const body = req.body || {};
    await platform.creditPool(toKobo(parseAmount(body.amount)), req.user._id, String(body.note || '').trim());
    await walletsResponse(res, 'Paypoint wallet funded');
  }),
);

// POST /api/super/pool/debit { amount, note? } — correct the Paypoint wallet
router.post(
  '/pool/debit',
  ah(async (req, res) => {
    const body = req.body || {};
    await platform.debitPool(toKobo(parseAmount(body.amount)), req.user._id, String(body.note || '').trim());
    await walletsResponse(res, 'Paypoint wallet corrected');
  }),
);

module.exports = router;
