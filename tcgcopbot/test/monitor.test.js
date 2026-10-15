// Restock monitor: one check per page however many people watch it, honest
// User-Agent, alerts only to the people watching (and entitled), price limits,
// blocked stores backed off (never evaded), and live dashboard updates.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client, startApp } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';

let env;
let store;
let clock;
before(async () => {
  store = await startMockStore();
  clock = { offset: 0 };
  // The fake store runs on this computer, so allow private addresses here (off by default).
  env = await startApp({ urlIntervalSeconds: 60, hostGapSeconds: 0, allowPrivateHosts: true, now: () => Date.now() + clock.offset });
});
after(async () => {
  await env.close();
  await store.close();
});
beforeEach(() => {
  store.state.blockNonBrowsers = false;
  store.state.challenge = false;
});

/** Run the monitor as if `seconds` had passed. */
async function advance(seconds = 61) {
  clock.offset += seconds * 1000;
  return env.app.monitor.tick();
}
const pageRequests = (sku) => store.state.requests.filter((r) => r.path.includes(`/${sku}-`)).length;

test('one request per page however many people watch it; alerts go only to watchers', async () => {
  store.set('311002', { status: 'out_of_stock', listed: true });
  const url = store.productUrl('311002');
  const ash = await Client.signup(env.url, 'ash@example.com');
  const misty = await Client.signup(env.url, 'misty@example.com');
  const brock = await Client.signup(env.url, 'brock@example.com'); // watches something else
  const cheap = await Client.signup(env.url, 'cheap@example.com'); // only at ≤ $100
  const lapsed = await Client.signup(env.url, 'lapsed@example.com'); // trial over
  env.app.repo.updateUser(lapsed.user.id, { trial_ends_at: Date.now() - 1000 });
  await ash.put('/api/alerts', { discordWebhook: 'https://discord.com/api/webhooks/1/ash' });
  for (const c of [ash, misty, cheap, lapsed]) {
    const r = await c.post('/api/watch', { url, name: 'OP-18 Box', maxPrice: c === cheap ? 100 : undefined });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'pending');
  }
  await brock.post('/api/watch', { url: store.productUrl('311003'), name: 'Sleeves' });

  const before = pageRequests('311002');
  await advance();
  assert.equal(pageRequests('311002') - before, 1, 'checked once for four watchers');
  const ua = store.state.requests.at(-1).ua;
  assert.match(ua, /^TCGCopBot\/1\.0/, 'identifies itself honestly');
  let w = (await ash.get('/api/watch')).body.items[0];
  assert.equal(w.status, 'out_of_stock');
  assert.equal(w.price, 159);
  assert.ok(w.checkedAt);

  await advance(10);
  assert.equal(pageRequests('311002') - before, 1, 'not re-checked before the interval');

  // Restock!
  store.set('311002', { status: 'in_stock' });
  const outboxBefore = env.outbox.length;
  await advance();
  w = (await ash.get('/api/watch')).body.items[0];
  assert.equal(w.status, 'in_stock');
  const alerted = (c) => c.get('/api/events').then((r) => r.body.events.some((e) => e.type === 'restock' && e.level === 'urgent' && e.name === 'OP-18 Box'));
  assert.equal(await alerted(ash), true);
  assert.equal(await alerted(misty), true);
  assert.equal(await alerted(cheap), false, 'over their price limit');
  assert.ok((await cheap.get('/api/events')).body.events.some((e) => /over your limit/.test(e.message)));
  assert.equal(await alerted(lapsed), false, 'no alerts without an active plan');
  assert.equal(await alerted(brock), false, "doesn't watch it");
  assert.ok((await brock.get('/api/events')).body.events.some((e) => e.name === 'Sleeves' && e.level === 'urgent'), 'his own item (already in stock) alerted him');
  assert.equal(env.discord.length, 1, "only Ash has Discord set up");
  assert.match(env.discord[0].body.embeds[0].title, /In stock: OP-18 Box/);
  const mails = env.outbox.slice(outboxBefore).map((m) => m.to).sort();
  assert.deepEqual(mails, ['ash@example.com', 'misty@example.com']);

  // Stays in stock: no repeat alert. Sells out and comes back: alerts again.
  await advance();
  assert.equal(env.discord.length, 1);
  store.set('311002', { status: 'out_of_stock' });
  await advance();
  store.set('311002', { status: 'preorder' });
  await advance();
  assert.equal(env.discord.length, 2);
  assert.match(env.discord[1].body.embeds[0].title, /Pre-order open/);
});

