const mongoose = require('mongoose');
const { toNaira } = require('./utils');

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

const userSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, unique: true, index: true },
    email: { type: String, trim: true, lowercase: true, maxlength: 120 },
    passwordHash: { type: String, required: true },
    pinHash: { type: String, default: null },
    pinFailedAttempts: { type: Number, default: 0 },
    pinLockedUntil: { type: Date, default: null },
    // Wallet balance in kobo (integer). Only ever changed with atomic $inc.
    balanceKobo: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    fullName: this.fullName,
    phone: this.phone,
    email: this.email || '',
    balance: toNaira(this.balanceKobo),
    hasPin: Boolean(this.pinHash),
    createdAt: this.createdAt,
  };
};

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

const transactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['cable', 'funding'], required: true },
    status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending', index: true },
    amountKobo: { type: Number, required: true, min: 0 },
    feeKobo: { type: Number, default: 0 },
    description: { type: String, default: '' },

    // Cable TV
    serviceID: String, // dstv | gotv | startimes
    billersCode: String, // smartcard / IUC number
    customerName: String,
    variationCode: String,
    packageName: String,
    months: { type: Number, default: 1 },
    phone: String,
    requestId: { type: String, unique: true, sparse: true },
    vtpassTransactionId: String,
    vtpassCode: String,
    vtpassMessage: String,
    refunded: { type: Boolean, default: false },

    // Wallet funding
    channel: { type: String, enum: ['paystack', 'admin', null], default: null },
    reference: { type: String, unique: true, sparse: true },
  },
  { timestamps: true },
);

transactionSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    type: this.type,
    status: this.status,
    amount: toNaira(this.amountKobo),
    fee: toNaira(this.feeKobo),
    description: this.description,
    serviceID: this.serviceID || null,
    billersCode: this.billersCode || null,
    customerName: this.customerName || null,
    variationCode: this.variationCode || null,
    packageName: this.packageName || null,
    months: this.months || 1,
    phone: this.phone || null,
    reference: this.requestId || this.reference || this._id.toString(),
    vtpassTransactionId: this.vtpassTransactionId || null,
    message: this.vtpassMessage || null,
    refunded: this.refunded,
    channel: this.channel || null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

const User = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = { User, Transaction };
