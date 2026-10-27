const express = require('express');
const bcrypt = require('bcryptjs');
const { config } = require('../config');
const { Transaction, User } = require('../models');
const { requireAuth } = require('../middleware');
const vtpass = require('../services/vtpass');
const wallet = require('../services/wallet');
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
    res.json({ success: true, data: packages, serviceFee: config.serviceFeeNaira, supportsMonths: s.supportsMonths });
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

// POST /api/cable/pay
//   change: { serviceID, billersCode, variationCode, months?, pin, customerName? }
//   renew:  { serviceID, billersCode, mode: "renew", pin }  (DStv / GOtv only)
router.post(
  '/pay',
  ah(async (req, res) => {
    const body = req.body || {};
    const mode = body.mode === 'renew' ? 'renew' : 'change';
    requireFields(body, mode === 'renew' ? ['serviceID', 'billersCode', 'pin'] : ['serviceID', 'billersCode', 'variationCode', 'pin']);
    const s = service(body.serviceID);
    const billersCode = cleanNumber(body.billersCode);
    if (mode === 'renew' && !s.supportsMonths) throw new ApiError(400, `${s.name} does not support renewal. Choose a package.`);
    const months = mode === 'change' && s.supportsMonths ? Math.min(Math.max(parseInt(body.months, 10) || 1, 1), 12) : 1;

    await checkPin(req.user, String(body.pin));

    // Prices always come from VTPass, never from the client.
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
    } else {
      const packages = await vtpass.getVariations(s.serviceID);
      const pkg = packages.find((p) => p.code === String(body.variationCode));
      if (!pkg) throw new ApiError(400, 'That package is no longer available. Please choose another.');
      amountNaira = pkg.amount * months;
      variationCode = pkg.code;
      packageName = pkg.name;
    }

    const feeKobo = toKobo(config.serviceFeeNaira);
    const totalKobo = toKobo(amountNaira) + feeKobo;

    await wallet.debit(req.user._id, totalKobo);

    let tx = await Transaction.create({
      user: req.user._id,
      type: 'cable',
      status: 'pending',
      amountKobo: totalKobo,
      feeKobo,
      description: `${s.name} ${packageName}`,
      serviceID: s.serviceID,
      billersCode,
      customerName,
      variationCode,
      packageName,
      months,
      phone: req.user.phone,
      requestId: vtpassRequestId(),
    });

    let result;
    try {
      result = await vtpass.pay({
        requestId: tx.requestId,
        serviceID: s.serviceID,
        billersCode,
        variationCode,
        amount: amountNaira,
        phone: req.user.phone,
        months,
        mode,
      });
    } catch (e) {
      // Not configured / unexpected error before VTPass accepted it: refund.
      result = { status: 'failed', code: null, message: e.message || 'Payment could not be started' };
    }
    tx = await wallet.settleCable(tx, result);

    const user = await User.findById(req.user._id);
    res.status(tx.status === 'failed' ? 422 : 200).json({
      success: tx.status !== 'failed',
      message:
        tx.status === 'success'
          ? 'Subscription successful'
          : tx.status === 'pending'
            ? 'Payment is processing. We will confirm shortly.'
            : `Payment failed${tx.vtpassMessage ? `: ${tx.vtpassMessage}` : ''}. Your wallet has been refunded.`,
      data: { transaction: tx.toPublic(), balance: user.toPublic().balance },
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
