// Quick Checkout: product list storage + API, the TCGBot browser extension
// (loaded for real into Chromium) and the bookmark button, both running
// against the fake store.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { setup, waitFor } from './helpers.js';
import { bookmarkletCode, EXTENSION_DIR } from '../src/bookmarklet.js';
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

async function api(method, p, body, headers = { 'x-tcgbot': '1' }) {
  const res = await fetch(env.app.url + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function useMockProducts() {
  for (const p of [...env.app.store.quick.products]) env.app.store.removeQuickProduct(p.id);
  env.app.store.addQuickProduct({ name: 'OP-18 Box', sku: '311002', price: 159, url: env.store.productUrl('311002') });
  env.app.store.addQuickProduct({ name: 'Elite Trainer Box', sku: '311004', price: 79.95, url: env.store.productUrl('311004') });
  env.app.store.addQuickProduct({ name: 'Sleeves', sku: '311003', price: 12, url: env.store.productUrl('311003') });
}

const panelText = (page) => page.textContent('#tcgbot-quick-checkout');
const panelButton = (page, text) => page.locator('#tcgbot-quick-checkout button', { hasText: text }).first();

test('default list is your 7 Kmart products in priority order', async () => {
  const { body } = await api('GET', '/api/quick');
  assert.deepEqual(body.products.map((p) => p.sku), QUICK_DEFAULTS.map((p) => p.sku));
  assert.equal(body.products[0].name, 'Day UPC');
  assert.equal(body.products[0].store, 'Kmart');
  assert.equal(body.products[0].price, 360);
  assert.equal(body.extensionPath, EXTENSION_DIR);
  assert.ok(fs.existsSync(path.join(body.extensionPath, 'manifest.json')));
});

test('extension manifest is valid and covers the stores', () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.content_scripts[0].js, ['core.js', 'content.js']);
  for (const host of ['www.kmart.com.au', 'www.ebgames.com.au', 'www.target.com.au', 'www.bigw.com.au', 'www.jbhifi.com.au']) {
    assert.ok(m.content_scripts[0].matches.includes(`https://${host}/*`), host);
  }
  for (const f of ['core.js', 'content.js', 'background.js', 'popup.html', 'popup.js']) assert.ok(fs.existsSync(path.join(EXTENSION_DIR, f)), f);
});

test('bookmark button: valid JS, list embedded safely', async () => {
  const code = bookmarkletCode([...QUICK_DEFAULTS, { sku: 'x', name: 'a</script>b', url: 'https://shop.example.com/products/x' }]);
  assert.doesNotThrow(() => new vm.Script(code));
  assert.match(code, /43818648/);
  assert.ok(!code.includes('</script>'));
  const { body } = await api('GET', '/api/quick/bookmarklet');
  assert.match(body.href, /^javascript:/);
  assert.doesNotThrow(() => new vm.Script(decodeURIComponent(body.href.slice('javascript:'.length))));
});

test('API: add (SKU detected from link), edit, hide, reorder, delete, events', async () => {
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

  const reordered = await api('POST', '/api/quick/reorder', { ids: [id] });
  assert.equal(reordered.body.products[0].id, id);
  const synced = await fetch(`${env.app.url}/api/quick/products`).then((r) => r.json());
  assert.equal(synced.products[0].id, id, 'the extension sees the new order');

  assert.equal((await api('POST', '/api/quick/events', { type: 'checkout', name: 'Day UPC', message: 'x' }, {})).status, 403, 'needs the header');
  assert.equal((await api('POST', '/api/quick/events', { type: 'nope' })).status, 400);
  assert.equal((await api('POST', '/api/quick/events', { type: 'checkout', name: 'Day UPC', message: 'Reached checkout', url: 'https://www.kmart.com.au/checkout' })).status, 200);
  assert.ok(env.alerts.some((a) => a.level === 'urgent' && a.title === 'At checkout: Day UPC'));

  assert.equal((await api('DELETE', `/api/quick/products/${id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/quick/products/${id}`)).status, 400);
});

