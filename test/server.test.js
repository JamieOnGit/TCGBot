// Dashboard API: CRUD, validation, security checks, diagnostics and live events.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setup, waitFor, PROFILE, CARD } from './helpers.js';

let env;
let base;
before(async () => {
  env = await setup();
  base = env.app.url;
});
after(async () => { await env.teardown(); });

async function api(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-tcgbot': '1', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('serves the dashboard and state', async () => {
  const html = await fetch(base + '/').then((r) => r.text());
  assert.match(html, /<title>TCGBot<\/title>/);
  const js = await fetch(base + '/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  const { body } = await api('GET', '/api/state');
  assert.equal(body.engine.running, false);
  assert.ok(body.retailers.some((r) => r.id === 'ebgames'));
  assert.ok(body.presets.length >= 2);
  assert.equal((await fetch(base + '/../package.json')).status, 404);
});

test('rejects cross-site requests', async () => {
  const noHeader = await fetch(base + '/api/start', { method: 'POST' });
  assert.equal(noHeader.status, 403);
  // DNS-rebinding style request with a foreign Host header.
  const status = await new Promise((resolve) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/state', headers: { host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(status, 403);
});

test('items: create for several stores, edit, validate, delete', async () => {
  const created = await api('POST', '/api/items', { name: 'OP-18 Box', retailers: ['demo', 'demoshop'], keywords: 'one piece, op-18, booster box', mode: 'assist', maxPrice: 200 });
  assert.equal(created.status, 200);
  assert.equal(created.body.items.length, 2);
  const [a, b] = created.body.items;
  assert.equal(a.group, b.group, 'grouped together');
  assert.ok(a.group);

  const bad = await api('POST', '/api/items', { retailers: ['demo'] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /something to look for/);
  const bad2 = await api('POST', '/api/items', { retailers: ['nope'], keywords: 'x' });
  assert.equal(bad2.status, 400);

  const edited = await api('PUT', `/api/items/${a.id}`, { enabled: false, quantity: 2 });
  assert.equal(edited.body.enabled, false);
  assert.equal(edited.body.quantity, 2);
  assert.equal(edited.body.keywords, 'one piece, op-18, booster box', 'partial update keeps other fields');

  const check = await api('POST', `/api/items/${b.id}/check`);
  assert.equal(check.status, 200);
  assert.equal(check.body.item.rt.status, 'out_of_stock');

  assert.equal((await api('DELETE', `/api/items/${a.id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/items/${a.id}`)).status, 400);
  assert.equal((await api('PUT', '/api/items/missing', {})).status, 404);
});

test('settings, profile and card vault', async () => {
  const s = await api('PUT', '/api/settings', { pollSeconds: 20, discordWebhook: '' });
  assert.equal(s.body.pollSeconds, 20);
  assert.equal((await api('PUT', '/api/settings', { pollSeconds: 1 })).status, 400);
  const p = await api('PUT', '/api/profile', PROFILE);
  assert.equal(p.body.state, 'NSW');
  assert.equal((await api('PUT', '/api/profile', { postcode: 'abc' })).status, 400);

  const saved = await api('POST', '/api/vault', { passphrase: 'hunter22', card: CARD });
  assert.equal(saved.body.last4, '4242');
  const state = await api('GET', '/api/state');
  assert.ok(!JSON.stringify(state.body).includes('4242424242424242'), 'full card number never leaves the server');
  assert.equal((await api('POST', '/api/vault/lock')).body.unlocked, false);
  assert.equal((await api('POST', '/api/vault/unlock', { passphrase: 'nope' })).status, 400);
  assert.equal((await api('POST', '/api/vault/unlock', { passphrase: 'hunter22' })).body.unlocked, true);
  assert.equal((await api('DELETE', '/api/vault')).body.exists, false);
});

test('diagnostics: test a link and preview keyword matches', async () => {
  env.store.set('311002', { status: 'preorder', listed: true });
  const probe = await api('POST', '/api/probe', { url: env.store.productUrl('311002'), method: 'http' });
  assert.equal(probe.status, 200);
  assert.equal(probe.body.status, 'preorder');
  assert.equal(probe.body.statusLabel, 'Pre-order open');
  assert.equal(probe.body.retailer, 'Demo Games (fake store)');
  assert.ok(probe.body.signals.length >= 2);

  const search = await api('POST', '/api/search-test', { retailer: 'demo', keywords: 'one piece, op-18, booster box', exclude: 'sleeves', method: 'http' });
  assert.equal(search.status, 200);
  assert.equal(search.body.matches.length, 1);
  assert.match(search.body.matches[0].name, /Booster Box/);
  assert.ok(search.body.total >= 2, 'search returned the sleeves too, but they were filtered out');

  const det = await api('GET', `/api/detect?url=${encodeURIComponent('https://www.kmart.com.au/product/pokemon-booster-43301234/')}`);
  assert.equal(det.body.retailer, 'kmart');
  assert.equal(det.body.sku, '43301234');
});

test('live events stream alerts and item updates', async () => {
  const controller = new AbortController();
  const res = await fetch(base + '/api/events', { signal: controller.signal });
  const reader = res.body.getReader();
  let text = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    } catch { /* aborted */ }
  })();
  await waitFor(() => text.includes('event: hello'), { message: 'hello' });
  env.app.notifier.alert({ level: 'urgent', title: 'SSE test alert' });
  await waitFor(() => text.includes('SSE test alert'), { message: 'alert event' });
  const { body } = await api('POST', '/api/items', { retailers: ['demo'], url: env.store.productUrl('311003'), mode: 'notify', method: 'http' });
  await api('POST', `/api/items/${body.items[0].id}/check`);
  await waitFor(() => text.includes('event: item') && text.includes('OP-18 Card Sleeves'), { message: 'item event with product title' });
  controller.abort();
  await pump;
});
