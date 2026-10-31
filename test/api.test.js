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

const fake = { pays: [], requeryResult: 'delivered', failAmount: null };

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
    // Extra View bundles are hidden from the app.
    { variation_code: 'dstv-compact-extra', name: 'DStv Compact + Extra View N25,000', variation_amount: '25000.00', fixedPrice: 'Yes' },
    { variation_code: 'dstv-xtraview', name: 'XtraView Access', variation_amount: '6000.00', fixedPrice: 'Yes' },
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
      if (fake.failAmount !== null && body.amount === fake.failAmount) {
        return send({ code: '016', response_description: 'TRANSACTION FAILED' });
      }
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
let adminToken;
let superToken;
const SUPER_EMAIL = 'alusinebarrie578@gmail.com';
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

test('an empty Paypoint wallet blocks payments even when the user has money', async () => {
  assert.equal(await credit(4400), 4400);
  const before = fake.pays.length;
  let r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_OK, variationCode: 'dstv-padi', pin: '1234' },
  });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, 'SERVICE_UNAVAILABLE');
  assert.equal(fake.pays.length, before, 'VTPass is never called');
  r = await api('GET', '/api/auth/me', { token });
  assert.equal(r.body.data.balance, 4400, 'user balance untouched');
  r = await api('POST', '/api/admin/wallet/debit', {
    headers: { 'x-admin-key': 'admin-key' },
    body: { email: EMAIL, amount: 4400 },
  });
  assert.equal(r.status, 200);
});

