// End-to-end API tests against a real MongoDB (MONGODB_URI) with fake
// VTPass server. Run: MONGODB_URI=mongodb://localhost/paypoint_test npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// ---------------------------------------------------------------------------
// Fake VTPass
// ---------------------------------------------------------------------------

const SMARTCARD_OK = '1212121212';
const SMARTCARD_FAIL = '1111111111';
const SMARTCARD_PENDING = '2222222222';
const SMARTCARD_INVALID = '9999999999';
const SMARTCARD_WRONG_STARTIMES = '8888888888';

const fake = { pays: [], requeryResult: 'delivered' };

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b ? JSON.parse(b) : {}));
  });
}

const variations = {
  dstv: [
    { variation_code: 'dstv-padi', name: 'DStv Padi N4,400', variation_amount: '4400.00', fixedPrice: 'Yes' },
    { variation_code: 'dstv-compact', name: 'DStv Compact N19,000', variation_amount: '19000.00', fixedPrice: 'Yes' },
  ],
  gotv: [{ variation_code: 'gotv-max', name: 'GOtv Max N8,500', variation_amount: '8500.00', fixedPrice: 'Yes' }],
  startimes: [{ variation_code: 'classic', name: 'Classic - 5300 Naira', variation_amount: '5300.00', fixedPrice: 'Yes' }],
};

const fakeServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (obj, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const body = req.method === 'POST' ? await readBody(req) : {};

  // ---- VTPass ----
  if (url.pathname.startsWith('/vtpass/')) {
    const isGet = req.method === 'GET';
    const signedOk = isGet
      ? req.headers['public-key'] === 'pub' || req.headers['secret-key'] === 'sec'
      : req.headers['secret-key'] === 'sec';
    if (req.headers['api-key'] !== 'api' || !signedOk) {
      return send({ code: '087', response_description: 'INVALID CREDENTIALS' });
    }
    const path = url.pathname.slice('/vtpass'.length);
    if (path === '/service-variations') {
      const sid = url.searchParams.get('serviceID');
      // startimes uses the legacy misspelt key to prove we handle both
      const key = sid === 'startimes' ? 'varations' : 'variations';
      return send({ response_description: '000', content: { ServiceName: sid, serviceID: sid, [key]: variations[sid] || [] } });
    }
    if (path === '/merchant-verify') {
      if (body.billersCode === SMARTCARD_INVALID) {
        return send({ code: '000', content: { error: 'This is not a valid smartcard number' } });
      }
      if (body.serviceID === 'startimes') {
        // StarTimes shape: Balance + WrongBillersCode, no bouquet info.
        return send({
          code: '000',
          content: {
            Customer_Name: body.billersCode === SMARTCARD_WRONG_STARTIMES ? '' : 'TestMan Decoder',
            Balance: 54.82,
            Smartcard_Number: body.billersCode,
            WrongBillersCode: body.billersCode === SMARTCARD_WRONG_STARTIMES,
          },
        });
      }
      if (body.serviceID === 'gotv') {
        return send({ code: '000', content: { Customer_Name: 'GOTV CUSTOMER', Status: 'ACTIVE', Due_Date: '02-FEB-25' } });
      }
      return send({
        code: '000',
        content: {
          Customer_Name: 'TEST CUSTOMER',
          Status: 'ACTIVE',
          Due_Date: '2026-11-30T00:00:00',
          Customer_Number: 123456,
          Current_Bouquet: 'DStv Compact',
          Current_Bouquet_Code: 'dstv-compact',
          Renewal_Amount: 19000,
        },
      });
    }
    if (path === '/pay') {
      fake.pays.push(body);
      assert.match(body.request_id, /^\d{12}/, 'request_id starts with YYYYMMDDHHmm');
      if (body.billersCode === SMARTCARD_FAIL) return send({ code: '016', response_description: 'TRANSACTION FAILED' });
      if (body.billersCode === SMARTCARD_PENDING) {
        return send({ code: '099', response_description: 'TRANSACTION IS PROCESSING', content: { transactions: { status: 'pending' } } });
      }
      return send({
        code: '000',
        response_description: 'TRANSACTION SUCCESSFUL',
        requestId: body.request_id,
        content: { transactions: { status: 'delivered', transactionId: 'VT' + Date.now() } },
      });
    }
    if (path === '/requery') {
      return send({
        code: '000',
        response_description: 'TRANSACTION SUCCESSFUL',
        content: { transactions: { status: fake.requeryResult, transactionId: 'VTQ1' } },
      });
    }
    return send({ code: '404' }, 404);
  }

  send({ message: 'not found' }, 404);
});

