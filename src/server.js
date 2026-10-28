const mongoose = require('mongoose');
const { config, fatalConfigErrors, configWarnings } = require('./config');
const { createApp } = require('./app');

async function main() {
  const errors = fatalConfigErrors();
  if (errors.length) {
    console.error(`[config] Cannot start:\n  - ${errors.join('\n  - ')}`);
    process.exit(1);
  }
  for (const w of configWarnings()) console.warn(`[config] ${w}`);

  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15000 });
  console.log('[db] connected');
  try {
    // Apply index changes (email unique for login, phone no longer unique).
    await require('./models').User.syncIndexes();
  } catch (e) {
    console.error('[db] index sync failed:', e.message);
  }

  await require('./services/platform').ensure();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[api] Paypoint API on port ${config.port} (VTPass ${config.vtpass.mode})`);
  });

  const shutdown = async () => {
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
