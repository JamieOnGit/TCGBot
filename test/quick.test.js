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
import { setup, waitFor, PROFILE, CARD } from './helpers.js';
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
  s.cart = []; s.orders = []; s.checkoutStyle = 'generic'; s.cardInIframe = false; s.account = null; s.kmart = { steps: [] };
  const reset = { maxQty: 0, stripHash: false, otherPanel: false, lateMs: 0, qtyStyle: 'input' };
  env.store.set('311002', { ...reset, status: 'in_stock', listed: true, drawer: true });
  env.store.set('311004', { ...reset, status: 'in_stock', listed: true, drawer: false });
  env.store.set('311003', { ...reset, status: 'out_of_stock', listed: true });
});

async function api(method, p, body, headers = { 'x-tcgbot': '1' }) {
  const res = await fetch(env.app.url + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function useMockProducts(quantities = {}) {
  for (const p of [...env.app.store.quick.products]) env.app.store.removeQuickProduct(p.id);
  env.app.store.addQuickProduct({ name: 'OP-18 Box', sku: '311002', price: 159, url: env.store.productUrl('311002'), quantity: quantities['311002'] || 1 });
  env.app.store.addQuickProduct({ name: 'Elite Trainer Box', sku: '311004', price: 79.95, url: env.store.productUrl('311004'), quantity: quantities['311004'] || 1 });
  env.app.store.addQuickProduct({ name: 'Sleeves', sku: '311003', price: 12, url: env.store.productUrl('311003'), quantity: quantities['311003'] || 1 });
}
const quickId = (sku) => env.app.store.quick.products.find((p) => p.sku === sku).id;

const panelText = (page) => page.textContent('#tcgbot-qc');
const panelButton = (page, text) => page.locator('#tcgbot-qc button', { hasText: text }).first();

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
  const byScript = (f) => m.content_scripts.find((c) => c.js.includes(f));
  assert.equal(byScript('capture.js').run_at, 'document_start', 'grabs the ⚡ Buy code before the site runs');
  assert.deepEqual(byScript('content.js').js, ['core.js', 'fill.js', 'content.js']);
  assert.equal(byScript('frame.js').all_frames, true, 'fills card boxes in payment iframes');
  for (const host of ['www.kmart.com.au', 'www.ebgames.com.au', 'www.target.com.au', 'www.bigw.com.au', 'www.jbhifi.com.au']) {
    assert.ok(byScript('content.js').matches.includes(`https://${host}/*`), host);
  }
  for (const f of ['capture.js', 'core.js', 'fill.js', 'content.js', 'frame.js', 'background.js', 'popup.html', 'popup.js']) assert.ok(fs.existsSync(path.join(EXTENSION_DIR, f)), f);
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

test('API: ⚡ Buy makes a one-time code; quantity is saved; codes work once', async () => {
  useMockProducts();
  const id = quickId('311002');
  assert.equal((await api('PUT', `/api/quick/products/${id}`, { quantity: 11 })).status, 400, 'max 10');
  const go = await api('POST', '/api/quick/go', { id, quantity: 3 });
  assert.equal(go.status, 200);
  assert.equal(go.body.quantity, 3);
  assert.equal(env.app.store.getQuickProduct(id).quantity, 3, 'quantity saved on the product');
  const url = new URL(go.body.url);
  assert.equal(url.origin + url.pathname, env.store.productUrl('311002'));
  const code = url.hash.match(/^#tcgbot-go=([\w-]+)$/)[1];
  assert.equal((await api('POST', '/api/quick/claim', { code }, {})).status, 403, 'needs the header');
  const claim = await api('POST', '/api/quick/claim', { code });
  assert.equal(claim.body.ok, true);
  assert.equal(claim.body.sku, '311002');
  assert.equal(claim.body.quantity, 3);
  assert.ok(claim.body.fillToken, 'comes with an autofill pass');
  assert.equal((await api('POST', '/api/quick/claim', { code })).status, 404, 'single use');
  assert.equal((await api('POST', '/api/quick/claim', { code: 'made-up-code-123' })).status, 404);
  assert.equal((await api('POST', '/api/quick/go', { id: 'nope' })).status, 404);
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
    await page.waitForSelector('#tcgbot-qc');
    await waitFor(async () => /OP-18 Box · SKU 311002/.test(await panelText(page)), { message: 'panel shows the product' });
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
    await page.waitForSelector('#tcgbot-qc');
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
    await page.waitForSelector('#tcgbot-qc');
    await panelButton(page, 'Add to Bag → Checkout').click();
    await waitFor(async () => /isn't available/.test(await panelText(page)), { message: 'sold out message' });
    assert.equal(env.store.state.cart.length, 0);

    await page.goto(`${env.store.url}/search?q=pokemon`);
    await page.waitForSelector('#tcgbot-qc');
    await panelButton(page, 'Add to Bag → Checkout').click();
    await waitFor(async () => /Open one of your products first/.test(await panelText(page)), { message: 'not a product page' });

    // No panel on the TCGBot dashboard (also on 127.0.0.1, but not a store).
    await page.goto(env.app.url);
    await page.waitForSelector('#tab-quick');
    await page.waitForTimeout(800);
    assert.equal(await page.locator('#tcgbot-qc').count(), 0);

    // Toolbar popup lists the products.
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForFunction(() => /Connected to TCGBot/.test(document.getElementById('status').textContent));
    assert.match(await popup.textContent('#list'), /1\. OP-18 Box/);

    // Dashboard "not running": point at a closed port — the saved list still works.
    await sw.evaluate(() => chrome.storage.local.set({ port: 9 }));
    await page.goto(env.store.productUrl('311002'));
    await page.waitForSelector('#tcgbot-qc');
    assert.match(await panelText(page), /TCGBot isn't running — using your last saved list/);
    await panelButton(page, 'Add to Bag → Checkout').click();
    await page.waitForURL(/\/checkout/, { timeout: 15000 });
    assert.equal(env.store.state.cart.length, 1);
  });
});

test('extension: dashboard Qty + ⚡ Buy → new tab runs Add to Bag → Checkout by itself with that quantity', async () => {
  useMockProducts();
  await withExtension(async (ctx) => {
    const dash = await ctx.newPage();
    await dash.goto(env.app.url);
    await dash.waitForSelector('#quick-list li[data-qid]');
    const row = dash.locator('#quick-list li', { hasText: 'OP-18 Box' });
    await row.locator('[data-q="qty"]').fill('2');
    await row.locator('[data-q="qty"]').dispatchEvent('change');
    await waitFor(() => env.app.store.getQuickProduct(quickId('311002')).quantity === 2, { message: 'qty saved' });
    const [tab] = await Promise.all([ctx.waitForEvent('page'), row.locator('[data-q="buy"]').click()]);
    await tab.waitForURL(/\/checkout/, { timeout: 20000 });
    assert.equal(env.store.state.cart.length, 1);
    assert.equal(env.store.state.cart[0].qty, 2, 'quantity 2 was set before adding');
    assert.equal(env.store.state.orders.length, 0);
    await waitFor(() => env.alerts.some((a) => a.title === 'At checkout: OP-18 Box'), { message: 'checkout event' });
    assert.ok(env.app.bus.recent(80).some((e) => /OP-18 Box: Clicked Add to Bag \(quantity 2\)/.test(e.message)));
  });
});

test('extension: ⚡ Buy with +/− quantity buttons, a slow-loading page and no popup (via the bag page)', async () => {
  useMockProducts();
  env.store.set('311004', { qtyStyle: 'stepper', lateMs: 2500, drawer: false });
  await withExtension(async (ctx) => {
    const page = await ctx.newPage();
    const go = await api('POST', '/api/quick/go', { id: quickId('311004'), quantity: 3 });
    await page.goto(go.body.url);
    await page.waitForURL(/\/checkout/, { timeout: 25000 });
    assert.equal(env.store.state.cart.length, 1);
    assert.equal(env.store.state.cart[0].sku, '311004');
    assert.equal(env.store.state.cart[0].qty, 3, 'clicked + twice');
  });
});

test('extension: a link with a made-up or reused code does not start anything', async () => {
  useMockProducts();
  await withExtension(async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(`${env.store.productUrl('311002')}#tcgbot-go=made-up-code-123`);
    await page.waitForSelector('#tcgbot-qc');
    await waitFor(async () => /expired/.test(await panelText(page)), { message: 'expired note' });
    assert.ok(!page.url().includes('tcgbot-go'), 'code removed from the address bar');
    await page.waitForTimeout(1500);
    assert.equal(env.store.state.cart.length, 0, 'nothing added');
    assert.ok(!/\/checkout/.test(page.url()));
  });
});

test('extension: the panel button uses the quantity from your list', async () => {
  useMockProducts({ 311002: 2 });
  await withExtension(async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(env.store.productUrl('311002'));
    await page.waitForSelector('#tcgbot-qc');
    assert.match(await panelText(page), /OP-18 Box · SKU 311002 · Qty 2/);
    await panelButton(page, 'Add to Bag → Checkout').click();
    await page.waitForURL(/\/checkout/, { timeout: 15000 });
    assert.equal(env.store.state.cart[0].qty, 2);
  });
});

// ---------------------------------------------------------------------------
// The bookmark button (runs in any browser — here a plain Chromium tab)
// ---------------------------------------------------------------------------
test('bookmark button: one click on a product page goes to checkout; via the bag page it needs a second click', async () => {
  useMockProducts({ 311002: 2 });
  const { body } = await api('GET', '/api/quick/bookmarklet');
  const code = decodeURIComponent(body.href.slice('javascript:'.length));
  const page = await browser.newPage();
  try {
    await page.goto(env.store.productUrl('311002'));
    await page.evaluate(code); // = clicking the bookmark
    await page.waitForURL(/\/checkout/, { timeout: 15000 });
    assert.equal(env.store.state.cart.length, 1);
    assert.equal(env.store.state.cart[0].qty, 2, 'quantity from the list');

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

// ---------------------------------------------------------------------------
// Kmart-style checkout autofill (Order Summary → Details → Delivery → Payment)
// ---------------------------------------------------------------------------
const ACCOUNT = { email: 'kmart-account@example.com', firstName: 'Jamie', lastName: 'Account', phone: '0400000000' };

async function kmartSetup({ unlocked = true, iframe = false } = {}) {
  const s = env.store.state;
  s.checkoutStyle = 'kmart';
  s.cardInIframe = iframe;
  s.account = ACCOUNT; // logged in: Kmart fills Details itself
  env.app.store.setProfile(PROFILE);
  if (!env.app.vault.exists()) await env.app.vault.save('test-pass-123', CARD);
  if (unlocked) await env.app.vault.unlock('test-pass-123'); else env.app.vault.lock();
}

async function buyAndWaitForReady(ctx, sku, quantity) {
  const page = await ctx.newPage();
  const go = await api('POST', '/api/quick/go', { id: quickId(sku), quantity });
  await page.goto(go.body.url);
  await page.waitForURL(/\/checkout$/, { timeout: 20000 });
  await page.waitForFunction(() => /Ready — review everything and press "Checkout securely"/.test(document.querySelector('#tcgbot-qc')?.textContent || ''), null, { timeout: 30000 });
  return page;
}

test('Kmart checkout: ⚡ Buy → details kept → address filled → payment card filled → stops at "Checkout securely"', async () => {
  useMockProducts();
  await kmartSetup();
  await withExtension(async (ctx) => {
    const page = await buyAndWaitForReady(ctx, '311002', 2);
    const k = env.store.state.kmart;
    assert.equal(env.store.state.cart[0].qty, 2);
    assert.deepEqual(k.steps.map((x) => x.step), ['summary', 'details', 'delivery'], 'pressed Continue to details → delivery → payment');
    assert.equal(k.details.email, ACCOUNT.email, 'kept the details Kmart already had');
    assert.equal(k.details.firstName, 'Jamie');
    assert.equal(k.details.kmail, undefined, 'did not sign up to Kmail');
    assert.equal(k.details.review, undefined);
    assert.equal(k.delivery.method, 'home', 'home delivery, not click & collect');
    assert.equal(k.delivery.address1, PROFILE.address1);
    assert.equal(k.delivery.address2, PROFILE.address2);
    assert.equal(k.delivery.suburb, 'Sydney');
    assert.equal(k.delivery.state, 'NSW');
    assert.equal(k.delivery.postcode, '2000');
    assert.equal(await page.isChecked('input[name=pay][value=card]'), true);
    assert.equal(await page.inputValue('input[name=cardNumber]'), '4242 4242 4242 4242');
    assert.equal(await page.inputValue('input[name=cardExpiry]'), '07/27');
    assert.equal(await page.inputValue('input[name=cardCvv]'), '123');
    assert.equal(await page.locator('#tcgbot-banner').count(), 1);
    if (process.env.TCGBOT_SCREENSHOT_DIR) {
      await page.setViewportSize({ width: 1100, height: 760 });
      await page.screenshot({ path: path.join(process.env.TCGBOT_SCREENSHOT_DIR, 'kmart-ready.png') });
    }
    await page.waitForTimeout(1500);
    assert.equal(env.store.state.orders.length, 0, '"Checkout securely" was NOT pressed');
    assert.ok(env.app.bus.recent(80).some((e) => /Sent your saved details to the extension.*card included/.test(e.message)));
  });
});

test('Kmart checkout: card boxes inside a payment iframe are filled too', async () => {
  useMockProducts();
  await kmartSetup({ iframe: true });
  await withExtension(async (ctx) => {
    const page = await buyAndWaitForReady(ctx, '311002', 1);
    const frame = page.frames().find((f) => f.url().includes('style=kmart'));
    assert.ok(frame, 'payment iframe present');
    assert.notEqual(new URL(frame.url()).origin, new URL(page.url()).origin, 'iframe is cross-origin');
    await waitFor(async () => (await frame.inputValue('[name=encryptedCardNumber]')) === '4242424242424242', { message: 'card number in iframe' });
    assert.equal(await frame.inputValue('[name=encryptedExpiryDate]'), '07/27');
    assert.equal(await frame.inputValue('[name=encryptedSecurityCode]'), '123');
    assert.equal(env.store.state.orders.length, 0);
  });
});

test('Kmart checkout: with the card locked, everything else is filled and the card is left to you', async () => {
  useMockProducts();
  await kmartSetup({ unlocked: false });
  await withExtension(async (ctx) => {
    const page = await buyAndWaitForReady(ctx, '311002', 1);
    assert.equal(env.store.state.kmart.delivery.postcode, '2000');
    assert.equal(await page.inputValue('input[name=cardNumber]'), '');
    assert.match(await panelText(page), /card is locked in TCGBot/);
  });
  await env.app.vault.unlock('test-pass-123');
});

test('quantity: no box on the product page → set in the bag (Qty 4), then on to checkout', async () => {
  useMockProducts();
  env.store.set('311004', { qtyStyle: 'none', drawer: true });
  await withExtension(async (ctx) => {
    const page = await ctx.newPage();
    const go = await api('POST', '/api/quick/go', { id: quickId('311004'), quantity: 4 });
    await page.goto(go.body.url);
    await page.waitForURL(/\/checkout/, { timeout: 25000 });
    assert.equal(env.store.state.cart.length, 1);
    assert.equal(env.store.state.cart[0].qty, 4, 'quantity 4 set on the bag page');
    await waitFor(() => env.app.bus.recent(80).some((e) => /Elite Trainer Box: Set quantity 4 in the bag/.test(e.message)), { message: 'bag quantity event' });
  });
});

test('quantity: the store allows only 2 → adds 2 and says so', async () => {
  useMockProducts();
  env.store.set('311002', { maxQty: 2 });
  await withExtension(async (ctx) => {
    const page = await ctx.newPage();
    const go = await api('POST', '/api/quick/go', { id: quickId('311002'), quantity: 4 });
    await page.goto(go.body.url);
    await page.waitForURL(/\/checkout/, { timeout: 20000 });
    assert.equal(env.store.state.cart[0].qty, 2);
    await waitFor(() => env.alerts.some((a) => /only allows 2 per order/.test(a.message || '')), { message: 'limit reported' });
  });
});

test('⚡ Buy still starts when the store tidies the address on load; old Tampermonkey panels are flagged, not obeyed', async () => {
  useMockProducts();
  env.store.set('311002', { stripHash: true, otherPanel: true });
  await withExtension(async (ctx) => {
    const page = await ctx.newPage();
    const go = await api('POST', '/api/quick/go', { id: quickId('311002'), quantity: 1 });
    await page.goto(go.body.url);
    await page.waitForSelector('#tcgbot-qc');
    assert.match(await panelText(page), /Another quick-checkout script/);
    await page.waitForURL(/\/checkout/, { timeout: 20000 });
    assert.equal(env.store.state.cart.length, 1, 'added once (the old panel is ignored)');
  });
});

test('panel is small, top-left, and can be dragged', async () => {
  useMockProducts();
  await withExtension(async (ctx) => {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(env.store.productUrl('311002'));
    await page.waitForSelector('#tcgbot-qc');
    const box = await page.locator('#tcgbot-qc').boundingBox();
    assert.ok(box.x < 30 && box.y < 30, `top-left (${box.x},${box.y})`);
    assert.ok(box.width <= 240, `narrow (${box.width}px)`);
    assert.ok(box.height <= 200, `short (${box.height}px)`);
    const head = page.locator('#tcgbot-qc strong').first();
    const hb = await head.boundingBox();
    await page.mouse.move(hb.x + 10, hb.y + 5);
    await page.mouse.down();
    await page.mouse.move(hb.x + 410, hb.y + 305, { steps: 5 });
    await page.mouse.up();
    const moved = await page.locator('#tcgbot-qc').boundingBox();
    assert.ok(moved.x > 350 && moved.y > 250, 'dragged');
    await page.reload();
    await page.waitForSelector('#tcgbot-qc');
    const again = await page.locator('#tcgbot-qc').boundingBox();
    assert.ok(Math.abs(again.x - moved.x) < 3, 'position remembered');
  });
});

test('dashboard shows the extension is installed, and the autofill pass is required for your details', async () => {
  useMockProducts();
  await withExtension(async (ctx) => {
    const dash = await ctx.newPage();
    await dash.goto(env.app.url);
    await dash.waitForSelector('#quick-status .qs');
    assert.match(await dash.textContent('#quick-status'), /TCGBot extension v1\.1\.0 is installed/);
  });
  assert.equal((await api('POST', '/api/quick/fill', {})).status, 403);
  assert.equal((await api('POST', '/api/quick/fill', { token: 'made-up' })).status, 403);
  const go = await api('POST', '/api/quick/go', { id: quickId('311002') });
  const code = new URL(go.body.url).hash.split('=')[1];
  const claim = await api('POST', '/api/quick/claim', { code });
  assert.ok(claim.body.fillToken);
  assert.equal(claim.body.host, new URL(env.store.url).host);
  const fill = await api('POST', '/api/quick/fill', { token: claim.body.fillToken });
  assert.equal(fill.status, 200);
  assert.equal(fill.body.profile.postcode, PROFILE.postcode);
});
