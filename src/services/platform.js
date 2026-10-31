// Platform wallets: the Paypoint wallet (pool) and the two Revenue wallets.
// Every change is one atomic MongoDB update plus a ledger entry.

const { config } = require('../config');
const { Platform, Ledger, User, Transaction } = require('../models');
const { ApiError, toNaira, randomRef } = require('../utils');

const KEY = 'main';

const FIELD = { pool: 'poolKobo', adminRevenue: 'adminRevenueKobo', superRevenue: 'superRevenueKobo' };

/** Create the platform document if it doesn't exist yet. */
async function ensure() {
  try {
    await Platform.updateOne({ _id: KEY }, { $setOnInsert: { poolKobo: 0 } }, { upsert: true });
  } catch (e) {
    if (e.code !== 11000) throw e; // created by a concurrent request
  }
}

async function get() {
  await ensure();
  return Platform.findById(KEY);
}

/**
 * Add `deltaKobo` (negative to take out) to one platform wallet.
 * Taking out only succeeds when the wallet covers it; returns null otherwise.
 */
async function move(wallet, deltaKobo, { kind, transaction = null, by = null, note = '', extraInc = {} }) {
  await ensure();
  const field = FIELD[wallet];
  const filter = { _id: KEY };
  if (deltaKobo < 0) filter[field] = { $gte: -deltaKobo };
  const doc = await Platform.findOneAndUpdate(filter, { $inc: { [field]: deltaKobo, ...extraInc } }, { new: true });
  if (!doc) return null;
  await Ledger.create({
    wallet,
    kind,
    amountKobo: deltaKobo,
    balanceAfterKobo: doc[field],
    transaction,
    by,
    note: String(note).slice(0, 160),
  });
  return doc;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Current DStv Extra View price in naira. */
async function extraViewNaira() {
  const p = await get();
  return p.extraViewKobo == null ? config.extraViewNaira : toNaira(p.extraViewKobo);
}

async function setExtraViewNaira(naira) {
  const n = Number(naira);
  if (!Number.isFinite(n) || n < 100 || n > 200000) throw new ApiError(400, 'Enter an Extra View price between ₦100 and ₦200,000');
  await ensure();
  await Platform.updateOne({ _id: KEY }, { extraViewKobo: Math.round(n * 100) });
  return extraViewNaira();
}

async function settings() {
  return { extraViewAmount: await extraViewNaira() };
}

/** True when the Paypoint wallet can cover this many kobo right now. */
async function canCover(kobo) {
  const p = await get();
  return p.poolKobo >= kobo;
}

// ---------------------------------------------------------------------------
// Cable payments
// ---------------------------------------------------------------------------

/** Hold a payment's cost from the Paypoint wallet. False if it can't cover it. */
async function holdForPayment(amountKobo, transactionId, note) {
  if (amountKobo <= 0) return true;
  return Boolean(await move('pool', -amountKobo, { kind: 'payment', transaction: transactionId, note }));
}

/** Return a failed payment's hold to the Paypoint wallet. */
async function releasePayment(tx) {
  if (!tx.poolKobo) return;
  await move('pool', tx.poolKobo, { kind: 'refund', transaction: tx._id, note: tx.description });
}

/** Revenue shares for a payment of this many kobo (bouquet amount, no fee). */
function revenueFor(baseKobo) {
  return {
    admin: Math.round((baseKobo * config.adminRevenuePercent) / 100),
    super: Math.round((baseKobo * config.superAdminRevenuePercent) / 100),
  };
}

/** Credit both Revenue wallets for a successful payment. Call once per payment. */
async function creditRevenue(tx) {
  const share = revenueFor(tx.amountKobo - (tx.feeKobo || 0));
  if (share.admin > 0) {
    await move('adminRevenue', share.admin, {
      kind: 'revenue',
      transaction: tx._id,
      note: tx.description,
      extraInc: { adminEarnedKobo: share.admin },
    });
  }
  if (share.super > 0) {
    await move('superRevenue', share.super, { kind: 'revenue', transaction: tx._id, note: tx.description });
  }
  await Transaction.updateOne({ _id: tx._id }, { adminRevenueKobo: share.admin, superRevenueKobo: share.super });
  return share;
}

// ---------------------------------------------------------------------------
// Super admin: fund / correct the Paypoint wallet
// ---------------------------------------------------------------------------

async function creditPool(amountKobo, by, note) {
  return move('pool', amountKobo, { kind: 'topup', by, note: note || 'Paypoint wallet funded' });
}

async function debitPool(amountKobo, by, note) {
  const doc = await move('pool', -amountKobo, { kind: 'correction', by, note: note || 'Correction' });
  if (!doc) {
    const p = await get();
    throw new ApiError(400, `Paypoint wallet balance is only ₦${toNaira(p.poolKobo).toLocaleString()}`);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Admin: withdraw revenue to the Paypoint wallet or their own app wallet
// ---------------------------------------------------------------------------

async function withdrawAdminRevenue(amountKobo, to, adminUser) {
  if (!['pool', 'main'].includes(to)) throw new ApiError(400, 'Choose where to withdraw to: pool or main');
  if (to === 'main' && !adminUser) throw new ApiError(400, 'Log in as the admin to withdraw to your wallet');

  const out = await move('adminRevenue', -amountKobo, {
    kind: 'withdrawal',
    by: adminUser ? adminUser._id : null,
    note: to === 'pool' ? 'To Paypoint wallet' : 'To main wallet',
    extraInc: { adminWithdrawnKobo: amountKobo },
  });
  if (!out) {
    const p = await get();
    throw new ApiError(400, `Revenue balance is only ₦${toNaira(p.adminRevenueKobo).toLocaleString()}`);
  }

  if (to === 'pool') {
    await move('pool', amountKobo, { kind: 'transfer', by: adminUser ? adminUser._id : null, note: 'From admin revenue' });
    return { to };
  }
  const user = await User.findByIdAndUpdate(adminUser._id, { $inc: { balanceKobo: amountKobo } }, { new: true });
  const tx = await Transaction.create({
    user: user._id,
    type: 'funding',
    status: 'success',
    amountKobo,
    channel: 'revenue',
    reference: randomRef('PPR'),
    description: 'Revenue withdrawal',
  });
  return { to, user, transaction: tx };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Wallet summary. Super admins also see their own revenue. */
function summary(p, { isSuper }) {
  const out = {
    paypointWallet: { balance: toNaira(p.poolKobo) },
    revenue: {
      balance: toNaira(p.adminRevenueKobo),
      earned: toNaira(p.adminEarnedKobo),
      withdrawn: toNaira(p.adminWithdrawnKobo),
      percent: config.adminRevenuePercent,
    },
  };
  if (isSuper) {
    out.superRevenue = { total: toNaira(p.superRevenueKobo), percent: config.superAdminRevenuePercent };
  }
  return out;
}

const KIND_TITLES = {
  topup: 'Paypoint wallet funded',
  correction: 'Correction',
  payment: 'Payment',
  refund: 'Refund',
  revenue: 'Revenue',
  withdrawal: 'Withdrawal',
  transfer: 'From revenue',
};

/** Ledger entries. Admins never see who funded the wallet or super revenue. */
async function ledger({ isSuper, wallet, limit = 50 }) {
  const allowed = isSuper ? ['pool', 'adminRevenue', 'superRevenue'] : ['pool', 'adminRevenue'];
  const wallets = wallet && allowed.includes(wallet) ? [wallet] : allowed;
  const rows = await Ledger.find({ wallet: { $in: wallets } })
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(Math.max(limit, 1), 200));
  let names = new Map();
  if (isSuper) {
    const ids = [...new Set(rows.filter((r) => r.by).map((r) => String(r.by)))];
    const users = await User.find({ _id: { $in: ids } }, { fullName: 1, email: 1 });
    names = new Map(users.map((u) => [String(u._id), u.fullName]));
  }
  return rows.map((r) => ({
    id: String(r._id),
    wallet: r.wallet,
    kind: r.kind,
    title: KIND_TITLES[r.kind] || r.kind,
    amount: toNaira(r.amountKobo),
    balanceAfter: toNaira(r.balanceAfterKobo),
    note: r.kind === 'topup' && !isSuper ? 'Paypoint wallet funded' : r.note,
    transactionId: r.transaction ? String(r.transaction) : null,
    ...(isSuper ? { by: r.by ? names.get(String(r.by)) || null : null } : {}),
    createdAt: r.createdAt,
  }));
}

module.exports = {
  extraViewNaira,
  setExtraViewNaira,
  settings,
  canCover,
  ensure,
  get,
  holdForPayment,
  releasePayment,
  creditRevenue,
  revenueFor,
  creditPool,
  debitPool,
  withdrawAdminRevenue,
  summary,
  ledger,
};