test('paused items and pages nobody watches are not checked', async () => {
  const c = await Client.signup(env.url, 'pauser@example.com');
  const w = (await c.post('/api/watch', { url: store.productUrl('311004'), name: 'ETB' })).body;
  await c.put(`/api/watch/${w.id}`, { enabled: false });
  const before = pageRequests('311004');
  await advance();
  assert.equal(pageRequests('311004'), before);
  await c.del(`/api/watch/${w.id}`);
  env.app.monitor.ticks = 0;
  await advance();
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM page_checks WHERE url = :u', { u: store.productUrl('311004') }).n, 0, 'forgotten');
});

test('a store that refuses checks is marked blocked and backed off, not evaded', async () => {
  const c = await Client.signup(env.url, 'blocked@example.com');
  const url = store.productUrl('311001');
  store.set('311001', { listed: true, status: 'out_of_stock' });
  await c.post('/api/watch', { url, name: 'UPC' });
  store.state.blockNonBrowsers = true; // refuses anything that isn't a browser
  const before = store.state.requests.length;
  await advance();
  const r = store.state.requests.slice(before).find((x) => x.path.includes('311001'));
  assert.match(r.ua, /^TCGCopBot/, 'still says who it is');
  let item = (await c.get('/api/watch')).body.items[0];
  assert.match(item.error, /refused|bot check/);
  const row = env.app.db.get('SELECT * FROM page_checks WHERE url = :u', { u: url });
  assert.equal(row.fail_count, 1);
  assert.ok(row.next_check_at - (Date.now() + clock.offset) > 60 * 1000, 'waits longer than usual before trying again');
  // Several failures: shown as blocked.
  for (let i = 0; i < 3; i++) await advance(3600);
  item = (await c.get('/api/watch')).body.items[0];
  assert.equal(item.status, 'blocked');
  const fails = env.app.db.get('SELECT fail_count FROM page_checks WHERE url = :u', { u: url }).fail_count;
  assert.ok(fails >= 3);
  store.state.blockNonBrowsers = false;
  await advance(3600);
  item = (await c.get('/api/watch')).body.items[0];
  assert.equal(item.status, 'out_of_stock', 'recovers when the store answers again');
  assert.equal(item.error, '');
});

test('watch input checks and limits', async () => {
  const c = await Client.signup(env.url, 'limits@example.com');
  assert.equal((await c.post('/api/watch', { url: 'ftp://example.com/x' })).status, 400);
  assert.equal((await c.post('/api/watch', { url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await c.post('/api/watch', {})).status, 400);
  const limit = env.app.cfg.limits.watchItems;
  for (let i = 0; i < limit; i++) assert.equal((await c.post('/api/watch', { url: `https://example.com/p/${i}` })).status, 200);
  const over = await c.post('/api/watch', { url: 'https://example.com/p/over' });
  assert.equal(over.status, 400);
  assert.match(over.body.error, new RegExp(`up to ${limit}`));
});

test('customer links can never make the server fetch its own network', async () => {
  const { assertPublicUrl, isPrivateIp } = await import('../server/monitor/safeurl.js');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '104.18.0.1', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
  const publicLookup = async () => [{ address: '104.18.0.1' }];
  await assert.doesNotReject(assertPublicUrl('https://www.kmart.com.au/product/x-1/', { lookup: publicLookup }));
  for (const bad of ['http://127.0.0.1/admin', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'https://www.kmart.com.au:8443/x', 'file:///etc/passwd', 'http://[::1]/']) {
    await assert.rejects(assertPublicUrl(bad, { lookup: publicLookup }), bad);
  }
  await assert.rejects(assertPublicUrl('https://sneaky.example/', { lookup: async () => [{ address: '10.0.0.5' }] }), 'a name that points inside');

  // End to end with the default (strict) setting: a watch item on a local address is refused by the monitor.
  const strict = await startApp({ hostGapSeconds: 0 });
  try {
    const c = await Client.signup(strict.url, 'ssrf@example.com');
    await c.post('/api/watch', { url: `${strict.url}/api/me`, name: 'internal' });
    const before = store.state.requests.length;
    await strict.app.monitor.tick();
    const item = (await c.get('/api/watch')).body.items[0];
    assert.equal(item.status, 'error');
    assert.match(item.error, /standard web ports|public internet/);
    assert.equal(store.state.requests.length, before);
  } finally {
    await strict.close();
  }
});
