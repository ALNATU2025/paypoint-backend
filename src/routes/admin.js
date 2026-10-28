// Admin API. Access: logged in with an ADMIN_EMAILS / SUPER_ADMIN_EMAILS
// account, or x-admin-key. Super admin accounts (and everything they do) are
// left out of every list and total unless the caller is a super admin.

const express = require('express');
const mongoose = require('mongoose');
const { config, vtpassConfigured, isSuperAdminEmail } = require('../config');
const { Transaction, User } = require('../models');
const { requireAdmin } = require('../middleware');
const vtpass = require('../services/vtpass');
const wallet = require('../services/wallet');
const platform = require('../services/platform');
const { ApiError, ah, toKobo, toNaira, normalizePhone, normalizeEmail, isEmail, randomRef } = require('../utils');

const router = express.Router();
router.use(requireAdmin);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function startOfTodayLagos() {
  // Lagos is UTC+1 all year.
  const now = new Date(Date.now() + 60 * 60 * 1000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 60 * 60 * 1000);
}

/** Filter that hides super admin accounts from admins. */
const visibleUsers = (req) => (req.isSuper ? {} : { email: { $nin: config.superAdminEmails } });

/** Ids of super admin accounts, hidden from admins (empty for super admins). */
async function hiddenUserIds(req) {
  if (req.isSuper) return [];
  return User.find({ email: { $in: config.superAdminEmails } }).distinct('_id');
}

const isHidden = (req, user) => !req.isSuper && isSuperAdminEmail(user.email);

// VTPass balance, cached briefly because the dashboard refreshes every few seconds.
let providerBalance = { at: 0, value: null };
async function cachedProviderBalance() {
  if (!vtpassConfigured()) return null;
  if (Date.now() - providerBalance.at > 30000) {
    providerBalance = { at: Date.now(), value: await vtpass.getBalance() };
  }
  return providerBalance.value;
}

/** Admin view of a user (adds counts that normal users don't see). */
const adminUser = (u) => ({ ...u.toPublic(), pinLocked: Boolean(u.pinLockedUntil && u.pinLockedUntil > new Date()) });

/** Transaction plus the owner's name/email, for admin lists. */
async function withOwners(list) {
  const ids = [...new Set(list.map((t) => String(t.user)))];
  const users = await User.find({ _id: { $in: ids } }, { fullName: 1, email: 1, phone: 1 });
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return list.map((t) => {
    const u = byId.get(String(t.user));
    return {
      ...t.toPublic(),
      userId: String(t.user),
      userName: u ? u.fullName : 'Deleted user',
      userEmail: u ? u.email || u.phone : '',
    };
  });
}

async function findTargetUser(body) {
  if (body.userId) {
    if (!mongoose.isValidObjectId(body.userId)) throw new ApiError(400, 'Invalid user');
    return { _id: body.userId };
  }
  if (body.email) {
    const email = normalizeEmail(body.email);
    if (!isEmail(email)) throw new ApiError(400, 'Enter a valid email address');
    return { email };
  }
  const phone = normalizePhone(body.phone);
  if (!phone) throw new ApiError(400, "Send the user's id, email or phone");
  if ((await User.countDocuments({ phone })) > 1) {
    throw new ApiError(409, 'Several accounts use that phone number. Use their email instead.');
  }
  return { phone };
}

function parseAmount(v) {
  const amount = Number(v);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 5000000) throw new ApiError(400, 'Enter a valid amount');
  return amount;
}

