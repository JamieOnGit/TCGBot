// Quick Checkout: product list storage + API, the generated Tampermonkey
// userscript, and the userscript actually running in a browser on the fake
// store (with a stand-in for Tampermonkey's GM_xmlhttpRequest).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { setup, waitFor } from './helpers.js';
import { buildUserscript, matchPatterns } from '../src/userscript.js';
import { QUICK_DEFAULTS } from '../src/presets.js';

let env;
let browser;
before(async () => {
  env = await setup();
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await env.teardown();
});
beforeEach(() => {
  env.alerts.length = 0;
  const s = env.store.state;
  s.cart = []; s.orders = [];
  env.store.set('311002', { status: 'in_stock', listed: true, drawer: true });
  env.store.set('311004', { status: 'in_stock', listed: true, drawer: false });
  env.store.set('311003', { status: 'out_of_stock', listed: true });
});

async function api(method, path, body, headers = { 'x-tcgbot': '1' }) {
  const res = await fetch(env.app.url + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null), text: res.ok ? null : undefined };
}

test('default list is your 7 Kmart products in priority order', async () => {
  const { body } = await api('GET', '/api/quick');
  assert.deepEqual(body.products.map((p) => p.sku), QUICK_DEFAULTS.map((p) => p.sku));
  assert.equal(body.products[0].name, 'Day UPC');
  assert.equal(body.products[0].store, 'Kmart');
  assert.equal(body.products[0].price, 360);
});

test('generated userscript: valid JS, right header, list embedded safely', () => {
  const script = buildUserscript({ dashboardUrl: 'http://127.0.0.1:8787', products: [...QUICK_DEFAULTS, { sku: 'x', name: 'a</script>b', url: 'https://shop.example.com/products/x' }], rev: 7 });
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /^\/\/ ==UserScript==/);
  assert.match(script, /@version\s+2\.7/);
  assert.match(script, /@match\s+https:\/\/www\.kmart\.com\.au\/\*/);
  assert.match(script, /@match\s+https:\/\/shop\.example\.com\/\*/);
  assert.match(script, /@grant\s+GM_xmlhttpRequest/);
  assert.match(script, /@connect\s+127\.0\.0\.1/);
  assert.match(script, /43818648/);
  assert.ok(!script.includes('</script>'), 'no raw </script> in the embedded list');
  assert.ok(matchPatterns([]).includes('https://www.ebgames.com.au/*'));
});