test('super admin funds the Paypoint wallet', async () => {
  let r = await api('POST', '/api/auth/register', {
    body: { fullName: 'Super Admin', email: SUPER_EMAIL, phone: '0700', password: 'superpass1' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.user.isSuperAdmin, true);
  assert.equal(r.body.data.user.isAdmin, true);
  superToken = r.body.data.token;

  r = await api('POST', '/api/super/pool/credit', { token, body: { amount: 1000 } });
  assert.equal(r.status, 403, 'normal users cannot fund it');
  r = await api('POST', '/api/super/pool/credit', { headers: { 'x-admin-key': 'admin-key' }, body: { amount: 1000 } });
  assert.equal(r.status, 401, 'the API key cannot fund it');
  r = await api('POST', '/api/super/pool/credit', { token: superToken, body: { amount: 0 } });
  assert.equal(r.status, 400);

  r = await api('POST', '/api/super/pool/credit', { token: superToken, body: { amount: 1000000, note: 'Opening float' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.paypointWallet.balance, 1000000);
  assert.equal(r.body.data.ledger[0].kind, 'topup');
  assert.equal(r.body.data.ledger[0].by, 'Super Admin');

  r = await api('POST', '/api/super/pool/debit', { token: superToken, body: { amount: 2000000 } });
  assert.equal(r.status, 400, 'cannot go below zero');
  r = await api('GET', '/api/auth/me', { token });
  assert.equal(r.body.data.isSuperAdmin, false);
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

test('admin dashboard: payonpointng@gmail.com is admin, others are not', async () => {
  let r = await api('POST', '/api/auth/register', {
    body: { fullName: 'Paypoint Admin', email: 'PayOnPointNG@gmail.com', phone: '0800', password: 'adminpass1' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.user.isAdmin, true);
  assert.equal(r.body.data.user.isSuperAdmin, false);
  adminToken = r.body.data.token;

  r = await api('GET', '/api/auth/me', { token });
  assert.equal(r.body.data.isAdmin, false);
  r = await api('GET', '/api/admin/stats', { token });
  assert.equal(r.status, 403, 'normal users are refused');

  // Overview
  r = await api('GET', '/api/admin/stats', { token: adminToken });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.data.users >= 3);
  assert.ok(r.body.data.salesAll.count >= 3);
  assert.ok(r.body.data.byProvider.dstv.amount > 0);
  assert.equal(r.body.data.vtpass.configured, true);

  // Users: search and detail
  r = await api('GET', '/api/admin/users?q=ada', { token: adminToken });
  const ada = r.body.data.find((u) => u.email === EMAIL);
  assert.ok(ada, 'search finds Ada');
  r = await api('GET', `/api/admin/users/${ada.id}`, { token: adminToken });
  assert.equal(r.body.data.user.fullName, 'Ada Okafor');
  assert.ok(r.body.data.transactions.length > 3);

  // Credit and debit by user id
  const before = ada.balance;
  r = await api('POST', '/api/admin/wallet/credit', { token: adminToken, body: { userId: ada.id, amount: 1000 } });
  assert.equal(r.body.data.balance, before + 1000);
  r = await api('POST', '/api/admin/wallet/debit', { token: adminToken, body: { userId: ada.id, amount: 99999999 } });
  assert.equal(r.status, 400);
  r = await api('POST', '/api/admin/wallet/debit', { token: adminToken, body: { userId: ada.id, amount: 1000, note: 'test' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.balance, before);
  r = await api('POST', '/api/admin/wallet/credit', { token, body: { userId: ada.id, amount: 1000 } });
  assert.equal(r.status, 403, 'normal users cannot credit');

  // All transactions with owner names; requery any user's pending payment
  r = await api('GET', '/api/admin/transactions?type=cable&status=success', { token: adminToken });
  assert.ok(r.body.data.length > 0);
  assert.ok(r.body.data.every((t) => t.type === 'cable' && t.status === 'success' && t.userName));

  fake.requeryResult = 'delivered';
  r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_PENDING, variationCode: 'dstv-padi', pin: '1234' },
  });
  assert.equal(r.body.data.transaction.status, 'pending', JSON.stringify(r.body));
  const pendingId = r.body.data.transaction.id;
  r = await api('GET', '/api/admin/transactions?status=pending', { token: adminToken });
  assert.ok(r.body.data.some((t) => t.id === pendingId));
  r = await api('POST', `/api/admin/transactions/${pendingId}/requery`, { token: adminToken });
  assert.equal(r.body.data.status, 'success');
  assert.equal(r.body.data.userName, 'Ada Okafor');

  // Unlock a PIN lockout
  const { User } = require('../src/models');
  await User.updateOne({ email: EMAIL }, { pinLockedUntil: new Date(Date.now() + 600000) });
  r = await api('GET', `/api/admin/users/${ada.id}`, { token: adminToken });
  assert.equal(r.body.data.user.pinLocked, true);
  r = await api('POST', `/api/admin/users/${ada.id}/unlock-pin`, { token: adminToken });
  assert.equal(r.body.data.pinLocked, false);
});

async function wallets(t = superToken) {
  const r = await api('GET', '/api/admin/wallets', { token: t });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data;
}

async function pay(t, billersCode, variationCode = 'dstv-padi') {
  return api('POST', '/api/cable/pay', { token: t, body: { serviceID: 'dstv', billersCode, variationCode, pin: '1234' } });
}

test('payments use the Paypoint wallet and pay revenue once, on success', async () => {
  await credit(20000);
  let w = await wallets();
  // Every successful payment so far paid 1.3% / 0.5% of its bouquet amount.
  const { Transaction } = require('../src/models');
  const ok = await Transaction.find({ type: 'cable', status: 'success' });
  const base = ok.reduce((n, t) => n + t.amountKobo - t.feeKobo, 0);
  assert.equal(w.revenue.earned, Math.round(ok.reduce((n, t) => n + Math.round((t.amountKobo - t.feeKobo) * 0.013), 0)) / 100);
  assert.equal(w.superRevenue.total, ok.reduce((n, t) => n + Math.round((t.amountKobo - t.feeKobo) * 0.005), 0) / 100);
  assert.equal(w.revenue.percent, 1.3);
  assert.equal(w.superRevenue.percent, 0.5);
  assert.ok(base > 0);

  // Success: pool -4400, admin +57.20, super +22
  let r = await pay(token, SMARTCARD_OK);
  assert.equal(r.status, 200);
  let w2 = await wallets();
  assert.equal(w2.paypointWallet.balance, w.paypointWallet.balance - 4400);
  assert.equal(Math.round((w2.revenue.balance - w.revenue.balance) * 100), 5720);
  assert.equal(Math.round((w2.superRevenue.total - w.superRevenue.total) * 100), 2200);

  // Failure: the hold comes back and no revenue is paid
  w = w2;
  r = await pay(token, SMARTCARD_FAIL);
  assert.equal(r.status, 422);
  w2 = await wallets();
  assert.equal(w2.paypointWallet.balance, w.paypointWallet.balance);
  assert.equal(w2.revenue.balance, w.revenue.balance);
  assert.deepEqual(w2.ledger.slice(0, 2).map((e) => e.kind), ['refund', 'payment']);

  // Pending: held, no revenue until it settles
  fake.requeryResult = 'delivered';
  r = await pay(token, SMARTCARD_PENDING);
  assert.equal(r.body.data.transaction.status, 'pending');
  w2 = await wallets();
  assert.equal(w2.paypointWallet.balance, w.paypointWallet.balance - 4400);
  assert.equal(w2.revenue.balance, w.revenue.balance);
  const id = r.body.data.transaction.id;
  await api('POST', `/api/cable/requery/${id}`, { token });
  await api('POST', `/api/cable/requery/${id}`, { token });
  const w3 = await wallets();
  assert.equal(Math.round((w3.revenue.balance - w2.revenue.balance) * 100), 5720, 'revenue paid exactly once');
});

test('admin withdraws revenue to the Paypoint wallet or their own wallet', async () => {
  const w = await wallets(adminToken);
  assert.ok(w.revenue.balance > 30, JSON.stringify(w.revenue));
  assert.equal(w.superRevenue, undefined, 'admins do not see super admin revenue');

  let r = await api('POST', '/api/admin/revenue/withdraw', { token: adminToken, body: { amount: 20, to: 'pool' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.paypointWallet.balance, w.paypointWallet.balance + 20);
  assert.equal(r.body.data.revenue.balance, Math.round((w.revenue.balance - 20) * 100) / 100);

  const me = (await api('GET', '/api/auth/me', { token: adminToken })).body.data;
  r = await api('POST', '/api/admin/revenue/withdraw', { token: adminToken, body: { amount: 10, to: 'main' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.balance, me.balance + 10);
  assert.equal(r.body.data.transaction.channel, 'revenue');
  assert.equal(r.body.data.revenue.withdrawn, 30);

  r = await api('POST', '/api/admin/revenue/withdraw', { token: adminToken, body: { amount: 99999999, to: 'pool' } });
  assert.equal(r.status, 400, 'cannot withdraw more than the balance');
  r = await api('POST', '/api/admin/revenue/withdraw', { token: adminToken, body: { amount: 1, to: 'bank' } });
  assert.equal(r.status, 400);
  r = await api('POST', '/api/admin/revenue/withdraw', { token: superToken, body: { amount: 1, to: 'pool' } });
  assert.equal(r.status, 403, 'super admin revenue is a record only');
  r = await api('POST', '/api/admin/revenue/withdraw', { token, body: { amount: 1, to: 'main' } });
  assert.equal(r.status, 403);
});

test('the super admin is hidden from the admin', async () => {
  // Super admin buys something with their own wallet.
  let r = await api('POST', '/api/admin/wallet/credit', { token: superToken, body: { email: SUPER_EMAIL, amount: 5000 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await api('PUT', '/api/auth/pin', { token: superToken, body: { pin: '1234' } });
  r = await pay(superToken, SMARTCARD_OK);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const superTxId = r.body.data.transaction.id;
  const superId = (await api('GET', '/api/auth/me', { token: superToken })).body.data.id;

  // Admin sees none of it.
  r = await api('GET', '/api/admin/users?q=alusine', { token: adminToken });
  assert.deepEqual(r.body.data, []);
  r = await api('GET', '/api/admin/users?limit=200', { token: adminToken });
  assert.ok(!r.body.data.some((u) => u.email === SUPER_EMAIL));
  r = await api('GET', `/api/admin/users/${superId}`, { token: adminToken });
  assert.equal(r.status, 404);
  r = await api('POST', '/api/admin/wallet/credit', { token: adminToken, body: { email: SUPER_EMAIL, amount: 1 } });
  assert.equal(r.status, 404);
  r = await api('POST', `/api/admin/users/${superId}/unlock-pin`, { token: adminToken });
  assert.equal(r.status, 404);
  r = await api('GET', '/api/admin/transactions?limit=200', { token: adminToken });
  assert.ok(!r.body.data.some((t) => t.id === superTxId));
  r = await api('POST', `/api/admin/transactions/${superTxId}/requery`, { token: adminToken });
  assert.equal(r.status, 404);
  const adminStats = (await api('GET', '/api/admin/stats', { token: adminToken })).body.data;
  assert.equal(adminStats.isSuper, false);
  assert.equal(adminStats.vtpass.balance, null, 'admins see the Paypoint wallet, not VTPass');
  assert.equal(adminStats.superRevenue, undefined);
  assert.ok(adminStats.paypointWallet.balance > 0);
  const ledger = (await wallets(adminToken)).ledger;
  assert.ok(ledger.every((e) => e.by === undefined && e.wallet !== 'superRevenue'));
  assert.ok(ledger.filter((e) => e.kind === 'topup').every((e) => e.note === 'Paypoint wallet funded'));

  // Super admin sees everything.
  const superStats = (await api('GET', '/api/admin/stats', { token: superToken })).body.data;
  assert.equal(superStats.isSuper, true);
  assert.equal(superStats.users, adminStats.users + 1);
  assert.equal(superStats.salesAll.count, adminStats.salesAll.count + 1);
  assert.ok(superStats.superRevenue.total > 0);
  r = await api('GET', '/api/admin/transactions?limit=200', { token: superToken });
  assert.ok(r.body.data.some((t) => t.id === superTxId));
  r = await api('GET', `/api/admin/users/${superId}`, { token: superToken });
  assert.equal(r.status, 200);
  r = await api('GET', '/api/admin/wallets?wallet=superRevenue', { token: superToken });
  assert.ok(r.body.data.ledger.length > 0 && r.body.data.ledger.every((e) => e.wallet === 'superRevenue'));
});

test('DStv packages: Extra View bundles hidden, custom amount and Extra View offered', async () => {
  let r = await api('GET', '/api/cable/dstv/packages', { token });
  assert.ok(!r.body.data.some((p) => /view/i.test(p.name)), JSON.stringify(r.body.data));
  assert.deepEqual(r.body.customAmount, { min: 100, max: 500000 });
  assert.equal(r.body.extraView.amount, 6000);
  r = await api('GET', '/api/cable/gotv/packages', { token });
  assert.equal(r.body.customAmount, null);
  assert.equal(r.body.extraView, null);
});

test('admin sets the Extra View price', async () => {
  let r = await api('PUT', '/api/admin/settings', { token, body: { extraViewAmount: 6500 } });
  assert.equal(r.status, 403);
  r = await api('PUT', '/api/admin/settings', { token: adminToken, body: { extraViewAmount: 5 } });
  assert.equal(r.status, 400);
  r = await api('PUT', '/api/admin/settings', { token: adminToken, body: { extraViewAmount: 6500 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.extraViewAmount, 6500);
  r = await api('GET', '/api/admin/stats', { token: adminToken });
  assert.equal(r.body.data.settings.extraViewAmount, 6500);
  r = await api('GET', '/api/cable/dstv/packages', { token });
  assert.equal(r.body.extraView.amount, 6500);
});

async function balanceOf(t) {
  return (await api('GET', '/api/auth/me', { token: t })).body.data.balance;
}

test('DStv: pay any amount', async () => {
  await credit(30000);
  const before = await balanceOf(token);
  let r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_OK, mode: 'amount', amount: 50, pin: '1234' },
  });
  assert.equal(r.status, 400, 'below the minimum');
  r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'gotv', billersCode: SMARTCARD_OK, mode: 'amount', amount: 2500, pin: '1234' },
  });
  assert.equal(r.status, 400, 'DStv only');

  r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_OK, mode: 'amount', amount: 2500.5, pin: '1234' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.transaction.amount, 2500.5);
  assert.equal(r.body.data.transaction.packageName, 'Custom amount');
  assert.equal(r.body.data.balance, before - 2500.5);
  const sent = fake.pays.at(-1);
  assert.equal(sent.subscription_type, 'renew');
  assert.equal(sent.amount, 2500.5, 'exactly the amount the user chose');
  assert.equal(sent.variation_code, undefined);
});

test('DStv Extra View is a second payment of exactly its price', async () => {
  let before = await balanceOf(token);
  const pays = fake.pays.length;
  let r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_OK, variationCode: 'dstv-padi', extraView: true, pin: '1234' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(fake.pays.length, pays + 2);
  assert.equal(fake.pays.at(-2).variation_code, 'dstv-padi');
  assert.equal(fake.pays.at(-1).amount, 6500);
  assert.equal(fake.pays.at(-1).subscription_type, 'renew');
  assert.equal(r.body.data.extraViewTransaction.amount, 6500);
  assert.equal(r.body.data.extraViewTransaction.packageName, 'Extra View');
  assert.equal(r.body.data.extraViewTransaction.status, 'success');
  assert.equal(r.body.data.balance, before - 4400 - 6500);
  assert.match(r.body.message, /Extra View paid/);

  // Renew + Extra View
  before = r.body.data.balance;
  await credit(20000);
  r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_OK, mode: 'renew', extraView: true, pin: '1234' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.balance, before + 20000 - 19000 - 6500);

  // Extra View fails at VTPass: only it is refunded.
  before = r.body.data.balance;
  fake.failAmount = 6500;
  r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_OK, variationCode: 'dstv-padi', extraView: true, pin: '1234' },
  });
  fake.failAmount = null;
  assert.equal(r.status, 200);
  assert.equal(r.body.data.transaction.status, 'success');
  assert.equal(r.body.data.extraViewTransaction.status, 'failed');
  assert.equal(r.body.data.balance, before - 4400);
  assert.match(r.body.message, /Extra View could not be paid/);

  // Not enough for both: nothing is charged.
  const { User } = require('../src/models');
  await User.updateOne({ email: EMAIL }, { balanceKobo: 500000 }); // ₦5,000: covers Padi, not Padi + Extra View
  const n = fake.pays.length;
  r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'dstv', billersCode: SMARTCARD_OK, variationCode: 'dstv-padi', extraView: true, pin: '1234' },
  });
  assert.equal(r.status, 402);
  assert.equal(fake.pays.length, n);
  assert.equal(await balanceOf(token), 5000);

  r = await api('POST', '/api/cable/pay', {
    token,
    body: { serviceID: 'startimes', billersCode: SMARTCARD_OK, variationCode: 'classic', extraView: true, pin: '1234' },
  });
  assert.equal(r.status, 400, 'Extra View is DStv only');
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