// GET /api/admin/stats — dashboard overview
router.get(
  '/stats',
  ah(async (req, res) => {
    const today = startOfTodayLagos();
    const userFilter = visibleUsers(req);
    const hidden = await hiddenUserIds(req);
    const notHidden = { user: { $nin: hidden } };
    const sumCable = async (match) => {
      const [r] = await Transaction.aggregate([
        { $match: { type: 'cable', status: 'success', ...notHidden, ...match } },
        { $group: { _id: null, amount: { $sum: '$amountKobo' }, count: { $sum: 1 } } },
      ]);
      return { amount: toNaira(r ? r.amount : 0), count: r ? r.count : 0 };
    };
    const [users, newUsersToday, [walletSum], salesToday, salesAll, pending, failedToday, byProvider, vtpassBalance, p] =
      await Promise.all([
        User.countDocuments(userFilter),
        User.countDocuments({ ...userFilter, createdAt: { $gte: today } }),
        User.aggregate([{ $match: userFilter }, { $group: { _id: null, total: { $sum: '$balanceKobo' } } }]),
        sumCable({ createdAt: { $gte: today } }),
        sumCable({}),
        Transaction.countDocuments({ type: 'cable', status: 'pending', ...notHidden }),
        Transaction.countDocuments({ type: 'cable', status: 'failed', ...notHidden, createdAt: { $gte: today } }),
        Transaction.aggregate([
          { $match: { type: 'cable', status: 'success', ...notHidden } },
          { $group: { _id: '$serviceID', amount: { $sum: '$amountKobo' }, count: { $sum: 1 } } },
        ]),
        // The VTPass balance is for super admins; admins see the Paypoint wallet.
        req.isSuper ? cachedProviderBalance() : Promise.resolve(null),
        platform.get(),
      ]);
    res.json({
      success: true,
      data: {
        users,
        newUsersToday,
        walletBalances: toNaira(walletSum ? walletSum.total : 0),
        salesToday,
        salesAll,
        pending,
        failedToday,
        byProvider: Object.fromEntries(byProvider.map((p) => [p._id, { amount: toNaira(p.amount), count: p.count }])),
        vtpass: { mode: config.vtpass.mode, configured: vtpassConfigured(), balance: vtpassBalance },
        ...platform.summary(p, { isSuper: Boolean(req.isSuper) }),
        isSuper: Boolean(req.isSuper),
        serverTime: new Date().toISOString(),
      },
    });
  }),
);

// GET /api/admin/users?q=&limit=
router.get(
  '/users',
  ah(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const search = q
      ? {
          $or: [
            { fullName: { $regex: escapeRegex(q), $options: 'i' } },
            { email: { $regex: escapeRegex(q), $options: 'i' } },
            { phone: { $regex: escapeRegex(q.replace(/[\s()-]/g, '')) } },
          ],
        }
      : {};
    const users = await User.find({ $and: [search, visibleUsers(req)] }).sort({ createdAt: -1 }).limit(limit);
    res.json({ success: true, data: users.map(adminUser) });
  }),
);

// GET /api/admin/users/:id — profile + recent transactions
router.get(
  '/users/:id',
  ah(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'User not found');
    const user = await User.findById(req.params.id);
    if (!user || isHidden(req, user)) throw new ApiError(404, 'User not found');
    const txs = await Transaction.find({ user: user._id }).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, data: { user: adminUser(user), transactions: txs.map((t) => t.toPublic()) } });
  }),
);

// POST /api/admin/users/:id/unlock-pin — clear a PIN lockout
router.post(
  '/users/:id/unlock-pin',
  ah(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'User not found');
    const user = await User.findOneAndUpdate(
      { $and: [{ _id: req.params.id }, visibleUsers(req)] },
      { pinFailedAttempts: 0, pinLockedUntil: null },
      { new: true },
    );
    if (!user) throw new ApiError(404, 'User not found');
    res.json({ success: true, data: adminUser(user) });
  }),
);

// POST /api/admin/wallet/credit { userId | email | phone, amount, note? }
router.post(
  '/wallet/credit',
  ah(async (req, res) => {
    const body = req.body || {};
    const amount = parseAmount(body.amount);
    const filter = await findTargetUser(body);
    const amountKobo = toKobo(amount);
    const user = await User.findOneAndUpdate(
      { $and: [filter, visibleUsers(req)] },
      { $inc: { balanceKobo: amountKobo } },
      { new: true },
    );
    if (!user) throw new ApiError(404, 'No account found');
    const tx = await Transaction.create({
      user: user._id,
      type: 'funding',
      status: 'success',
      amountKobo,
      channel: 'admin',
      reference: randomRef('PPA'),
      description: String(body.note || 'Wallet credit').slice(0, 120),
    });
    res.json({ success: true, data: { balance: toNaira(user.balanceKobo), user: adminUser(user), transaction: tx.toPublic() } });
  }),
);

