const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const { config, vtpassConfigured, paystackConfigured } = require('./config');
const { notFound, errorHandler } = require('./middleware');
const authRoutes = require('./routes/auth');
const cableRoutes = require('./routes/cable');
const { router: walletRoutes } = require('./routes/wallet');
const { transactions, webhooks, admin } = require('./routes/misc');

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render sits behind a proxy
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(
    express.json({
      limit: '100kb',
      // Keep the raw bytes for webhook signature verification.
      verify: (req, res, buf) => {
        if (req.originalUrl.startsWith('/api/webhooks/')) req.rawBody = buf;
      },
    }),
  );

  app.get('/', (req, res) => res.json({ name: 'Paypoint API', status: 'ok' }));
  app.get('/health', (req, res) =>
    res.json({
      ok: true,
      db: ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] || 'unknown',
      vtpass: { mode: config.vtpass.mode, configured: vtpassConfigured() },
      paystack: { configured: paystackConfigured() },
      time: new Date().toISOString(),
    }),
  );

  app.use('/api/auth', authRoutes);
  app.use('/api/cable', cableRoutes);
  app.use('/api/wallet', walletRoutes);
  app.use('/api/transactions', transactions);
  app.use('/api/webhooks', webhooks);
  app.use('/api/admin', admin);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
