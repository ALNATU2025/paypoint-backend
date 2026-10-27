// Central configuration, read once from environment variables.
// See .env.example for every variable and what it does.

const env = process.env;

const vtpassMode = (env.VTPASS_MODE || 'live').toLowerCase() === 'sandbox' ? 'sandbox' : 'live';

const config = {
  env: env.NODE_ENV || 'development',
  port: Number(env.PORT) || 4000,
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),

  mongoUri: env.MONGODB_URI || '',

  jwtSecret: env.JWT_SECRET || '',
  jwtExpiresIn: env.JWT_EXPIRES_IN || '30d',

  // Optional key that unlocks /api/admin routes (manual wallet credit).
  adminApiKey: env.ADMIN_API_KEY || '',

  // Flat fee added to each cable payment, in naira. 0 = no fee.
  serviceFeeNaira: Math.max(0, Number(env.SERVICE_FEE_NAIRA) || 0),

  vtpass: {
    mode: vtpassMode,
    baseUrl: (
      env.VTPASS_BASE_URL ||
      (vtpassMode === 'sandbox' ? 'https://sandbox.vtpass.com/api' : 'https://vtpass.com/api')
    ).replace(/\/+$/, ''),
    apiKey: env.VTPASS_API_KEY || '',
    publicKey: env.VTPASS_PUBLIC_KEY || '',
    secretKey: env.VTPASS_SECRET_KEY || '',
    // Alternative to API keys: Basic auth with your VTPass login.
    email: env.VTPASS_EMAIL || '',
    password: env.VTPASS_PASSWORD || '',
    timeoutMs: Number(env.VTPASS_TIMEOUT_MS) || 45000,
  },

  paystack: {
    baseUrl: (env.PAYSTACK_BASE_URL || 'https://api.paystack.co').replace(/\/+$/, ''),
    secretKey: env.PAYSTACK_SECRET_KEY || '',
    timeoutMs: 30000,
  },

  // Wallet funding limits, in naira.
  minFundNaira: Number(env.MIN_FUND_NAIRA) || 100,
  maxFundNaira: Number(env.MAX_FUND_NAIRA) || 500000,
};

config.isProduction = config.env === 'production';

/** Problems that stop the server from starting. */
function fatalConfigErrors() {
  const errors = [];
  if (!config.mongoUri) errors.push('MONGODB_URI is not set');
  if (!config.jwtSecret) errors.push('JWT_SECRET is not set');
  else if (config.isProduction && config.jwtSecret.length < 32) {
    errors.push('JWT_SECRET must be at least 32 characters in production');
  }
  return errors;
}

/** Problems that disable a feature but let the server run. */
function configWarnings() {
  const warnings = [];
  if (!vtpassConfigured()) {
    warnings.push(
      'VTPass credentials missing: set VTPASS_API_KEY + VTPASS_PUBLIC_KEY + VTPASS_SECRET_KEY, ' +
        'or VTPASS_EMAIL + VTPASS_PASSWORD. Cable TV is disabled.',
    );
  }
  if (!config.paystack.secretKey) warnings.push('PAYSTACK_SECRET_KEY missing: card/bank wallet funding is disabled');
  if (!config.publicUrl) warnings.push('PUBLIC_URL missing: Paystack will not redirect back after payment');
  return warnings;
}

const vtpassUsesKeys = () => Boolean(config.vtpass.apiKey && config.vtpass.publicKey && config.vtpass.secretKey);
const vtpassConfigured = () => vtpassUsesKeys() || Boolean(config.vtpass.email && config.vtpass.password);
const paystackConfigured = () => Boolean(config.paystack.secretKey);

module.exports = { config, fatalConfigErrors, configWarnings, vtpassConfigured, vtpassUsesKeys, paystackConfigured };
