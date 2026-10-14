// Monitor engine against the fake store over real HTTP (no browser needed).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setup, waitFor, sleep } from './helpers.js';
import { STATUS } from '../src/status.js';
import { Fetcher } from '../src/http.js';

let env;
before(async () => { env = await setup(); });
after(async () => { await env.teardown(); });
beforeEach(() => {
  env.alerts.length = 0;
  env.app.engine.stop();
  for (const it of [...env.app.store.items]) env.app.store.removeItem(it.id);
  for (const [sku, f] of Object.entries({
    311001: { status: 'out_of_stock', listed: false, price: 189.95 },
    311002: { status: 'out_of_stock', listed: true, price: 159 },
    311003: { status: 'in_stock', listed: true },
    311004: { status: 'in_stock', listed: true },
  })) env.store.set(sku, f);
  env.store.setShopify('one-piece-op-18-booster-box', false);
  env.store.state.blockNonBrowsers = false;
});

const urgent = () => env.alerts.filter((a) => a.level === 'urgent');

test('link watch: alerts once per restock, re-arms after selling out', async () => {
  const { app, store } = env;
  const item = app.store.addItem({ retailer: 'demo', url: store.productUrl('311002'), mode: 'notify', method: 'http' });
  let snap = await app.engine.checkItem(item);
  assert.equal(snap.status, STATUS.OUT_OF_STOCK);
  assert.equal(snap.title, 'One Piece Card Game OP-18 Booster Box (24 Packs)');
  assert.equal(snap.price, 159);
  assert.equal(urgent().length, 0);

  store.set('311002', { status: 'in_stock' });
  snap = await app.engine.checkItem(item);
  assert.equal(snap.status, STATUS.IN_STOCK);
  assert.equal(urgent().length, 1);
  assert.match(urgent()[0].title, /In stock: One Piece Card Game OP-18/);

  await app.engine.checkItem(item);
  await app.engine.checkItem(item);
  assert.equal(urgent().length, 1, 'no duplicate alerts while still in stock');

  store.set('311002', { status: 'out_of_stock' });
  await app.engine.checkItem(item);
  store.set('311002', { status: 'preorder' });
  snap = await app.engine.checkItem(item);
  assert.equal(snap.status, STATUS.PREORDER);
  assert.equal(urgent().length, 2, 'alerts again on the next restock');
  assert.equal(snap.history[0].to, STATUS.PREORDER);
});

test('keyword watch finds an unreleased product when it is listed, skipping accessories', async () => {
  const { app, store } = env;
  const item = app.store.addItem({ retailer: 'demo', keywords: 'pokemon, ultra premium|upc, 30th', exclude: 'sleeves', mode: 'notify', method: 'http' });
  let snap = await app.engine.checkItem(item);
  assert.equal(snap.status, STATUS.NOT_LISTED);

  store.set('311001', { listed: true, status: 'coming_soon', jsonld: false });
  snap = await app.engine.checkItem(item);
  assert.equal(snap.status, STATUS.COMING_SOON);
  assert.equal(snap.decidedBy, 'button');
  assert.ok(env.alerts.some((a) => /Listing found/.test(a.title)), 'listing-found alert');
  assert.match(app.store.getItem(item.id).resolvedUrl, /311001-pokemon/);

  store.set('311001', { status: 'preorder', jsonld: true });
  snap = await app.engine.checkItem(item);
  assert.equal(snap.status, STATUS.PREORDER);
  assert.equal(urgent().length, 1);

  // Accessories are excluded: the OP-18 box wins over OP-18 sleeves.
  const box = app.store.addItem({ retailer: 'demo', keywords: 'one piece, op-18|op18, booster box', exclude: 'sleeves', mode: 'notify', method: 'http' });
  await app.engine.checkItem(box);
  assert.match(app.store.getItem(box.id).resolvedUrl, /311002-one-piece/);

  // If the listing disappears, the bot searches again.
  store.set('311001', { listed: false });
  snap = await app.engine.checkItem(item);
  assert.equal(snap.status, STATUS.NOT_FOUND);
  assert.equal(app.store.getItem(item.id).resolvedUrl, '');
});

test('SKU watch resolves the product page through search', async () => {
  const { app } = env;
  const item = app.store.addItem({ retailer: 'demo', sku: '311004', mode: 'notify', method: 'http' });
  const snap = await app.engine.checkItem(item);
  assert.equal(snap.status, STATUS.IN_STOCK);
  assert.equal(snap.decidedBy, 'button', 'page without JSON-LD falls back to the buy button');
  assert.match(app.store.getItem(item.id).resolvedUrl, /\/311004-/);
});

