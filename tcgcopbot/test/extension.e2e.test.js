// End to end: the real TCGCopBot extension (built for this test server) in
// Chromium, the hosted dashboard, and the fake Kmart-style store.
//
// Sign up → install → connect with one click → save a card in the extension
// → ⚡ Buy with quantity 2 → add to bag → checkout filled from *this
// account's* details and *this browser's* card → stops at "Checkout
// securely" without pressing it. Then a second account on the same browser
// can't use the first account's codes or card.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { writeExtension } from '../server/extension.js';
import { startMockStore } from '../devtools/mockstore.js';
import { Client, PASSWORD, startApp, waitFor } from './helpers.js';

const ACCOUNT_A = { email: 'ash@example.com', name: 'Ash' };
const PROFILE_A = { firstName: 'Ash', lastName: 'Ketchum', email: 'ash.orders@example.com', phone: '0412345678', address1: '1 Pallet Town Rd', address2: 'Unit 2', suburb: 'Sydney', state: 'NSW', postcode: '2000' };
const PROFILE_B = { firstName: 'Misty', lastName: 'Waterflower', phone: '0498765432', address1: '9 Cerulean Ave', suburb: 'Brisbane', state: 'QLD', postcode: '4000' };
const STORE_ACCOUNT = { email: 'kmart-account@example.com', firstName: 'Ash', lastName: 'Ketchum', phone: '0412345678' };

let env;
let store;
let ctx;
let extId;
let sw;
let dirs = [];

before(async () => {
  store = await startMockStore();
  env = await startApp();
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcb-ext-'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcb-chrome-'));
  dirs = [extDir, profileDir];
  writeExtension(env.app.cfg, extDir);
  ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1200, height: 860 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  extId = new URL(sw.url()).host;
});

after(async () => {
  await ctx?.close();
  await env?.close();
  await store?.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  const s = store.state;
  s.cart = []; s.orders = []; s.checkoutStyle = 'kmart'; s.cardInIframe = false; s.account = STORE_ACCOUNT; s.kmart = { steps: [] };
  store.set('311002', { status: 'in_stock', listed: true, drawer: true, maxQty: 0, qtyStyle: 'input', lateMs: 0, stripHash: false, otherPanel: false });
});

/** API calls as whoever is logged in to the browser (shares its cookies). */
async function browserApi(method, p, data) {
  const res = await ctx.request.fetch(env.url + p, { method, headers: { 'x-tcgcopbot': '1', origin: env.url, 'content-type': 'application/json' }, data: data === undefined ? undefined : JSON.stringify(data) });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

async function useMockProducts(api) {
  const { body } = await api('GET', '/api/products');
  for (const p of body.products) await api('DELETE', `/api/products/${p.id}`);
  await api('POST', '/api/products', { url: store.productUrl('311002'), name: 'OP-18 Box', price: 159 });
}

const panel = (page) => page.locator('#tcgcopbot-qc');
const readyText = /Ready — review everything and press "Checkout securely"/;

async function buyFromDashboard(page, name, qty) {
  await page.goto(`${env.url}/app#quick`);
  const row = page.locator('#q-list li', { hasText: name });
  await row.locator('input.qty').fill(String(qty));
  await row.locator('input.qty').dispatchEvent('change');
  const [shop] = await Promise.all([ctx.waitForEvent('page'), row.getByRole('button', { name: '⚡ Buy' }).click()]);
  return shop;
}

test('sign up, install, connect the extension with one click', async () => {
  const page = await ctx.newPage();
  await page.goto(`${env.url}/signup`);
  await page.fill('#su-name', ACCOUNT_A.name);
  await page.fill('#su-email', ACCOUNT_A.email);
  await page.fill('#su-password', PASSWORD);
  await page.check('#su-terms');
  await page.click('#signup button[type=submit]');
  await page.waitForURL(/\/app/);
  await page.goto(`${env.url}/app#extension`);
  await page.waitForFunction(() => /installed but not connected/.test(document.querySelector('#ext-status-2').textContent));
  await page.click('#pair-now');
  await page.waitForFunction(() => /Extension connected/.test(document.querySelector('#ext-status-2').textContent), null, { timeout: 10000 });
  await page.waitForSelector('#devices li .name');
  assert.match(await page.textContent('#devices'), /Chrome on Linux|Chrome/);
  const auth = await sw.evaluate(() => chrome.storage.local.get('auth'));
  assert.equal(auth.auth.user.email, ACCOUNT_A.email);
  assert.equal(auth.auth.server, env.url);

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => document.querySelector('#who').textContent.includes('ash@example.com'));
  assert.match(await popup.textContent('#plan'), /Free trial/);
  await popup.waitForSelector('#products li a');
  assert.equal(await popup.locator('#products li a').count(), 7, 'your starter list');
  await popup.close();
  await page.close();
});

