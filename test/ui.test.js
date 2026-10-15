// Drives the dashboard like a user: add an item from a preset, preview matches,
// start monitoring, see the restock appear live, save profile/settings.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { setup, PROFILE } from './helpers.js';

let env;
let browser;
let page;
const errors = [];

before(async () => {
  env = await setup();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(env.app.url);
});
after(async () => {
  await browser?.close();
  await env.teardown();
});

test('opens on Quick Checkout with the default product list', async () => {
  await page.waitForSelector('#tab-quick.active #quick-list li[data-qid]');
  assert.equal(await page.locator('#quick-list li[data-qid]').count(), 7);
  assert.match(await page.textContent('#quick-list li:first-child'), /Day UPC — \$360\.00/);
  assert.match(await page.textContent('#ext-path'), /extension$/);
  assert.match(await page.textContent('#quick-status'), /isn't in this browser/, 'warns when ⚡ Buy can\'t run automatically');
  await page.waitForFunction(() => document.querySelector('#bookmarklet').getAttribute('href').startsWith('javascript:'));
  // Add a product: SKU is detected from the link.
  await page.fill('#q-url', env.store.productUrl('311002'));
  await page.fill('#q-name', 'OP-18 Box');
  await page.click('#q-save');
  await page.waitForFunction(() => document.querySelectorAll('#quick-list li[data-qid]').length === 8);
  assert.match(await page.textContent('#quick-list li:last-child'), /OP-18 Box.*SKU 311002/s);
  // Move it up one place.
  await page.click('#quick-list li:last-child [data-q="up"]');
  await page.waitForFunction(() => /OP-18 Box/.test(document.querySelector('#quick-list li:nth-child(7)').textContent));
  assert.equal(env.app.store.quick.products[6].sku, '311002');
  if (process.env.TCGBOT_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.TCGBOT_SCREENSHOT_DIR, 'quick.png'), fullPage: true });
});

test('empty watchlist offers presets', async () => {
  await page.click('[data-tab="watch"]');
  await page.waitForSelector('#watchlist .empty');
  assert.match(await page.textContent('#watchlist'), /Nothing on your watchlist yet/);
  assert.match(await page.textContent('#engine-pill'), /Stopped/);
});

test('add an item from the OP-18 preset with a keyword preview', async () => {
  await page.click('[data-tab="add"]');
  await page.selectOption('#f-preset', 'op-18-box');
  assert.equal(await page.inputValue('#f-keywords'), 'one piece, op-18|op18|op 18, booster box|booster display|display|24 packs|24 pack');
  // Choose only the fake store for this test.
  for (const cb of await page.$$('#f-retailers input')) await cb.setChecked(false);
  await page.check('#f-retailers input[value="demo"]');
  await page.click('#btn-search-test');
  await page.waitForSelector('#search-out a');
  const preview = await page.textContent('#search-out');
  assert.match(preview, /1 match/);
  assert.match(preview, /OP-18 Booster Box/);
  assert.doesNotMatch(preview, /Sleeves/);
  await page.check('input[name="mode"][value="notify"]');
  await page.click('#btn-save-item');
  await page.waitForSelector('#tab-watch.active .entry');
  assert.match(await page.textContent('#watchlist'), /OP-18 Booster Box/);
  assert.equal(env.app.store.items.length, 1);
  assert.equal(env.app.store.items[0].mode, 'notify');
});

test('test a product link from the form', async () => {
  await page.click('[data-tab="add"]');
  await page.fill('#f-url', env.store.productUrl('311003'));
  await page.waitForFunction(() => document.querySelector('#f-retailer-hint').textContent.includes('Detected'));
  assert.equal(await page.isChecked('#f-retailers input[value="demo"]'), true, 'store auto-detected from the link');
  await page.click('#item-form details summary');
  await page.selectOption('#f-method', 'http');
  await page.click('#btn-probe');
  await page.waitForSelector('#probe-out .chip');
  assert.match(await page.textContent('#probe-out'), /In stock/);
  assert.match(await page.textContent('#probe-out'), /OP-18 Card Sleeves/);
  await page.click('[data-tab="watch"]');
});

test('start monitoring and see a restock arrive live', async () => {
  const item = env.app.store.items[0];
  env.app.store.updateItem(item.id, { pollSeconds: 0.2, method: 'http' });
  env.store.set('311002', { status: 'out_of_stock', listed: true });
  await page.click('[data-tab="watch"]');
  await page.click('#btn-start');
  await page.waitForFunction(() => document.querySelector('#engine-pill').textContent.includes('Running'));
  await page.waitForSelector('.entry .chip.out_of_stock', { timeout: 10000 });
  env.store.set('311002', { status: 'in_stock' });
  await page.waitForSelector('.entry .chip.in_stock', { timeout: 10000 });
  await page.waitForSelector('.toast.urgent', { timeout: 5000 });
  assert.match(await page.textContent('.toast.urgent'), /In stock/);
  assert.match(await page.textContent('.entry .info'), /\$159\.00/);
  // "Why?" panel shows the signals.
  await page.click('.entry [data-act="why"]');
  await page.waitForSelector('.why');
  assert.match(await page.textContent('.why'), /json-ld/);
  const shots = path.join(env.dataDir, 'ui-watchlist.png');
  await page.screenshot({ path: shots, fullPage: true });
  if (process.env.TCGBOT_SCREENSHOT_DIR) fs.copyFileSync(shots, path.join(process.env.TCGBOT_SCREENSHOT_DIR, 'watchlist.png'));
  await page.click('#btn-start');
  await page.waitForFunction(() => document.querySelector('#engine-pill').textContent.includes('Stopped'));
});

test('save profile and settings through the forms', async () => {
  await page.click('[data-tab="profile"]');
  for (const [k, v] of Object.entries(PROFILE)) {
    if (k === 'state') await page.selectOption('#profile-form [name=state]', v);
    else await page.fill(`#profile-form [name=${k}]`, v);
  }
  await page.click('#profile-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#profile-msg').textContent.includes('Saved'));
  assert.equal(env.app.store.profile.email, PROFILE.email);
  assert.equal(env.app.store.profile.state, 'NSW');

  await page.fill('#vault-save [name=number]', '4242 4242 4242 4242');
  await page.fill('#vault-save [name=name]', 'Ash Ketchum');
  await page.fill('#vault-save [name=passphrase]', 'pikachu99');
  await page.fill('#vault-save [name=passphrase2]', 'pikachu99');
  await page.click('#vault-save button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#vault-pill').textContent.includes('4242'));
  if (process.env.TCGBOT_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.TCGBOT_SCREENSHOT_DIR, 'profile.png'), fullPage: true });

  await page.click('[data-tab="settings"]');
  await page.fill('#settings-form [name=pollSeconds]', '12');
  await page.click('#settings-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#settings-msg').textContent.includes('Saved'));
  assert.equal(env.app.store.settings.pollSeconds, 12);

  await page.click('[data-tab="add"]');
  if (process.env.TCGBOT_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.TCGBOT_SCREENSHOT_DIR, 'add-item.png'), fullPage: true });
});

test('no JavaScript errors in the dashboard', () => {
  assert.deepEqual(errors, []);
});
