// Every person's data belongs to their login only: products, delivery
// details, watchlist, alert settings, activity, connected browsers and
// ⚡ Buy codes. Two users try to reach each other's data in every way the
// API allows, and must fail.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, startApp } from './helpers.js';

let env;
let ash;
let misty;
before(async () => {
  env = await startApp();
  ash = await Client.signup(env.url, 'ash@example.com');
  misty = await Client.signup(env.url, 'misty@example.com');
});
after(async () => { await env.close(); });

const ASH_PROFILE = { firstName: 'Ash', lastName: 'Ketchum', email: 'ash.checkout@example.com', phone: '0400000001', address1: '1 Pallet Rd', suburb: 'Pallet', state: 'VIC', postcode: '3000' };
const MISTY_PROFILE = { firstName: 'Misty', lastName: 'Waterflower', phone: '0400000002', address1: '9 Cerulean Ave', suburb: 'Cerulean', state: 'QLD', postcode: '4000' };

test('each account has its own copy of the list; edits never leak', async () => {
  const a = (await ash.get('/api/products')).body.products;
  const m = (await misty.get('/api/products')).body.products;
  assert.equal(a.length, m.length);
  assert.ok(a.every((p) => !m.some((q) => q.id === p.id)), 'different product ids per account');
  await ash.put(`/api/products/${a[0].id}`, { name: 'Ash renamed', quantity: 4 });
  await ash.del(`/api/products/${a[1].id}`);
  await ash.post('/api/products', { url: 'https://www.ebgames.com.au/product/toys-and-collectibles/312345-one-piece-op-18-booster-box', name: 'OP-18 Box' });
  const m2 = (await misty.get('/api/products')).body.products;
  assert.deepEqual(m2, m, "Misty's list is untouched");
  assert.ok(!m2.some((p) => p.name === 'Ash renamed' || p.name === 'OP-18 Box'));
});

test("you can't read, change, reorder, delete or ⚡ Buy someone else's product", async () => {
  const mistyProduct = (await misty.get('/api/products')).body.products[0];
  assert.equal((await ash.put(`/api/products/${mistyProduct.id}`, { name: 'hacked' })).status, 404);
  assert.equal((await ash.del(`/api/products/${mistyProduct.id}`)).status, 404);
  assert.equal((await ash.post(`/api/products/${mistyProduct.id}/go`, { quantity: 2 })).status, 404);
  const reordered = await ash.post('/api/products/reorder', { ids: [mistyProduct.id] });
  assert.ok(!reordered.body.products.some((p) => p.id === mistyProduct.id), "reorder ignores ids that aren't yours");
  const after = (await misty.get('/api/products')).body.products[0];
  assert.deepEqual(after, mistyProduct);
});

test('delivery details are per account and encrypted at rest', async () => {
  await ash.put('/api/profile', ASH_PROFILE);
  await misty.put('/api/profile', MISTY_PROFILE);
  assert.equal((await ash.get('/api/profile')).body.profile.address1, '1 Pallet Rd');
  assert.equal((await misty.get('/api/profile')).body.profile.address1, '9 Cerulean Ave');
  // Nothing readable in the database file.
  const rows = env.app.db.all("SELECT user_id, enc FROM user_data WHERE kind = 'profile'");
  assert.equal(rows.length, 2);
  for (const r of rows) assert.doesNotMatch(r.enc, /Pallet|Cerulean|Ketchum|0400/);
  // Copying Misty's encrypted row onto Ash's account doesn't decrypt (the ciphertext is bound to its owner).
  const mistyRow = rows.find((r) => r.user_id === misty.user.id);
  env.app.db.run("UPDATE user_data SET enc = :enc WHERE user_id = :u AND kind = 'profile'", { enc: mistyRow.enc, u: ash.user.id });
  const stolen = await ash.get('/api/profile');
  assert.equal(stolen.status, 500, 'swapped data is rejected, not shown');
  await ash.put('/api/profile', ASH_PROFILE);
  assert.equal((await ash.get('/api/profile')).body.profile.address1, '1 Pallet Rd');
});

test('watchlists and alert settings are per account', async () => {
  const url = 'https://www.jbhifi.com.au/products/pokemon-tcg-30th-celebration-elite-trainer-box';
  const w = (await ash.post('/api/watch', { url, name: 'ETB', maxPrice: 120 })).body;
  assert.equal((await misty.get('/api/watch')).body.items.length, 0);
  assert.equal((await misty.put(`/api/watch/${w.id}`, { enabled: false })).status, 404);
  assert.equal((await misty.del(`/api/watch/${w.id}`)).status, 404);
  assert.equal((await misty.post(`/api/watch/${w.id}/quick`, {})).status, 404);
  assert.equal((await ash.get('/api/watch')).body.items[0].enabled, true);

  await ash.put('/api/alerts', { discordWebhook: 'https://discord.com/api/webhooks/1/ash-secret', emailOnRestock: false });
  const mistyAlerts = (await misty.get('/api/alerts')).body.alerts;
  assert.equal(mistyAlerts.discordWebhook, '');
  assert.equal(mistyAlerts.emailOnRestock, true);
  assert.equal((await misty.put('/api/alerts', { discordWebhook: 'https://evil.example/hook' })).status, 400, 'only Discord webhooks');
  const raw = env.app.db.get("SELECT enc FROM user_data WHERE kind = 'alerts' AND user_id = :u", { u: ash.user.id }).enc;
  assert.doesNotMatch(raw, /ash-secret/);
});

