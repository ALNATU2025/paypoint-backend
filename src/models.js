const mongoose = require('mongoose');
const { toNaira } = require('./utils');
const { isAdminEmail, isSuperAdminEmail } = require('./config');

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

const userSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 80 },
    // Email is the login. Older phone-only accounts have none (sparse index).
    email: { type: String, trim: true, lowercase: true, maxlength: 120, unique: true, sparse: true },
    // Any format, any country; not unique.
    phone: { type: String, required: true, index: true },
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
    // Super admins can open the admin dashboard too.
    isAdmin: isAdminEmail(this.email) || isSuperAdminEmail(this.email),
    isSuperAdmin: isSuperAdminEmail(this.email),
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
    // Held from the Paypoint wallet (pool) for this payment, returned on failure.
    poolKobo: { type: Number, default: 0 },
    // Revenue credited when the payment succeeded.
    adminRevenueKobo: { type: Number, default: 0 },
    superRevenueKobo: { type: Number, default: 0 },

    // Wallet funding
    // 'paystack' kept so older records stay valid.
    channel: { type: String, enum: ['admin', 'revenue', 'paystack', null], default: null },
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

// ---------------------------------------------------------------------------
// Platform wallets (one document, _id "main")
//   pool:          the "Paypoint wallet". Every cable payment is also held
//                  from here; when it is empty, no payment can go through.
//   adminRevenue:  admin's share of each payment, withdrawable.
//   superRevenue:  super admin's share, kept as a record.
// ---------------------------------------------------------------------------

const platformSchema = new mongoose.Schema(
  {
    _id: { type: String },
    poolKobo: { type: Number, default: 0 },
    adminRevenueKobo: { type: Number, default: 0 },
    adminEarnedKobo: { type: Number, default: 0 },
    adminWithdrawnKobo: { type: Number, default: 0 },
    superRevenueKobo: { type: Number, default: 0 },
    // DStv Extra View price set by the admin; null = EXTRA_VIEW_NAIRA default.
    extraViewKobo: { type: Number, default: null },
  },
  { timestamps: true },
);

const ledgerSchema = new mongoose.Schema(
  {
    wallet: { type: String, enum: ['pool', 'adminRevenue', 'superRevenue'], required: true, index: true },
    // topup / correction: super admin funding; payment / refund: cable payments;
    // revenue: share of a payment; withdrawal: admin moving revenue out;
    // transfer: revenue moved into the Paypoint wallet.
    kind: {
      type: String,
      enum: ['topup', 'correction', 'payment', 'refund', 'revenue', 'withdrawal', 'transfer'],
      required: true,
    },
    amountKobo: { type: Number, required: true }, // signed: + in, - out
    balanceAfterKobo: { type: Number, required: true },
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '' },
  },
  { timestamps: true },
);
ledgerSchema.index({ createdAt: -1 });

const User = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Platform = mongoose.model('Platform', platformSchema);
const Ledger = mongoose.model('Ledger', ledgerSchema);

module.exports = { User, Transaction, Platform, Ledger };
