const crypto = require('crypto');

/** Error with an HTTP status that the error handler turns into JSON. */
class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Wrap an async route so rejections reach the error handler. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const toKobo = (naira) => Math.round(Number(naira) * 100);
const toNaira = (kobo) => Math.round(Number(kobo)) / 100;

/**
 * Any phone number, any country, any length: keeps an optional leading "+"
 * and the digits, dropping spaces, dashes, dots and brackets.
 * "+234 (803) 123-4567" → "+2348031234567". Returns null if there are no digits.
 */
function normalizePhone(input) {
  const raw = String(input || '').trim();
  const plus = raw.startsWith('+') ? '+' : '';
  const digits = raw.replace(/\D/g, '');
  if (!digits || digits.length > 20) return null;
  return plus + digits;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const normalizeEmail = (v) => String(v || '').trim().toLowerCase();
const isEmail = (v) => EMAIL_RE.test(v);

/**
 * VTPass request_id: the first 12 characters must be the current date/time
 * in Africa/Lagos as YYYYMMDDHHmm, followed by any unique suffix.
 */
function vtpassRequestId(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const stamp = `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
  return stamp + crypto.randomBytes(6).toString('hex');
}

const randomRef = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`.toUpperCase();

const isPin = (v) => typeof v === 'string' && /^\d{4}$/.test(v);

function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) throw new ApiError(400, `Missing: ${missing.join(', ')}`);
}

module.exports = {
  ApiError,
  ah,
  toKobo,
  toNaira,
  normalizePhone,
  normalizeEmail,
  isEmail,
  vtpassRequestId,
  randomRef,
  isPin,
  requireFields,
};
