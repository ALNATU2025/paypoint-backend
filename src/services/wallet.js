// All balance changes go through here. Each one is a single atomic MongoDB
// update, so concurrent requests can never overdraw a wallet or credit twice.

const { User, Transaction } = require('../models');
const { ApiError } = require('../utils');
const platform = require('./platform');

/** Debit if (and only if) the balance covers it. Throws 402 otherwise. */
async function debit(userId, amountKobo) {
  const updated = await User.findOneAndUpdate(
    { _id: userId, balanceKobo: { $gte: amountKobo } },
    { $inc: { balanceKobo: -amountKobo } },
    { new: true },
  );
  if (!updated) throw new ApiError(402, 'Insufficient wallet balance. Please fund your wallet.');
  return updated;
}

/**
 * Move a pending cable transaction to its final state, exactly once:
 *  - failed:  refund the user and return the hold to the Paypoint wallet
 *  - success: credit the admin and super admin Revenue wallets
 * Returns the up-to-date transaction.
 */
async function settleCable(tx, result) {
  const update = {
    vtpassCode: result.code,
    vtpassMessage: result.message,
  };
  if (result.vtpassTransactionId) update.vtpassTransactionId = result.vtpassTransactionId;

  if (result.status === 'pending') {
    return (await Transaction.findByIdAndUpdate(tx._id, update, { new: true })) || tx;
  }

  // Only a pending transaction can be settled; this guards against double refunds.
  const settled = await Transaction.findOneAndUpdate(
    { _id: tx._id, status: 'pending' },
    { ...update, status: result.status, ...(result.status === 'failed' ? { refunded: true } : {}) },
    { new: true },
  );
  if (!settled) return Transaction.findById(tx._id);

  if (result.status === 'failed') {
    await User.updateOne({ _id: settled.user }, { $inc: { balanceKobo: settled.amountKobo } });
    await platform.releasePayment(settled);
    return settled;
  }
  const share = await platform.creditRevenue(settled);
  settled.adminRevenueKobo = share.admin;
  settled.superRevenueKobo = share.super;
  return settled;
}

module.exports = { debit, settleCable };
