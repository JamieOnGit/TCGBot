// Accounts: sign up, log in/out, sessions, cross-site protection, password
// reset, password change, account deletion and data export.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client, PASSWORD, startApp } from './helpers.js';
import { STARTER_PRODUCTS } from '../server/presets.js';

let env;
before(async () => { env = await startApp({ adminEmails: 'boss@example.com', trialDays: 7 }); });
after(async () => { await env.close(); });

test('sign up starts a trial, signs you in and gives you your own starter list', async () => {
  const c = new Client(env.url);
  const r = await c.post('/api/auth/signup', { email: 'Ash@Example.com', password: PASSWORD, name: 'Ash', acceptTerms: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.email, 'ash@example.com', 'emails are stored lower-case');
  const cookie = r.headers.getSetCookie()[0];
  assert.match(cookie, /^tcb_session=[\w-]{40,};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.entitlement.active, true);
  assert.equal(me.body.entitlement.plan, 'trial');
  assert.match(me.body.entitlement.label, /7 days left/);
  const products = (await c.get('/api/products')).body.products;
  assert.deepEqual(products.map((p) => p.sku), STARTER_PRODUCTS.map((p) => p.sku));
  assert.equal(products[0].store, 'Kmart');
});

test('sign-up checks: terms, weak password, bad email, duplicate account', async () => {
  const c = new Client(env.url);
  assert.equal((await c.post('/api/auth/signup', { email: 'x@example.com', password: PASSWORD })).status, 400, 'must accept terms');
  assert.equal((await c.post('/api/auth/signup', { email: 'x@example.com', password: 'short', acceptTerms: true })).status, 400);
  assert.equal((await c.post('/api/auth/signup', { email: 'not-an-email', password: PASSWORD, acceptTerms: true })).status, 400);
  const dup = await c.post('/api/auth/signup', { email: 'ASH@example.com', password: PASSWORD, acceptTerms: true });
  assert.equal(dup.status, 409);
});

test('log in, wrong password, log out', async () => {
  const c = new Client(env.url);
  assert.equal((await c.get('/api/me')).status, 401);
  const bad = await c.post('/api/auth/login', { email: 'ash@example.com', password: 'wrong password!' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'Wrong email or password');
  const unknown = await c.post('/api/auth/login', { email: 'nobody@example.com', password: PASSWORD });
  assert.equal(unknown.body.error, 'Wrong email or password', 'same message whether or not the account exists');
  assert.equal((await c.post('/api/auth/login', { email: 'ASH@example.com', password: PASSWORD })).status, 200);
  assert.equal((await c.get('/api/me')).status, 200);
  const stolen = c.cookie;
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/me')).status, 401);
  const replay = new Client(env.url);
  replay.cookie = stolen;
  assert.equal((await replay.get('/api/me')).status, 401, 'a logged-out session is gone from the server');
});

test('sign-ups per network are limited', async () => {
  const limited = await startApp({ signupsPerHour: 2 });
  try {
    await Client.signup(limited.url, 'one@example.com');
    await Client.signup(limited.url, 'two@example.com');
    const r = await new Client(limited.url).post('/api/auth/signup', { email: 'three@example.com', password: PASSWORD, acceptTerms: true });
    assert.equal(r.status, 429);
  } finally {
    await limited.close();
  }
});

test('too many wrong passwords locks the email for a while', async () => {
  const c = await Client.signup(env.url, 'brock@example.com');
  const other = new Client(env.url);
  for (let i = 0; i < 10; i++) await other.post('/api/auth/login', { email: 'brock@example.com', password: `guess-${i}-xxxxx` });
  const r = await other.post('/api/auth/login', { email: 'brock@example.com', password: PASSWORD });
  assert.equal(r.status, 429);
  assert.equal((await c.get('/api/me')).status, 200, 'existing sessions keep working');
});

test('cross-site requests are refused (missing header or foreign Origin)', async () => {
  const c = await Client.signup(env.url, 'misty@example.com');
  const noHeader = await c.post('/api/products', { url: 'https://www.kmart.com.au/product/x-43000001/' }, { 'x-tcgcopbot': '' });
  assert.equal(noHeader.status, 403);
  const evil = await c.post('/api/products', { url: 'https://www.kmart.com.au/product/x-43000001/' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const ok = await c.post('/api/products', { url: 'https://www.kmart.com.au/product/x-43000001/' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sku, '43000001');
});

test('pages: dashboard needs a login; security headers are set', async () => {
  const anon = new Client(env.url);
  const r = await anon.get('/app');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login?next=%2Fapp');
  const home = await anon.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /TCGCopBot/);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  const c = await Client.signup(env.url, 'gary@example.com');
  assert.equal((await c.get('/app')).status, 200);
  assert.equal((await c.get('/login')).status, 302, 'logged-in users skip the login page');
  assert.equal((await c.get('/admin')).status, 302, 'non-admins are sent back to the dashboard');
  assert.equal((await c.get('/api/admin/users')).status, 404, 'admin API is invisible to non-admins');
  assert.equal((await anon.get('/download/extension.zip')).status, 302, 'extension download needs an account');
  assert.equal((await anon.get('/api/products')).status, 401);
  assert.equal((await anon.get('/api/nope')).status, 404);
});

test('forgot password → email link → new password; old sessions and devices are signed out', async () => {
  const c = await Client.signup(env.url, 'erika@example.com');
  const { body } = await c.post('/api/devices/pair-code');
  await fetch(`${env.url}/api/ext/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: body.code }) });
  assert.equal((await c.get('/api/devices')).body.devices.length, 1);

  const anon = new Client(env.url);
  const r = await anon.post('/api/auth/forgot', { email: 'erika@example.com' });
  assert.equal(r.status, 200);
  const unknown = await anon.post('/api/auth/forgot', { email: 'nobody@example.com' });
  assert.deepEqual(unknown.body, r.body, 'same answer for unknown emails');
  const mail = env.outbox.find((m) => m.to === 'erika@example.com');
  assert.ok(mail, 'reset email sent');
  const token = mail.text.match(/reset\?token=([\w-]+)/)[1];

  assert.equal((await anon.post('/api/auth/reset', { token, password: 'short' })).status, 400);
  const reset = await anon.post('/api/auth/reset', { token, password: 'a brand new password' });
  assert.equal(reset.status, 200);
  assert.equal((await anon.get('/api/me')).status, 200, 'signed in after resetting');
  assert.equal((await anon.post('/api/auth/reset', { token, password: 'another new password' })).status, 400, 'links work once');
  assert.equal((await c.get('/api/me')).status, 401, 'other sessions signed out');
  assert.equal((await anon.get('/api/devices')).body.devices.length, 0, 'extensions disconnected');
  assert.equal((await new Client(env.url).post('/api/auth/login', { email: 'erika@example.com', password: 'a brand new password' })).status, 200);
});

test('change password keeps this session and signs out the others', async () => {
  const c = await Client.signup(env.url, 'sabrina@example.com');
  const other = new Client(env.url);
  await other.post('/api/auth/login', { email: 'sabrina@example.com', password: PASSWORD });
  assert.equal((await c.post('/api/me/password', { current: 'wrong', next: 'new password 123' })).status, 400);
  assert.equal((await c.post('/api/me/password', { current: PASSWORD, next: 'new password 123' })).status, 200);
  assert.equal((await c.get('/api/me')).status, 200);
  assert.equal((await other.get('/api/me')).status, 401);
});

test('admin emails become admins; export and delete your own account', async () => {
  const boss = await Client.signup(env.url, 'boss@example.com');
  assert.equal(boss.user.role, 'admin');
  assert.equal((await boss.get('/admin')).status, 200);

  const c = await Client.signup(env.url, 'koga@example.com');
  await c.put('/api/profile', { firstName: 'Koga', address1: '1 Fuchsia St', suburb: 'Fuchsia', state: 'NSW', postcode: '2000' });
  const exp = await c.get('/api/me/export');
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition'), /attachment/);
  const data = JSON.parse(exp.text);
  assert.equal(data.account.email, 'koga@example.com');
  assert.equal(data.deliveryDetails.firstName, 'Koga');
  assert.equal(data.quickCheckout.length, STARTER_PRODUCTS.length);

  const id = c.user.id;
  assert.equal((await c.post('/api/me/delete', { password: 'wrong' })).status, 400);
  assert.equal((await c.post('/api/me/delete', { password: PASSWORD })).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
  const db = env.app.db;
  for (const table of ['users', 'sessions', 'products', 'user_data', 'events', 'watch_items', 'devices']) {
    const col = table === 'users' ? 'id' : 'user_id';
    assert.equal(db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = :id`, { id }).n, 0, `${table} emptied`);
  }
  assert.equal((await new Client(env.url).post('/api/auth/login', { email: 'koga@example.com', password: PASSWORD })).status, 401);
});

/** A request with our own Host header (fetch can't set it). */
function raw(method, path, headers, body) {
  const u = new URL(env.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('opened at another address for this server (localhost vs 127.0.0.1): sign-up works and the page says which address to use', async () => {
  const port = new URL(env.url).port;
  const other = `localhost:${port}`;
  const body = JSON.stringify({ email: 'other-host@example.com', password: PASSWORD, acceptTerms: true });
  const ok = await raw('POST', '/api/auth/signup', { host: other, origin: `http://${other}`, 'x-tcgcopbot': '1', 'content-type': 'application/json' }, body);
  assert.equal(ok.status, 200, ok.text);
  const evil = await raw('POST', '/api/auth/signup', { host: other, origin: 'http://evil.example', 'x-tcgcopbot': '1', 'content-type': 'application/json' }, body);
  assert.equal(evil.status, 403, 'other websites are still blocked');

  const page = await raw('GET', '/signup?x=1', { host: other });
  assert.match(page.text, /class="host-warning"/);
  assert.ok(page.text.includes(`href="${env.url}/signup?x=1"`), 'links to the configured address');
  const normal = await raw('GET', '/signup', { host: new URL(env.url).host });
  assert.doesNotMatch(normal.text, /class="host-warning"/);
});
