const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { User } = require('../models');
const { signToken, requireAuth } = require('../middleware');
const { ApiError, ah, normalizePhone, normalizeEmail, isEmail, isPin, requireFields } = require('../utils');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { success: false, message: 'Too many attempts. Please wait a few minutes and try again.' },
});

// POST /api/auth/register { fullName, email, phone, password }
router.post(
  '/register',
  limiter,
  ah(async (req, res) => {
    const body = req.body || {};
    requireFields(body, ['fullName', 'email', 'phone', 'password']);
    const fullName = String(body.fullName).trim();
    const email = normalizeEmail(body.email);
    const phone = normalizePhone(body.phone);
    const password = String(body.password);

    if (fullName.length < 3) throw new ApiError(400, 'Enter your full name');
    if (!isEmail(email)) throw new ApiError(400, 'Enter a valid email address');
    if (!phone) throw new ApiError(400, 'Enter your phone number');
    if (password.length < 6) throw new ApiError(400, 'Password must be at least 6 characters');

    if (await User.exists({ email })) throw new ApiError(409, 'An account with this email already exists. Log in instead.');

    const user = await User.create({
      fullName,
      email,
      phone,
      passwordHash: await bcrypt.hash(password, 10),
    });
    res.status(201).json({ success: true, data: { token: signToken(user), user: user.toPublic() } });
  }),
);

// POST /api/auth/login { email, password }
// (Accounts created before email login can still use their phone number in `email`.)
router.post(
  '/login',
  limiter,
  ah(async (req, res) => {
    const body = req.body || {};
    requireFields(body, ['email', 'password']);
    const id = String(body.email).trim();
    let user = null;
    if (id.includes('@')) {
      user = await User.findOne({ email: normalizeEmail(id) });
    } else {
      const phone = normalizePhone(id);
      user = phone ? await User.findOne({ phone, email: { $in: [null, ''] } }) : null;
    }
    const ok = user ? await bcrypt.compare(String(body.password), user.passwordHash) : false;
    if (!ok) throw new ApiError(401, 'Incorrect email or password');
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
