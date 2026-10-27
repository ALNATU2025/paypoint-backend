const jwt = require('jsonwebtoken');
const { config } = require('./config');
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

function requireAdmin(req, res, next) {
  if (!config.adminApiKey) return next(new ApiError(404, 'Not found'));
  const key = req.get('x-admin-key') || '';
  if (key.length !== config.adminApiKey.length || key !== config.adminApiKey) {
    return next(new ApiError(401, 'Invalid admin key'));
  }
  next();
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

module.exports = { signToken, requireAuth, requireAdmin, notFound, errorHandler };