test('activity and live alerts go only to their owner', async () => {
  await misty.post('/api/alerts/test');
  const ashEvents = (await ash.get('/api/events')).body.events;
  const mistyEvents = (await misty.get('/api/events')).body.events;
  assert.ok(mistyEvents.some((e) => e.type === 'test'));
  assert.ok(!ashEvents.some((e) => e.type === 'test'));
  assert.equal(env.discord.length, 0, "Misty has no webhook, and Ash's isn't used for Misty's alert");
  assert.ok(env.outbox.some((m) => m.to === 'misty@example.com' && /Test alert/.test(m.subject)));
  await ash.post('/api/alerts/test');
  assert.equal(env.discord.length, 1);
  assert.match(env.discord[0].url, /ash-secret/);
  assert.ok(!env.outbox.some((m) => m.to === 'ash@example.com' && /Test alert/.test(m.subject)), 'Ash turned email alerts off');
});

test('the extension only sees the account it is paired with', async () => {
  const ashDevice = await Device.pair(env.url, ash, 'Ash laptop');
  const mistyDevice = await Device.pair(env.url, misty, 'Misty laptop');
  assert.equal(ashDevice.user.email, 'ash@example.com');

  const ashProducts = (await ashDevice.call('GET', '/api/ext/products')).body.products;
  assert.ok(ashProducts.some((p) => p.name === 'OP-18 Box'));
  const mistyProducts = (await mistyDevice.call('GET', '/api/ext/products')).body.products;
  assert.ok(!mistyProducts.some((p) => p.name === 'OP-18 Box'));

  assert.equal((await ashDevice.call('GET', '/api/ext/profile')).body.profile.address1, '1 Pallet Rd');
  const mp = (await mistyDevice.call('GET', '/api/ext/profile')).body.profile;
  assert.equal(mp.address1, '9 Cerulean Ave');
  assert.equal(mp.email, 'misty@example.com', 'checkout email falls back to the account email');
  assert.ok(!('card' in mp), 'no card data from the server');

  // Devices list and disconnecting are per account too.
  const mistyDevices = (await misty.get('/api/devices')).body.devices;
  assert.equal(mistyDevices.length, 1);
  const ashDevices = (await ash.get('/api/devices')).body.devices;
  assert.equal((await misty.del(`/api/devices/${ashDevices[0].id}`)).status, 404);
  assert.equal((await ashDevice.call('GET', '/api/ext/me')).status, 200);

  // Events from Misty's extension land in Misty's activity only.
  await mistyDevice.call('POST', '/api/ext/events', { type: 'add', name: 'Day UPC', message: 'Clicked Add to Bag' });
  assert.ok((await misty.get('/api/events')).body.events.some((e) => /Clicked Add to Bag/.test(e.message)));
  assert.ok(!(await ash.get('/api/events')).body.events.some((e) => /Clicked Add to Bag/.test(e.message)));

  // A made-up or someone else's token gets nothing.
  assert.equal((await new Device(env.url, 'x'.repeat(43)).call('GET', '/api/ext/products')).status, 401);
  await ash.del(`/api/devices/${ashDevices[0].id}`);
  assert.equal((await ashDevice.call('GET', '/api/ext/products')).status, 401, 'disconnected from the dashboard');
});

test("⚡ Buy codes only work for the account that made them, once, for 2 minutes", async () => {
  const ashDevice = await Device.pair(env.url, ash, 'Ash desktop');
  const mistyDevice = await Device.pair(env.url, misty, 'Misty desktop');
  const p = (await ash.get('/api/products')).body.products.find((x) => x.name === 'OP-18 Box');
  const go = await ash.post(`/api/products/${p.id}/go`, { quantity: 3 });
  assert.equal(go.status, 200);
  const code = new URL(go.body.url).hash.match(/^#tcb-go=([\w-]+)$/)[1];
  assert.equal((await ash.get('/api/products')).body.products.find((x) => x.id === p.id).quantity, 3, 'quantity saved');

  assert.equal((await mistyDevice.call('POST', '/api/ext/claim', { code })).status, 404, "Misty's extension can't use Ash's code");
  const claim = await ashDevice.call('POST', '/api/ext/claim', { code });
  assert.equal(claim.status, 200);
  assert.deepEqual({ sku: claim.body.sku, quantity: claim.body.quantity, host: claim.body.host }, { sku: '312345', quantity: 3, host: 'www.ebgames.com.au' });
  assert.equal((await ashDevice.call('POST', '/api/ext/claim', { code })).status, 404, 'single use');

  const go2 = await ash.post(`/api/products/${p.id}/go`, {});
  const code2 = new URL(go2.body.url).hash.split('=')[1];
  env.app.db.run('UPDATE go_codes SET expires_at = 0');
  assert.equal((await ashDevice.call('POST', '/api/ext/claim', { code: code2 })).status, 404, 'expired');
});

test('pairing codes are single use and expire', async () => {
  const { body } = await ash.post('/api/devices/pair-code');
  const pair = (code) => fetch(`${env.url}/api/ext/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal((await pair(body.code)).status, 200);
  assert.equal((await pair(body.code)).status, 400, 'used');
  const second = (await ash.post('/api/devices/pair-code')).body;
  env.app.db.run('UPDATE pair_codes SET expires_at = 0');
  assert.equal((await pair(second.code)).status, 400, 'expired');
  assert.equal((await pair('AAAA-BBBB')).status, 400);
});

test('admins see accounts and plans, not personal details', async () => {
  const boss = await Client.signup(env.url, 'boss@example.com');
  env.app.repo.updateUser(boss.user.id, { role: 'admin' });
  const users = (await boss.get('/api/admin/users')).body.users;
  const ashRow = users.find((u) => u.email === 'ash@example.com');
  assert.ok(ashRow);
  const text = JSON.stringify(users);
  assert.doesNotMatch(text, /Pallet|Cerulean|password_hash|data_key|discord/i);
  assert.equal(typeof ashRow.products, 'number', 'only counts');
});
