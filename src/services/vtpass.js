// Thin client for the VTPass API (https://www.vtpass.com/documentation).
//
// Auth with API keys: POST sends `api-key` + `secret-key`. GET sends
// `api-key` + `public-key` when a public key is configured, otherwise
// `api-key` + `secret-key`.

const { config, vtpassConfigured } = require('../config');
const { ApiError } = require('../utils');

const CABLE_SERVICES = {
  dstv: { serviceID: 'dstv', name: 'DStv', supportsMonths: true },
  gotv: { serviceID: 'gotv', name: 'GOtv', supportsMonths: true },
  startimes: { serviceID: 'startimes', name: 'StarTimes', supportsMonths: false },
};

class VtpassNetworkError extends Error {}

function authHeaders(method) {
  const v = config.vtpass;
  if (method === 'GET' && v.publicKey) return { 'api-key': v.apiKey, 'public-key': v.publicKey };
  // POST always uses the secret key; GET falls back to it when no public key is set.
  return { 'api-key': v.apiKey, 'secret-key': v.secretKey };
}

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/**
 * VTPass returns due dates as "2025-02-06T00:00:00" (DStv) or "02-FEB-25"
 * (GOtv). Returns an ISO date string (YYYY-MM-DD) or null.
 */
function parseDueDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toUpperCase()] !== undefined) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(Date.UTC(year, MONTHS[m[2].toUpperCase()], Number(m[1])));
    return d.toISOString().slice(0, 10);
  }
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function ensureConfigured() {
  if (!vtpassConfigured()) throw new ApiError(503, 'Cable TV is temporarily unavailable. Please try again later.');
}

