// All balance changes go through here. Each one is a single atomic MongoDB
// update, so concurrent requests can never overdraw a wallet or credit twice.

const { User, Transaction } = require('../models');
const { ApiError } = require('../utils');

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
 * Move a pending cable transaction to its final state. Refunds exactly once
 * when it fails. Returns the up-to-date transaction.
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
  }
  return settled;
}

/** Credit a pending funding transaction exactly once. */
async function completeFunding(reference) {
  const tx = await Transaction.findOneAndUpdate(
    { reference, type: 'funding', status: 'pending' },
    { status: 'success' },
    { new: true },
  );
  if (!tx) return { credited: false, tx: await Transaction.findOne({ reference }) };
  await User.updateOne({ _id: tx.user }, { $inc: { balanceKobo: tx.amountKobo } });
  return { credited: true, tx };
}

async function failFunding(reference, message) {
  return Transaction.findOneAndUpdate(
    { reference, type: 'funding', status: 'pending' },
    { status: 'failed', vtpassMessage: message || 'Payment not completed' },
    { new: true },
  );
}

module.exports = { debit, settleCable, completeFunding, failFunding };
