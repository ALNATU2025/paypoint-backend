const jwt = require('jsonwebtoken');
const { config, isAdminEmail, isSuperAdminEmail } = require('./config');
const { User } = require('./models');
const { ApiError } = require('./utils');

function signToken(user) {
  return jwt.sign({ sub: user._id.toString() }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

/** Requires `Authorization: Bearer <token>`; sets req.user. */
async function requireAuth(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new ApiError(401, 'Please log in');
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      throw new ApiError(401, 'Your session has expired. Please log in again.');
    }
    const user = await User.findById(payload.sub);
    if (!user) throw new ApiError(401, 'Account not found. Please log in again.');
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Admin access, either:
 *  - logged in (Bearer token) with an email in ADMIN_EMAILS or SUPER_ADMIN_EMAILS, or
 *  - header x-admin-key matching ADMIN_API_KEY (for scripts / curl).
 * Sets req.isSuper for super admins (they see everything; admins don't see them).
 */
async function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key');
  if (key !== undefined) {
    if (!config.adminApiKey || key.length !== config.adminApiKey.length || key !== config.adminApiKey) {
      return next(new ApiError(401, 'Invalid admin key'));
    }
    return next();
  }
  return requireAuth(req, res, (err) => {
    if (err) return next(err);
    req.isSuper = isSuperAdminEmail(req.user.email);
    if (!req.isSuper && !isAdminEmail(req.user.email)) return next(new ApiError(403, 'Admins only'));
    next();
  });
}

/** Logged in as a super admin (no API key access). */
function requireSuperAdmin(req, res, next) {
  return requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (!isSuperAdminEmail(req.user.email)) return next(new ApiError(403, 'Not allowed'));
    req.isSuper = true;
    next();
  });
}

function notFound(req, res) {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.path}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Invalid JSON body' });
  }
  if (err && err.code === 11000) {
    return res.status(409).json({ success: false, message: 'That record already exists' });
  }
  if (err && err.name === 'CastError') {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  console.error('[error]', err);
  res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
}

module.exports = { signToken, requireAuth, requireAdmin, requireSuperAdmin, notFound, errorHandler };