// ---------------------------------------------------------------------------
// App under test
// ---------------------------------------------------------------------------

let mongoose;
let server;
let base;

before(async () => {
  await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
  const fakeBase = `http://127.0.0.1:${fakeServer.address().port}`;

  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/paypoint_test',
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    VTPASS_BASE_URL: `${fakeBase}/vtpass`,
    VTPASS_API_KEY: 'api',
    VTPASS_PUBLIC_KEY: 'pub',
    VTPASS_SECRET_KEY: 'sec',
    ADMIN_API_KEY: 'admin-key',
  });

  mongoose = require('mongoose');
  const { config } = require('../src/config');
  await mongoose.connect(config.mongoUri);
  await mongoose.connection.dropDatabase();
  const { createApp } = require('../src/app');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  server.close();
  fakeServer.close();
});

async function api(method, path, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { text };
  }
  return { status: res.status, body: json };
}

let token;
const PHONE = '+2348031234567';
const EMAIL = 'ada@example.com';

async function credit(amount) {
  const r = await api('POST', '/api/admin/wallet/credit', {
    headers: { 'x-admin-key': 'admin-key' },
    body: { email: EMAIL, amount },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data.balance;
}

// ---------------------------------------------------------------------------
// Tests (run in order)
// ---------------------------------------------------------------------------

test('health reports configuration', async () => {
  const r = await api('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.db, 'connected');
  assert.equal(r.body.vtpass.configured, true);
});

test('register validates and creates an account', async () => {
  let r = await api('POST', '/api/auth/register', { body: { fullName: 'Ada Okafor', phone: '123', password: 'secret1' } });
  assert.equal(r.status, 400, 'email is required');
  r = await api('POST', '/api/auth/register', {
    body: { fullName: 'Ada Okafor', email: 'not-an-email', phone: '123', password: 'secret1' },
  });
  assert.equal(r.status, 400);
  r = await api('POST', '/api/auth/register', {
    body: { fullName: 'Ada Okafor', email: EMAIL, phone: 'no digits', password: 'secret1' },
  });
  assert.equal(r.status, 400);

  r = await api('POST', '/api/auth/register', {
    body: { fullName: 'Ada Okafor', phone: '+234 803 123 4567', email: ' Ada@Example.com ', password: 'secret1' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.user.phone, PHONE);
  assert.equal(r.body.data.user.email, EMAIL);
  assert.equal(r.body.data.user.balance, 0);
  assert.equal(r.body.data.user.hasPin, false);
  token = r.body.data.token;

  r = await api('POST', '/api/auth/register', {
    body: { fullName: 'Ada Again', email: 'ADA@example.com', phone: '0800', password: 'secret1' },
  });
  assert.equal(r.status, 409, 'email must be unique');
});

test('phone numbers: any country, any length, and may be shared', async () => {
  for (const [phone, stored] of [
    ['+44 20 7946 0958', '+442079460958'],
    ['12', '12'],
    ['(555) 010-9999', '5550109999'],
    ['+1-202-555-0143', '+12025550143'],
  ]) {
    const r = await api('POST', '/api/auth/register', {
      body: { fullName: 'Phone Tester', email: `p${stored.replace('+', '')}@example.com`, phone, password: 'secret1' },
    });
    assert.equal(r.status, 201, `${phone}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.data.user.phone, stored);
  }
  const r = await api('POST', '/api/auth/register', {
    body: { fullName: 'Same Phone', email: 'samephone@example.com', phone: '12', password: 'secret1' },
  });
  assert.equal(r.status, 201, 'two accounts can share a phone number');
});

test('login with email and password', async () => {
  let r = await api('POST', '/api/auth/login', { body: { email: EMAIL, password: 'wrong' } });
  assert.equal(r.status, 401);
  assert.equal(r.body.message, 'Incorrect email or password');
  r = await api('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'secret1' } });
  assert.equal(r.status, 401);
  r = await api('POST', '/api/auth/login', { body: { phone: PHONE, password: 'secret1' } });
  assert.equal(r.status, 400, 'phone login is gone');
  r = await api('POST', '/api/auth/login', { body: { email: ' ADA@example.com ', password: 'secret1' } });
  assert.equal(r.status, 200);
  token = r.body.data.token;
  r = await api('GET', '/api/auth/me', { token });
  assert.equal(r.body.data.fullName, 'Ada Okafor');
  r = await api('GET', '/api/auth/me', { token: 'bad' });
  assert.equal(r.status, 401);
});

test('older phone-only accounts can still log in with their phone', async () => {
  const bcrypt = require('bcryptjs');
  const { User } = require('../src/models');
  await User.create({ fullName: 'Legacy User', phone: '08077776666', passwordHash: await bcrypt.hash('oldpass1', 10) });
  const r = await api('POST', '/api/auth/login', { body: { email: '08077776666', password: 'oldpass1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.user.fullName, 'Legacy User');
});

test('packages come from VTPass (both spellings) and are sorted', async () => {
  let r = await api('GET', '/api/cable/dstv/packages', { token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((p) => p.code), ['dstv-padi', 'dstv-compact']);
  assert.equal(r.body.data[1].amount, 19000);
  r = await api('GET', '/api/cable/startimes/packages', { token });
  assert.equal(r.body.data[0].code, 'classic');
  r = await api('GET', '/api/cable/netflix/packages', { token });
  assert.equal(r.status, 400);
});

test('verify smartcard', async () => {
  let r = await api('POST', '/api/cable/verify', { token, body: { serviceID: 'dstv', billersCode: SMARTCARD_OK } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.customerName, 'TEST CUSTOMER');
  assert.equal(r.body.data.renewalAmount, 19000);
  assert.equal(r.body.data.dueDate, '2026-11-30');
  r = await api('POST', '/api/cable/verify', { token, body: { serviceID: 'dstv', billersCode: SMARTCARD_INVALID } });
  assert.equal(r.status, 422);
  assert.match(r.body.message, /not a valid/);

  // GOtv returns dates like 02-FEB-25
  r = await api('POST', '/api/cable/verify', { token, body: { serviceID: 'gotv', billersCode: SMARTCARD_OK } });
  assert.equal(r.body.data.dueDate, '2025-02-02');

  // StarTimes flags bad numbers with WrongBillersCode
  r = await api('POST', '/api/cable/verify', { token, body: { serviceID: 'startimes', billersCode: SMARTCARD_OK } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.customerName, 'TestMan Decoder');
  assert.equal(r.body.data.balance, 54.82);
  r = await api('POST', '/api/cable/verify', { token, body: { serviceID: 'startimes', billersCode: SMARTCARD_WRONG_STARTIMES } });
  assert.equal(r.status, 422);
});

test('pay requires a PIN to be set', async () => {
  const r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_OK, variationCode: 'dstv-padi', pin: '1234' },
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'PIN_NOT_SET');
});

test('set and change PIN', async () => {
  let r = await api('PUT', '/api/auth/pin', { token, body: { pin: '12a4' } });
  assert.equal(r.status, 400);
  r = await api('PUT', '/api/auth/pin', { token, body: { pin: '1234' } });
  assert.equal(r.body.data.hasPin, true);
  r = await api('PUT', '/api/auth/pin', { token, body: { pin: '4321', currentPin: '0000' } });
  assert.equal(r.status, 401);
});

test('insufficient balance is rejected without calling VTPass', async () => {
  const before = fake.pays.length;
  const r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_OK, variationCode: 'dstv-padi', pin: '1234' },
  });
  assert.equal(r.status, 402);
  assert.equal(fake.pays.length, before);
});

test('successful payment debits the wallet with the VTPass price', async () => {
  assert.equal(await credit(50000), 50000);
  const r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_OK, variationCode: 'dstv-compact', months: 2, pin: '1234', amount: 1 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.transaction.status, 'success');
  assert.equal(r.body.data.transaction.amount, 38000); // client "amount: 1" ignored
  assert.equal(r.body.data.balance, 12000);
  const sent = fake.pays.at(-1);
  assert.equal(sent.subscription_type, 'change');
  assert.equal(sent.quantity, 2);
  assert.equal(sent.variation_code, 'dstv-compact');
  assert.equal(sent.amount, undefined, 'change must not send amount (VTPass would top up that exact amount)');
  assert.equal(sent.phone, PHONE);
});

test('StarTimes ignores months and sends no subscription_type', async () => {
  const r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'startimes', billersCode: SMARTCARD_OK, variationCode: 'classic', months: 3, pin: '1234' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.transaction.amount, 5300);
  assert.equal(fake.pays.at(-1).subscription_type, undefined);
  assert.equal(fake.pays.at(-1).amount, undefined);
  assert.equal(fake.pays.at(-1).variation_code, 'classic');
  assert.equal(r.body.data.balance, 6700);
});

test('failed payment is refunded', async () => {
  const r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_FAIL, variationCode: 'dstv-padi', pin: '1234' },
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.data.transaction.status, 'failed');
  assert.equal(r.body.data.transaction.refunded, true);
  assert.equal(r.body.data.balance, 6700);
});

test('pending payment holds funds, then requery settles it', async () => {
  let r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_PENDING, variationCode: 'dstv-padi', pin: '1234' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.transaction.status, 'pending');
  assert.equal(r.body.data.balance, 2300);
  const id = r.body.data.transaction.id;

  fake.requeryResult = 'delivered';
  r = await api('POST', `/api/cable/requery/${id}`, { token });
  assert.equal(r.body.data.transaction.status, 'success');
  assert.equal(r.body.data.balance, 2300);
});

test('pending payment that fails on requery is refunded exactly once', async () => {
  let r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_PENDING, variationCode: 'dstv-padi', pin: '1234' },
  });
  // Balance 2300 < 4400 so this must be rejected:
  assert.equal(r.status, 402);

  await credit(4400); // balance 6700
  r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_PENDING, variationCode: 'dstv-padi', pin: '1234' },
  });
  assert.equal(r.body.data.balance, 2300);
  const id = r.body.data.transaction.id;

  fake.requeryResult = 'failed';
  r = await api('POST', `/api/cable/requery/${id}`, { token });
  assert.equal(r.body.data.transaction.status, 'failed');
  assert.equal(r.body.data.balance, 6700);
  r = await api('POST', `/api/cable/requery/${id}`, { token });
  assert.equal(r.body.data.balance, 6700, 'no double refund');
});

test('wrong PIN locks after 5 attempts', async () => {
  for (let i = 1; i <= 4; i++) {
    const r = await api('POST', '/api/cable/pay', {
      token,
      body: { serviceID: 'dstv', billersCode: SMARTCARD_OK, variationCode: 'dstv-padi', pin: '0000' },
    });
    assert.equal(r.status, 401);
    assert.match(r.body.message, new RegExp(`${5 - i} attempt`));
  }
  let r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_OK, variationCode: 'dstv-padi', pin: '0000' },
  });
  assert.match(r.body.message, /15 minutes/);
  r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_OK, variationCode: 'dstv-padi', pin: '1234' },
  });
  assert.equal(r.status, 423);

  // Unlock for later tests.
  const { User } = require('../src/models');
  await User.updateOne({ phone: PHONE }, { pinLockedUntil: null, pinFailedAttempts: 0 });
});

test('renew uses the Renewal_Amount from VTPass, not a package', async () => {
  let r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'startimes', billersCode: SMARTCARD_OK, mode: 'renew', pin: '1234' },
  });
  assert.equal(r.status, 400);

  await credit(19000); // balance 25700
  r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_OK, mode: 'renew', pin: '1234', amount: 5 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.transaction.amount, 19000);
  assert.equal(r.body.data.transaction.packageName, 'DStv Compact (renewal)');
  assert.equal(r.body.data.transaction.customerName, 'TEST CUSTOMER');
  assert.equal(r.body.data.balance, 6700);
  const sent = fake.pays.at(-1);
  assert.equal(sent.subscription_type, 'renew');
  assert.equal(sent.amount, 19000);
  assert.equal(sent.variation_code, undefined);
  assert.equal(sent.quantity, undefined);
});

test('transactions list is scoped to the user', async () => {
  let r = await api('GET', '/api/transactions', { token });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length >= 6);
  assert.ok(r.body.data.every((t) => t.reference));
  r = await api('GET', '/api/transactions?type=cable', { token });
  assert.ok(r.body.data.every((t) => t.type === 'cable'));

  const other = await api('POST', '/api/auth/register', {
    body: { fullName: 'Other User', email: 'other@example.com', phone: '08099998888', password: 'secret1' },
  });
  r = await api('GET', '/api/transactions', { token: other.body.data.token });
  assert.equal(r.body.data.length, 0);
  const someone = (await api('GET', '/api/transactions', { token })).body.data[0].id;
  r = await api('GET', `/api/transactions/${someone}`, { token: other.body.data.token });
  assert.equal(r.status, 404);
});

test('admin credit by email; phone only when unambiguous', async () => {
  let r = await api('POST', '/api/admin/wallet/credit', {
    headers: { 'x-admin-key': 'admin-key' },
    body: { email: 'other@example.com', amount: 100 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.balance, 100);
  r = await api('POST', '/api/admin/wallet/credit', {
    headers: { 'x-admin-key': 'admin-key' },
    body: { phone: '12', amount: 100 },
  });
  assert.equal(r.status, 409, 'shared phone number is ambiguous');
});

test('admin routes need the key', async () => {
  const r = await api('POST', '/api/admin/wallet/credit', { body: { phone: PHONE, amount: 10 } });
  assert.equal(r.status, 401);
});

test('request ids start with Lagos time', () => {
  const { vtpassRequestId } = require('../src/utils');
  // 2026-10-27 08:05 UTC is 09:05 in Lagos (UTC+1)
  assert.match(vtpassRequestId(new Date('2026-10-27T08:05:00Z')), /^202610270905[0-9a-f]{12}$/);
});

test('VTPass auth: public key is optional', async () => {
  const { config } = require('../src/config');
  const { authHeaders, clearCache } = require('../src/services/vtpass');
  assert.deepEqual(authHeaders('GET'), { 'api-key': 'api', 'public-key': 'pub' });
  assert.deepEqual(authHeaders('POST'), { 'api-key': 'api', 'secret-key': 'sec' });

  const saved = config.vtpass.publicKey;
  config.vtpass.publicKey = '';
  try {
    assert.deepEqual(authHeaders('GET'), { 'api-key': 'api', 'secret-key': 'sec' });
    clearCache();
    const r = await api('GET', '/api/cable/gotv/packages', { token });
    assert.equal(r.status, 200, 'packages load with only api + secret key');
    const h = await api('GET', '/health');
    assert.equal(h.body.vtpass.configured, true);
  } finally {
    config.vtpass.publicKey = saved;
  }
});

test('health lists missing VTPass variables by name only', async () => {
  const { config } = require('../src/config');
  const saved = config.vtpass.secretKey;
  config.vtpass.secretKey = '';
  try {
    const r = await api('POST', '/api/cable/verify', { token, body: { serviceID: 'dstv', billersCode: SMARTCARD_OK } });
    assert.equal(r.status, 503);
  } finally {
    config.vtpass.secretKey = saved;
  }
  const h = await api('GET', '/health');
  assert.deepEqual(h.body.vtpass.missing, []);
  assert.equal(JSON.stringify(h.body).includes('sec'), false, 'never exposes key values');
});

test('config trims whitespace and quotes pasted into env vars', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(
    process.execPath,
    ['-e', "const {config,configWarnings}=require('./src/config');console.log(JSON.stringify([config.vtpass.apiKey,configWarnings()]))"],
    {
      env: { ...process.env, VTPASS_API_KEY: '  "abc"  ', VTPASS_PUBLIC_KEY: '', VTPASS_SECRET_KEY: '', VT_PASS_SECRET: 'x' },
    },
  ).toString();
  const [key, warnings] = JSON.parse(out);
  assert.equal(key, 'abc');
  assert.match(warnings[0], /missing VTPASS_SECRET_KEY\./, 'public key is not required');
  assert.match(warnings[0], /VT_PASS_SECRET/);
});