test('max price: in stock but too expensive does not trigger', async () => {
  const { app, store } = env;
  store.set('311002', { status: 'in_stock' });
  const item = app.store.addItem({ retailer: 'demo', url: store.productUrl('311002'), mode: 'assist', maxPrice: 100, method: 'http' });
  const snap = await app.engine.checkItem(item);
  assert.equal(snap.status, STATUS.IN_STOCK);
  assert.equal(snap.overPrice, true);
  assert.equal(urgent().length, 0);
  assert.equal(env.alerts.filter((a) => /over your max price/.test(a.title)).length, 1);
  assert.equal(snap.assist, null, 'no checkout started');
});

test('Shopify store: fast JSON check, predictive search and variant id', async () => {
  const { app, store } = env;
  const item = app.store.addItem({ retailer: 'demoshop', keywords: 'one piece, op-18, booster box', mode: 'notify', method: 'http' });
  let snap = await app.engine.checkItem(item);
  assert.equal(snap.status, STATUS.OUT_OF_STOCK);
  assert.equal(snap.decidedBy, 'shopify-json');
  store.setShopify('one-piece-op-18-booster-box', true);
  snap = await app.engine.checkItem(item);
  assert.equal(snap.status, STATUS.IN_STOCK);
  assert.equal(snap.price, 159);
  assert.equal(app.engine.runtime(item.id).variantId, 4400001);
  const pre = app.store.addItem({ retailer: 'demoshop', url: `${store.url}/shop/products/pokemon-30th-ultra-premium-collection`, mode: 'notify', method: 'http' });
  store.setShopify('pokemon-30th-ultra-premium-collection', true);
  snap = await app.engine.checkItem(pre);
  assert.equal(snap.status, STATUS.PREORDER, '"pre-order" tag means pre-order');
});

test('blocked responses are reported and back off', async () => {
  const { app, store } = env;
  store.state.blockNonBrowsers = true;
  const item = app.store.addItem({ retailer: 'demo', url: store.productUrl('311002'), mode: 'notify', method: 'http' });
  let snap;
  for (let i = 0; i < 5; i++) snap = await app.engine.checkItem(item);
  assert.equal(snap.status, STATUS.BLOCKED);
  assert.equal(snap.errors, 5);
  assert.ok(env.alerts.some((a) => /Trouble checking/.test(a.title)), 'warns after repeated blocks');
  const delay = app.engine.nextDelay({ ...app.store.getItem(item.id), pollSeconds: 10 });
  assert.ok(delay >= 60000, `backs off (got ${delay}ms)`);
});

test('scheduler: start → restock is noticed automatically → stop', async () => {
  const { app, store } = env;
  const item = app.store.addItem({ retailer: 'demo', url: store.productUrl('311002'), mode: 'notify', method: 'http', pollSeconds: 0.05 });
  app.engine.start();
  await waitFor(() => app.engine.snapshot(item.id).checks >= 3, { message: 'a few checks' });
  assert.equal(urgent().length, 0);
  const t0 = Date.now();
  store.set('311002', { status: 'in_stock' });
  await waitFor(() => urgent().length === 1, { message: 'restock alert' });
  const latency = Date.now() - t0;
  assert.ok(latency < 2000, `noticed within ${latency}ms`);
  await sleep(300);
  assert.equal(urgent().length, 1, 'still exactly one alert');
  app.engine.stop();
  const checks = app.engine.snapshot(item.id).checks;
  await sleep(300);
  assert.equal(app.engine.snapshot(item.id).checks, checks, 'no checks after stop');
});

test('per-site gap spaces out requests to the same host', async () => {
  const { store } = env;
  const f = new Fetcher({ getSettings: () => ({ minHostGapSeconds: 0.2 }) });
  const t0 = Date.now();
  await Promise.all([f.fetch(store.productUrl('311002'), { method: 'http' }), f.fetch(store.productUrl('311003'), { method: 'http' }), f.fetch(store.productUrl('311004'), { method: 'http' })]);
  assert.ok(Date.now() - t0 >= 380, `3 requests took ${Date.now() - t0}ms`);
});

test('Discord webhook receives an embed', async () => {
  const { app } = env;
  const received = [];
  const hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { received.push(JSON.parse(b)); res.writeHead(204); res.end(); });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  app.store.setSettings({ discordWebhook: `http://127.0.0.1:${hook.address().port}/hook`, discordMention: '@everyone' });
  app.notifier.alert({ level: 'urgent', title: 'In stock: Test', message: 'EB Games — $10', url: 'https://example.com/p' });
  await waitFor(() => received.length === 1, { message: 'webhook' });
  assert.equal(received[0].content, '@everyone In stock: Test');
  assert.equal(received[0].embeds[0].url, 'https://example.com/p');
  app.store.setSettings({ discordWebhook: '' });
  await new Promise((r) => hook.close(r));
});
