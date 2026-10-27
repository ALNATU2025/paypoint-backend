// Central configuration, read once from environment variables.
// See .env.example for every variable and what it does.

const env = process.env;

/** Read an env var, trimming whitespace and stray quotes from copy-paste. */
const read = (name) => String(env[name] || '').trim().replace(/^["']|["']$/g, '').trim();

const vtpassMode = read('VTPASS_MODE').toLowerCase() === 'sandbox' ? 'sandbox' : 'live';

const config = {
  env: env.NODE_ENV || 'development',
  port: Number(env.PORT) || 4000,

  mongoUri: read('MONGODB_URI'),

  jwtSecret: read('JWT_SECRET'),
  jwtExpiresIn: read('JWT_EXPIRES_IN') || '30d',

  // Optional key that unlocks /api/admin routes (manual wallet credit).
  adminApiKey: read('ADMIN_API_KEY'),

  // Flat fee added to each cable payment, in naira. 0 = no fee.
  serviceFeeNaira: Math.max(0, Number(read('SERVICE_FEE_NAIRA')) || 0),

  vtpass: {
    mode: vtpassMode,
    baseUrl: (
      read('VTPASS_BASE_URL') ||
      (vtpassMode === 'sandbox' ? 'https://sandbox.vtpass.com/api' : 'https://vtpass.com/api')
    ).replace(/\/+$/, ''),
    apiKey: read('VTPASS_API_KEY'),
    publicKey: read('VTPASS_PUBLIC_KEY'),
    secretKey: read('VTPASS_SECRET_KEY'),
    timeoutMs: Number(read('VTPASS_TIMEOUT_MS')) || 45000,
  },
};

config.isProduction = config.env === 'production';

// Required. VTPASS_PUBLIC_KEY is optional: without it, GET requests are
// signed with the secret key instead.
const VTPASS_VARS = ['VTPASS_API_KEY', 'VTPASS_SECRET_KEY'];

/** Names of VTPass variables that are missing or empty. */
const missingVtpassVars = () => VTPASS_VARS.filter((n) => !read(n));

const vtpassConfigured = () => Boolean(config.vtpass.apiKey && config.vtpass.secretKey);

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
  const missing = missingVtpassVars();
  if (missing.length) {
    // Help spot typos: show VTPass-like variable names that ARE set (names only, never values).
    const similar = Object.keys(env).filter(
      (k) => /vt.?pass|api.?key|secret.?key/i.test(k) && !VTPASS_VARS.includes(k) && k !== 'VTPASS_PUBLIC_KEY',
    );
    warnings.push(
      `Cable TV is disabled: missing ${missing.join(', ')}.` +
        (similar.length ? ` Found similar variables: ${similar.join(', ')} (check the names).` : ''),
    );
  }
  return warnings;
}

module.exports = { config, fatalConfigErrors, configWarnings, vtpassConfigured, missingVtpassVars };