test('card is saved in the extension only — encrypted, tied to this account, never sent to the server', async () => {
  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.waitForSelector('#card-form:not([hidden])');
  await opts.fill('#c-number', '4242 4242 4242 4242');
  await opts.fill('#c-name', 'Ash Ketchum');
  await opts.fill('#c-exp', '07/29');
  await opts.fill('#c-cvc', '123');
  await opts.fill('#c-pass', 'pikachu-123');
  await opts.fill('#c-pass2', 'pikachu-123');
  await opts.click('#card-form button[type=submit]');
  await opts.waitForSelector('#card-saved:not([hidden])');
  assert.match(await opts.textContent('#card-label'), /Visa •••• 4242/);
  assert.equal(await opts.textContent('#card-state'), 'Locked');
  await opts.fill('#unlock-pass', 'wrong-pass');
  await opts.click('#unlock-form button[type=submit]');
  await opts.waitForFunction(() => /Wrong passphrase/.test(document.querySelector('#saved-msg').textContent));
  await opts.fill('#unlock-pass', 'pikachu-123');
  await opts.click('#unlock-form button[type=submit]');
  await opts.waitForFunction(() => /Unlocked/.test(document.querySelector('#card-state').textContent));
  await opts.close();

  const userId = env.app.repo.userByEmail(ACCOUNT_A.email).id;
  const local = await sw.evaluate(() => chrome.storage.local.get(null));
  const vault = local[`vault:${userId}`];
  assert.ok(vault, 'stored under this account');
  assert.equal(vault.last4, '4242');
  assert.doesNotMatch(JSON.stringify(local), /4242 ?4242 ?4242|pikachu/, 'card number and passphrase are not stored in the clear');
  // Nothing about the card on the server.
  const dump = JSON.stringify(env.app.db.all('SELECT * FROM user_data')) + JSON.stringify(env.app.db.all('SELECT * FROM events'));
  assert.doesNotMatch(dump, /4242|Ash Ketchum/);
});

test('⚡ Buy (Qty 2) → bag → Kmart checkout filled from your account → stops at "Checkout securely"', async () => {
  await browserApi('PUT', '/api/profile', PROFILE_A);
  await useMockProducts(browserApi);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'OP-18 Box', 2);
  await shop.waitForURL(/\/checkout$/, { timeout: 20000 });
  await shop.waitForFunction((re) => new RegExp(re).test(document.querySelector('#tcgcopbot-qc')?.textContent || ''), readyText.source, { timeout: 30000 });

  const k = store.state.kmart;
  assert.equal(store.state.cart[0].qty, 2, 'quantity from the dashboard');
  assert.deepEqual(k.steps.map((x) => x.step), ['summary', 'details', 'delivery'], 'Continue to details → delivery → payment');
  assert.equal(k.details.email, STORE_ACCOUNT.email, "kept what the store already had");
  assert.equal(k.details.kmail, undefined, 'never ticks marketing boxes');
  assert.equal(k.delivery.method, 'home');
  assert.equal(k.delivery.address1, PROFILE_A.address1);
  assert.equal(k.delivery.address2, PROFILE_A.address2);
  assert.equal(k.delivery.suburb, 'Sydney');
  assert.equal(k.delivery.postcode, '2000');
  assert.equal(await shop.isChecked('input[name=pay][value=card]'), true);
  assert.equal(await shop.inputValue('input[name=cardNumber]'), '4242 4242 4242 4242', 'card from this browser\'s vault');
  assert.equal(await shop.inputValue('input[name=cardExpiry]'), '07/29');
  assert.equal(await shop.inputValue('input[name=cardCvv]'), '123');
  assert.equal(await shop.locator('#tcgcopbot-banner').count(), 1);
  assert.match(await panel(shop).textContent(), /⚡ TCGCopBot/);
  if (process.env.TCGCOPBOT_SCREENSHOT_DIR) await shop.screenshot({ path: path.join(process.env.TCGCOPBOT_SCREENSHOT_DIR, 'checkout-ready.png') });
  await shop.waitForTimeout(1500);
  assert.equal(store.state.orders.length, 0, '"Checkout securely" was NOT pressed');

  // Reported to this account's activity, live on the dashboard.
  const userId = env.app.repo.userByEmail(ACCOUNT_A.email).id;
  await waitFor(() => env.app.repo.listEvents(userId).some((e) => /OP-18 Box: Clicked Add to Bag \(quantity 2\)/.test(e.message)), { message: 'add event' });
  await waitFor(() => env.app.repo.listEvents(userId).some((e) => /waiting for you to press "Checkout securely"/.test(e.message)), { message: 'ready event' });
  await dash.goto(`${env.url}/app#activity`);
  await dash.waitForFunction(() => /Checkout securely/.test(document.querySelector('#feed').textContent));
  await shop.close();
  await dash.close();
});