test('API: add (SKU detected from link), edit, hide, reorder, delete, events, userscript download', async () => {
  const added = await api('POST', '/api/quick/products', { url: 'https://www.kmart.com.au/product/pokemon-tcg-test-booster-43999999/', name: 'Test booster', price: 9 });
  assert.equal(added.status, 200);
  assert.equal(added.body.sku, '43999999');
  const id = added.body.id;
  assert.equal((await api('POST', '/api/quick/products', { url: 'https://example.com/nothing' })).status, 400, 'SKU required when it cannot be detected');
  assert.equal((await api('POST', '/api/quick/products', { url: 'javascript:alert(1)', sku: '1' })).status, 400);

  const edited = await api('PUT', `/api/quick/products/${id}`, { name: 'Renamed', enabled: false });
  assert.equal(edited.body.name, 'Renamed');
  assert.equal(edited.body.enabled, false);
  assert.equal(edited.body.sku, '43999999');

  const before = (await api('GET', '/api/quick')).body.products.map((p) => p.id);
  const reordered = await api('POST', '/api/quick/reorder', { ids: [id] });
  assert.equal(reordered.body.products[0].id, id, 'moved to the top');
  assert.equal(reordered.body.products.length, before.length, 'nothing lost');

  const synced = await fetch(`${env.app.url}/api/quick/products`).then((r) => r.json());
  assert.equal(synced.products[0].id, id, 'the userscript sees the new order');

  const script = await fetch(`${env.app.url}/userscript/tcgbot-quick-checkout.user.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  const text = await script.text();
  assert.match(text, /@name\s+TCGBot Quick Checkout/);
  assert.match(text, /43999999/);
  assert.match(text, new RegExp(`@updateURL\\s+${env.app.url.replace(/[.]/g, '\\.')}`));

  assert.equal((await api('POST', '/api/quick/events', { type: 'checkout', name: 'Day UPC', message: 'Reached checkout' }, {})).status, 403, 'needs the header');
  assert.equal((await api('POST', '/api/quick/events', { type: 'nope' })).status, 400);
  assert.equal((await api('POST', '/api/quick/events', { type: 'checkout', name: 'Day UPC', message: 'Reached checkout', url: 'https://www.kmart.com.au/checkout' })).status, 200);
  assert.ok(env.alerts.some((a) => a.level === 'urgent' && a.title === 'At checkout: Day UPC'));

  assert.equal((await api('DELETE', `/api/quick/products/${id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/quick/products/${id}`)).status, 400);
});

/** A browser page with the generated userscript installed, like Tampermonkey would. */
async function pageWithUserscript() {
  const res = await fetch(`${env.app.url}/userscript/tcgbot-quick-checkout.user.js`);
  const script = await res.text();
  const context = await browser.newContext();
  // Stand-in for Tampermonkey's privileged GM_xmlhttpRequest (not limited by CORS).
  await context.exposeBinding('__tcgGm', async (_src, d) => {
    const r = await fetch(d.url, { method: d.method, headers: d.headers, body: d.data });
    return { status: r.status, responseText: await r.text() };
  });
  await context.addInitScript(`
    window.GM_xmlhttpRequest = (d) => { window.__tcgGm({ method: d.method, url: d.url, headers: d.headers, data: d.data })
      .then((r) => d.onload && d.onload(r)).catch(() => d.onerror && d.onerror()); };
    const __run = () => { ${script} };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __run); else __run();
  `);
  const page = await context.newPage();
  return { page, context };
}

function useMockProducts() {
  for (const p of [...env.app.store.quick.products]) env.app.store.removeQuickProduct(p.id);
  env.app.store.addQuickProduct({ name: 'OP-18 Box', sku: '311002', price: 159, url: env.store.productUrl('311002') });
  env.app.store.addQuickProduct({ name: 'Elite Trainer Box', sku: '311004', price: 79.95, url: env.store.productUrl('311004') });
  env.app.store.addQuickProduct({ name: 'Sleeves', sku: '311003', price: 12, url: env.store.productUrl('311003') });
}

const panelButton = (page, text) => page.locator('#tcgbot-quick-checkout button', { hasText: text }).first();

test('panel: Add to Bag → popup Checkout → checkout page, with the item really in the bag', async () => {
  useMockProducts();
  const { page, context } = await pageWithUserscript();
  try {
    await page.goto(env.store.productUrl('311002'));
    await page.waitForSelector('#tcgbot-quick-checkout');
    await waitFor(async () => /Synced with your TCGBot dashboard/.test(await page.textContent('#tcgbot-quick-checkout')), { message: 'sync' });
    const text = await page.textContent('#tcgbot-quick-checkout');
    assert.match(text, /OP-18 Box · SKU 311002/);
    assert.match(text, /1\. OP-18 Box — \$159/);
    assert.match(text, /2\. Elite Trainer Box/);

    await panelButton(page, 'Add to Bag → Checkout').click();
    await page.waitForURL(/\/checkout/, { timeout: 15000 });
    assert.equal(env.store.state.cart.length, 1, 'item was in the bag before going to checkout');
    assert.equal(env.store.state.orders.length, 0, 'never places the order');
    await waitFor(() => env.alerts.some((a) => a.title === 'At checkout: OP-18 Box'), { message: 'checkout event' });
    assert.ok(env.app.bus.recent(50).some((e) => /\[Quick Checkout\] OP-18 Box: Clicked Add to Bag/.test(e.message)));
  } finally {
    await context.close();
  }
});

test('panel: no popup → opens the bag page → continues to checkout after the page change', async () => {
  useMockProducts();
  const { page, context } = await pageWithUserscript();
  try {
    await page.goto(env.store.productUrl('311004'));
    await page.waitForSelector('#tcgbot-quick-checkout');
    await panelButton(page, 'Add to Bag → Checkout').click();
    await page.waitForURL(/\/checkout/, { timeout: 20000 });
    assert.equal(env.store.state.cart.length, 1);
    assert.equal(env.store.state.cart[0].sku, '311004');
    assert.ok(env.app.bus.recent(50).some((e) => /Elite Trainer Box: Opening the bag/.test(e.message)), 'went via the bag page');
  } finally {
    await context.close();
  }
});

test('panel: sold-out product says so and reports it; other pages just show the list', async () => {
  useMockProducts();
  const { page, context } = await pageWithUserscript();
  try {
    await page.goto(env.store.productUrl('311003'));
    await page.waitForSelector('#tcgbot-quick-checkout');
    await panelButton(page, 'Add to Bag → Checkout').click();
    await waitFor(async () => /isn't available/.test(await page.textContent('#tcgbot-quick-checkout')), { message: 'sold out message' });
    assert.equal(env.store.state.cart.length, 0);
    await waitFor(() => env.alerts.some((a) => a.level === 'warning' && /Quick Checkout: Sleeves/.test(a.title)), { message: 'error event' });

    await page.goto(`${env.store.url}/search?q=pokemon`);
    await page.waitForSelector('#tcgbot-quick-checkout');
    await panelButton(page, 'Add to Bag → Checkout').click();
    await waitFor(async () => /Open one of your products first/.test(await page.textContent('#tcgbot-quick-checkout')), { message: 'not a product page' });
    // Minimise works and is remembered for the tab.
    await page.click('#tcgbot-quick-checkout button[title="Minimise"]');
    assert.equal(await page.isVisible('#tcgbot-quick-checkout >> text=Products · priority order'), false);
  } finally {
    await context.close();
  }
});

test('panel works offline with its saved list when the dashboard is not running', async () => {
  useMockProducts();
  const script = await fetch(`${env.app.url}/userscript/tcgbot-quick-checkout.user.js`).then((r) => r.text());
  const context = await browser.newContext();
  await context.addInitScript(`window.GM_xmlhttpRequest = (d) => setTimeout(() => d.onerror && d.onerror(), 10);
    const __run = () => { ${script} };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __run); else __run();`);
  const page = await context.newPage();
  try {
    await page.goto(env.store.productUrl('311002'));
    await page.waitForSelector('#tcgbot-quick-checkout');
    await waitFor(async () => /Dashboard not running/.test(await page.textContent('#tcgbot-quick-checkout')), { message: 'offline note' });
    await panelButton(page, 'Add to Bag → Checkout').click();
    await page.waitForURL(/\/checkout/, { timeout: 15000 });
    assert.equal(env.store.state.cart.length, 1);
  } finally {
    await context.close();
  }
});