// POST /api/admin/wallet/debit { userId | email | phone, amount, note? } — corrections
router.post(
  '/wallet/debit',
  ah(async (req, res) => {
    const body = req.body || {};
    const amount = parseAmount(body.amount);
    const filter = await findTargetUser(body);
    const amountKobo = toKobo(amount);
    const exists = await User.findOne({ $and: [filter, visibleUsers(req)] });
    if (!exists) throw new ApiError(404, 'No account found');
    const user = await User.findOneAndUpdate(
      { _id: exists._id, balanceKobo: { $gte: amountKobo } },
      { $inc: { balanceKobo: -amountKobo } },
      { new: true },
    );
    if (!user) throw new ApiError(400, `Balance is only ₦${toNaira(exists.balanceKobo).toLocaleString()}`);
    const tx = await Transaction.create({
      user: user._id,
      type: 'funding',
      status: 'success',
      amountKobo,
      channel: 'admin',
      reference: randomRef('PPD'),
      description: `Debit: ${String(body.note || 'Wallet correction').slice(0, 110)}`,
    });
    res.json({ success: true, data: { balance: toNaira(user.balanceKobo), user: adminUser(user), transaction: tx.toPublic() } });
  }),
);

// GET /api/admin/transactions?status=&type=&limit=
router.get(
  '/transactions',
  ah(async (req, res) => {
    const q = {};
    if (['pending', 'success', 'failed'].includes(req.query.status)) q.status = req.query.status;
    if (['cable', 'funding'].includes(req.query.type)) q.type = req.query.type;
    const hidden = await hiddenUserIds(req);
    if (hidden.length) q.user = { $nin: hidden };
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const list = await Transaction.find(q).sort({ createdAt: -1 }).limit(limit);
    res.json({ success: true, data: await withOwners(list) });
  }),
);

// POST /api/admin/transactions/:id/requery — settle any user's pending payment
router.post(
  '/transactions/:id/requery',
  ah(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'Transaction not found');
    let tx = await Transaction.findOne({ _id: req.params.id, type: 'cable' });
    if (!tx || (await hiddenUserIds(req)).some((id) => String(id) === String(tx.user))) {
      throw new ApiError(404, 'Transaction not found');
    }
    if (tx.status === 'pending') tx = await wallet.settleCable(tx, await vtpass.requery(tx.requestId));
    const [row] = await withOwners([tx]);
    res.json({ success: true, data: row });
  }),
);

// ---------------------------------------------------------------------------
// Paypoint wallet and Revenue wallet
// ---------------------------------------------------------------------------

// GET /api/admin/wallets?wallet=pool|adminRevenue[|superRevenue]&limit=
router.get(
  '/wallets',
  ah(async (req, res) => {
    const p = await platform.get();
    const limit = parseInt(req.query.limit, 10) || 50;
    res.json({
      success: true,
      data: {
        ...platform.summary(p, { isSuper: Boolean(req.isSuper) }),
        ledger: await platform.ledger({ isSuper: Boolean(req.isSuper), wallet: req.query.wallet, limit }),
      },
    });
  }),
);

// POST /api/admin/revenue/withdraw { amount, to: "pool" | "main" }
//   pool: into the Paypoint wallet; main: into the admin's own app wallet.
router.post(
  '/revenue/withdraw',
  ah(async (req, res) => {
    if (req.isSuper) throw new ApiError(403, 'Super admin revenue is kept as a record and cannot be withdrawn');
    const body = req.body || {};
    const amountKobo = toKobo(parseAmount(body.amount));
    const out = await platform.withdrawAdminRevenue(amountKobo, String(body.to || ''), req.user || null);
    const p = await platform.get();
    res.json({
      success: true,
      message: out.to === 'pool' ? 'Moved to Paypoint wallet' : 'Moved to your wallet',
      data: {
        ...platform.summary(p, { isSuper: false }),
        ...(out.user ? { balance: toNaira(out.user.balanceKobo), transaction: out.transaction.toPublic() } : {}),
      },
    });
  }),
);

module.exports = router;
