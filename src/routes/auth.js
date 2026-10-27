const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { User } = require('../models');
const { signToken, requireAuth } = require('../middleware');
const { ApiError, ah, normalizePhone, isPin, requireFields } = require('../utils');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { success: false, message: 'Too many attempts. Please wait a few minutes and try again.' },
});

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// POST /api/auth/register { fullName, phone, email?, password }
router.post(
  '/register',
  limiter,
  ah(async (req, res) => {
    const body = req.body || {};
    requireFields(body, ['fullName', 'phone', 'password']);
    const fullName = String(body.fullName).trim();
    const phone = normalizePhone(body.phone);
    const email = body.email ? String(body.email).trim().toLowerCase() : '';
    const password = String(body.password);

    if (fullName.length < 3) throw new ApiError(400, 'Enter your full name');
    if (!phone) throw new ApiError(400, 'Enter a valid Nigerian phone number');
    if (email && !EMAIL_RE.test(email)) throw new ApiError(400, 'Enter a valid email address');
    if (password.length < 6) throw new ApiError(400, 'Password must be at least 6 characters');

    if (await User.exists({ phone })) throw new ApiError(409, 'An account with this phone number already exists');

    const user = await User.create({
      fullName,
      phone,
      email: email || undefined,
      passwordHash: await bcrypt.hash(password, 10),
    });
    res.status(201).json({ success: true, data: { token: signToken(user), user: user.toPublic() } });
  }),
);

// POST /api/auth/login { phone, password }
router.post(
  '/login',
  limiter,
  ah(async (req, res) => {
    const body = req.body || {};
    requireFields(body, ['phone', 'password']);
    const phone = normalizePhone(body.phone);
    const user = phone ? await User.findOne({ phone }) : null;
    const ok = user ? await bcrypt.compare(String(body.password), user.passwordHash) : false;
    if (!ok) throw new ApiError(401, 'Incorrect phone number or password');
    res.json({ success: true, data: { token: signToken(user), user: user.toPublic() } });
  }),
);

// GET /api/auth/me
router.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    res.json({ success: true, data: req.user.toPublic() });
  }),
);

// PUT /api/auth/pin { pin, currentPin? } — set a transaction PIN, or change it.
router.put(
  '/pin',
  requireAuth,
  ah(async (req, res) => {
    const { pin, currentPin } = req.body || {};
    if (!isPin(pin)) throw new ApiError(400, 'PIN must be exactly 4 digits');
    const user = req.user;
    if (user.pinHash) {
      if (!isPin(currentPin) || !(await bcrypt.compare(currentPin, user.pinHash))) {
        throw new ApiError(401, 'Your current PIN is incorrect');
      }
    }
    user.pinHash = await bcrypt.hash(pin, 10);
    user.pinFailedAttempts = 0;
    user.pinLockedUntil = null;
    await user.save();
    res.json({ success: true, data: user.toPublic() });
  }),
);

module.exports = router;