// ---------------------------------------------------------------------------
// The real extension, loaded into Chromium
// ---------------------------------------------------------------------------
async function withExtension(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgbot-ext-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    // Point the extension at this test's dashboard (normally port 8787).
    await sw.evaluate((port) => chrome.storage.local.set({ port }), env.app.web.port);
    const extId = new URL(sw.url()).host;
    await fn(ctx, extId, sw);
  } finally {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('extension: Add to Bag → popup Checkout → checkout page, item really in the bag, reported to the dashboard', async () => {
  useMockProducts();
  await withExtension(async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(env.store.productUrl('311002'));
    await page.waitForSelector('#tcgbot-quick-checkout');
    await waitFor(async () => /Synced with your TCGBot dashboard/.test(await panelText(page)), { message: 'sync' });
    const text = await panelText(page);
    assert.match(text, /OP-18 Box · SKU 311002/);
    assert.match(text, /1\. OP-18 Box — \$159/);
    await panelButton(page, 'Add to Bag → Checkout').click();
    await page.waitForURL(/\/checkout/, { timeout: 15000 });
    assert.equal(env.store.state.cart.length, 1, 'item was in the bag before going to checkout');
    assert.equal(env.store.state.orders.length, 0, 'never places the order');
    await waitFor(() => env.alerts.some((a) => a.title === 'At checkout: OP-18 Box'), { message: 'checkout event' });
    assert.ok(env.app.bus.recent(50).some((e) => /\[Quick Checkout\] OP-18 Box: Clicked Add to Bag/.test(e.message)));
  });
});

test('extension: no popup → opens the bag page → carries on to checkout on the next page', async () => {
  useMockProducts();
  await withExtension(async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(env.store.productUrl('311004'));
    await page.waitForSelector('#tcgbot-quick-checkout');
    await panelButton(page, 'Add to Bag → Checkout').click();
    await page.waitForURL(/\/checkout/, { timeout: 20000 });
    assert.equal(env.store.state.cart.length, 1);
    assert.equal(env.store.state.cart[0].sku, '311004');
    assert.ok(env.app.bus.recent(50).some((e) => /Elite Trainer Box: Opening the bag/.test(e.message)), 'went via the bag page');
  });
});

test('extension: sold out, other pages, the dashboard itself, and offline mode', async () => {
  useMockProducts();
  await withExtension(async (ctx, extId, sw) => {
    const page = await ctx.newPage();
    await page.goto(env.store.productUrl('311003'));
    await page.waitForSelector('#tcgbot-quick-checkout');
    await panelButton(page, 'Add to Bag → Checkout').click();
    await waitFor(async () => /isn't available/.test(await panelText(page)), { message: 'sold out message' });
    assert.equal(env.store.state.cart.length, 0);

    await page.goto(`${env.store.url}/search?q=pokemon`);
    await page.waitForSelector('#tcgbot-quick-checkout');
    await panelButton(page, 'Add to Bag → Checkout').click();
    await waitFor(async () => /Open one of your products first/.test(await panelText(page)), { message: 'not a product page' });

    // No panel on the TCGBot dashboard (also on 127.0.0.1, but not a store).
    await page.goto(env.app.url);
    await page.waitForSelector('#tab-quick');
    await page.waitForTimeout(800);
    assert.equal(await page.locator('#tcgbot-quick-checkout').count(), 0);

    // Toolbar popup lists the products.
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForFunction(() => /Connected to TCGBot/.test(document.getElementById('status').textContent));
    assert.match(await popup.textContent('#list'), /1\. OP-18 Box/);

    // Dashboard "not running": point at a closed port — the saved list still works.
    await sw.evaluate(() => chrome.storage.local.set({ port: 9 }));
    await page.goto(env.store.productUrl('311002'));
    await page.waitForSelector('#tcgbot-quick-checkout');
    assert.match(await panelText(page), /TCGBot isn't running — using your last saved list/);
    await panelButton(page, 'Add to Bag → Checkout').click();
    await page.waitForURL(/\/checkout/, { timeout: 15000 });
    assert.equal(env.store.state.cart.length, 1);
  });
});

// ---------------------------------------------------------------------------
// The bookmark button (runs in any browser — here a plain Chromium tab)
// ---------------------------------------------------------------------------
test('bookmark button: one click on a product page goes to checkout; via the bag page it needs a second click', async () => {
  useMockProducts();
  const { body } = await api('GET', '/api/quick/bookmarklet');
  const code = decodeURIComponent(body.href.slice('javascript:'.length));
  const page = await browser.newPage();
  try {
    await page.goto(env.store.productUrl('311002'));
    await page.evaluate(code); // = clicking the bookmark
    await page.waitForURL(/\/checkout/, { timeout: 15000 });
    assert.equal(env.store.state.cart.length, 1);

    env.store.state.cart = [];
    await page.goto(env.store.productUrl('311004'));
    await page.evaluate(code);
    await page.waitForURL(/\/cart$/, { timeout: 15000 });
    assert.equal(env.store.state.cart.length, 1, 'added, now on the bag page');
    await page.evaluate(code); // second click, on the bag page
    await page.waitForURL(/\/checkout/, { timeout: 15000 });

    await page.goto(env.store.productUrl('311003'));
    await page.evaluate(code);
    await waitFor(async () => /isn't available/.test(await panelText(page)), { message: 'sold out message' });
  } finally {
    await page.close();
  }
});