async function call(method, path, body) {
  ensureConfigured();
  const v = config.vtpass;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders(method) };

  let res;
  let text;
  try {
    res = await fetch(v.baseUrl + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(v.timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    throw new VtpassNetworkError(`VTPass unreachable: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new VtpassNetworkError(`VTPass returned non-JSON (HTTP ${res.status})`);
  }
}

// ---------------------------------------------------------------------------
// Packages (service variations), cached for 10 minutes per provider.
// ---------------------------------------------------------------------------

const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

async function getVariations(serviceID, { fresh = false } = {}) {
  const hit = cache.get(serviceID);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  let json;
  try {
    json = await call('GET', `/service-variations?serviceID=${encodeURIComponent(serviceID)}`);
  } catch (e) {
    if (hit) return hit.data; // serve stale rather than fail
    if (e instanceof VtpassNetworkError) throw new ApiError(502, 'Could not load packages. Please try again.');
    throw e;
  }
  const content = json && json.content;
  // VTPass has historically spelled this key both ways.
  const list = (content && (content.variations || content.varations)) || [];
  if (!Array.isArray(list) || list.length === 0) {
    if (hit) return hit.data;
    throw new ApiError(502, (json && json.response_description) || 'No packages returned by provider');
  }
  const data = list
    .map((x) => ({
      code: String(x.variation_code),
      name: String(x.name || x.variation_code).trim(),
      amount: Number(x.variation_amount),
      fixedPrice: String(x.fixedPrice || 'Yes').toLowerCase() === 'yes',
    }))
    .filter((x) => x.code && Number.isFinite(x.amount) && x.amount > 0)
    .sort((a, b) => a.amount - b.amount);
  cache.set(serviceID, { at: Date.now(), data });
  return data;
}

// ---------------------------------------------------------------------------
// Smartcard / IUC verification
// ---------------------------------------------------------------------------

async function verifyCustomer(serviceID, billersCode) {
  let json;
  try {
    json = await call('POST', '/merchant-verify', { billersCode, serviceID });
  } catch (e) {
    if (e instanceof VtpassNetworkError) throw new ApiError(502, 'Could not reach the provider. Please try again.');
    throw e;
  }
  const c = (json && json.content) || {};
  if (json.code !== '000' || c.error || c.WrongBillersCode === true || !c.Customer_Name) {
    throw new ApiError(422, c.error || json.response_description || 'Could not verify this number', {
      vtpassCode: json.code,
    });
  }
  const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  return {
    customerName: String(c.Customer_Name).trim(),
    status: c.Status || null,
    dueDate: parseDueDate(c.Due_Date),
    currentBouquet: c.Current_Bouquet || null,
    currentBouquetCode: c.Current_Bouquet_Code || null,
    renewalAmount: num(c.Renewal_Amount),
    customerNumber: c.Customer_Number || null,
    customerType: c.Customer_Type || null,
    balance: num(c.Balance),
  };
}

// ---------------------------------------------------------------------------
// Payment and requery
// ---------------------------------------------------------------------------

// Response codes where VTPass guarantees nothing was delivered.
// 011 invalid arguments, 012 product does not exist, 013 below minimum,
// 015 invalid request id, 016 transaction failed, 017 above maximum,
// 018 low merchant balance, 019 likely duplicate, 021 account locked,
// 022 account suspended, 024 account inactive, 028 product not whitelisted,
// 030 biller not reachable, 034 service suspended, 035 service inactive,
// 085/087 invalid credentials / request.
const DEFINITE_FAILURE_CODES = new Set([
  '011', '012', '013', '015', '016', '017', '018', '019', '021', '022', '024', '028', '030', '034', '035', '085', '087',
]);

/**
 * Map a VTPass pay/requery response to our status.
 *   success: delivered
 *   pending: still processing, or the outcome is unknown
 *   failed:  VTPass definitely did not complete it (safe to refund)
 */
function interpret(json) {
  const code = json && json.code;
  const tx = (json && json.content && json.content.transactions) || {};
  const txStatus = String(tx.status || '').toLowerCase();
  const message = (json && json.response_description) || '';
  let status;
  if (code === '000') {
    if (txStatus === 'delivered') status = 'success';
    else if (txStatus === 'failed' || txStatus === 'reversed') status = 'failed';
    else status = 'pending';
  } else if (DEFINITE_FAILURE_CODES.has(code)) {
    status = 'failed';
  } else {
    // 099 (processing), 083 (system error) and anything unrecognised:
    // the outcome is unknown, so hold the funds and requery.
    status = 'pending';
  }
  return {
    status,
    code: code || null,
    message,
    vtpassTransactionId: tx.transactionId ? String(tx.transactionId) : null,
  };
}

/**
 * Buy a subscription.
 *  - mode "change" (default): new / changed bouquet by variation_code. No
 *    amount is sent so VTPass charges the bouquet price (sending an amount
 *    would top up the decoder with exactly that amount). DStv/GOtv also send
 *    subscription_type "change" and quantity (months).
 *  - mode "renew" (DStv/GOtv): renew the current bouquet at the
 *    Renewal_Amount from merchant-verify; no variation_code.
 */
async function pay({ requestId, serviceID, billersCode, variationCode, amount, phone, months, mode = 'change' }) {
  const body = { request_id: requestId, serviceID, billersCode, phone };
  const tv = CABLE_SERVICES[serviceID];
  if (mode === 'renew') {
    body.subscription_type = 'renew';
    body.amount = amount;
  } else {
    body.variation_code = variationCode;
    if (tv && tv.supportsMonths) {
      body.subscription_type = 'change';
      body.quantity = months;
    }
  }
  try {
    return interpret(await call('POST', '/pay', body));
  } catch (e) {
    if (e instanceof VtpassNetworkError) {
      // Unknown outcome: keep money held and requery later.
      return { status: 'pending', code: null, message: 'Awaiting confirmation from provider', vtpassTransactionId: null };
    }
    throw e;
  }
}

async function requery(requestId) {
  try {
    return interpret(await call('POST', '/requery', { request_id: requestId }));
  } catch (e) {
    if (e instanceof VtpassNetworkError) {
      return { status: 'pending', code: null, message: 'Awaiting confirmation from provider', vtpassTransactionId: null };
    }
    throw e;
  }
}

/** Your VTPass wallet balance (naira), or null if VTPass doesn't return it. */
async function getBalance() {
  try {
    const json = await call('GET', '/balance');
    const c = (json && (json.contents || json.content)) || {};
    const n = Number(c.balance ?? c.Balance);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function clearCache() {
  cache.clear();
}

module.exports = {
  CABLE_SERVICES,
  getVariations,
  verifyCustomer,
  pay,
  requery,
  interpret,
  clearCache,
  authHeaders,
  parseDueDate,
  getBalance,
};
