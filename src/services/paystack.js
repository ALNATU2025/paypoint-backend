// Paystack client for wallet funding (https://paystack.com/docs/api/transaction).

const crypto = require('crypto');
const { config, paystackConfigured } = require('../config');
const { ApiError } = require('../utils');

async function call(method, path, body) {
  if (!paystackConfigured()) throw new ApiError(503, 'Card and bank funding is not configured yet');
  let res;
  let json;
  try {
    res = await fetch(config.paystack.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${config.paystack.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.paystack.timeoutMs),
    });
    json = await res.json();
  } catch (e) {
    throw new ApiError(502, 'Could not reach Paystack. Please try again.');
  }
  if (!res.ok || !json.status) {
    throw new ApiError(502, json && json.message ? `Paystack: ${json.message}` : 'Paystack request failed');
  }
  return json.data;
}

/** Start a checkout. Amount is in kobo. */
function initialize({ email, amountKobo, reference, metadata }) {
  const body = { email, amount: amountKobo, reference, currency: 'NGN', metadata };
  if (config.publicUrl) body.callback_url = `${config.publicUrl}/api/wallet/fund/callback`;
  return call('POST', '/transaction/initialize', body);
}

function verify(reference) {
  return call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
}

/** Paystack signs webhooks with HMAC-SHA512 of the raw body using the secret key. */
function isValidSignature(rawBody, signature) {
  if (!paystackConfigured() || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha512', config.paystack.secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { initialize, verify, isValidSignature };