test("another account's ⚡ Buy link does nothing in this browser", async () => {
  const misty = await Client.signup(env.url, 'misty@example.com');
  await useMockProducts((m, p, b) => misty.call(m, p, b));
  const p = (await misty.get('/api/products')).body.products[0];
  const go = await misty.post(`/api/products/${p.id}/go`, { quantity: 1 });
  const page = await ctx.newPage();
  await page.goto(go.body.url);
  await panel(page).waitFor();
  await page.waitForFunction(() => /expired or belongs to another account/.test(document.querySelector('#tcgcopbot-qc').textContent), null, { timeout: 10000 });
  await page.waitForTimeout(800);
  assert.equal(store.state.cart.length, 0, 'nothing added');
  assert.ok(!page.url().includes('tcb-go='), 'code removed from the address straight away');
  await page.close();
});

test('switching this browser to another account: their own details, and the first account\'s card is not used', async () => {
  const page = await ctx.newPage();
  await browserApi('POST', '/api/auth/logout');
  await page.goto(`${env.url}/login`);
  await page.fill('#li-email', 'misty@example.com');
  await page.fill('#li-password', PASSWORD);
  await page.click('#login button[type=submit]');
  await page.waitForURL(/\/app/);
  await page.goto(`${env.url}/app#extension`);
  await page.waitForFunction(() => /connected to another account \(ash@example.com\)/.test(document.querySelector('#ext-status-2').textContent));
  await page.locator('#ext-status-2 button').click();
  await page.waitForFunction(() => /Extension connected/.test(document.querySelector('#ext-status-2').textContent), null, { timeout: 10000 });

  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.waitForFunction(() => document.querySelector('#who').textContent === 'misty@example.com');
  assert.equal(await opts.isHidden('#card-saved'), true, "Ash's card isn't shown for Misty");
  await opts.close();

  await browserApi('PUT', '/api/profile', PROFILE_B);
  store.state.account = null; // a guest checkout this time
  const shop = await buyFromDashboard(page, 'OP-18 Box', 1);
  await shop.waitForURL(/\/checkout$/, { timeout: 20000 });
  await shop.waitForFunction((re) => new RegExp(re).test(document.querySelector('#tcgcopbot-qc')?.textContent || ''), readyText.source, { timeout: 30000 });
  const k = store.state.kmart;
  assert.equal(k.details.email, 'misty@example.com', "Misty's account email");
  assert.equal(k.details.firstName, 'Misty');
  assert.equal(k.delivery.address1, '9 Cerulean Ave');
  assert.equal(k.delivery.state, 'QLD');
  assert.equal(await shop.inputValue('input[name=cardNumber]'), '', "Ash's card is not used for Misty");
  assert.equal(store.state.orders.length, 0);
  await shop.close();

  // Disconnect from the dashboard: the extension is signed out.
  await page.goto(`${env.url}/app#extension`);
  page.once('dialog', (d) => d.accept());
  await page.locator('#devices li', { hasText: 'Chrome' }).getByRole('button', { name: 'Disconnect' }).click();
  await waitFor(async () => (await env.app.repo.listDevices(env.app.repo.userByEmail('misty@example.com').id)).length === 0, { message: 'device removed' });
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('#signed-out:not([hidden])');
  assert.equal(await popup.isVisible('#pair-form'), true);
  await popup.close();
  await page.close();
});
