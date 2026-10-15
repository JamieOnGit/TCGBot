// The website and dashboard in a real browser (no extension): landing page,
// sign up, every dashboard tab, admin, phone-sized screens, and no
// JavaScript errors or security-policy violations anywhere.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { Client, PASSWORD, startApp, waitFor } from './helpers.js';

let env;
let browser;
let page;
const errors = [];
const shots = process.env.TCGCOPBOT_SCREENSHOT_DIR;

before(async () => {
  env = await startApp({ adminEmails: 'owner@example.com' });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  // (A 4xx answer to a form with a mistake in it is expected, not an error.)
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
});
after(async () => {
  await browser?.close();
  await env.close();
});

test('landing page: pitch, pricing, honest guardrails', async () => {
  await page.goto(env.url);
  assert.match(await page.title(), /TCGCopBot/);
  const text = await page.textContent('body');
  assert.match(text, /Be at checkout before it sells out/);
  assert.match(text, /A\$19 \/ month/);
  assert.match(text, /You press the final buy button/);
  assert.match(text, /Not affiliated with any retailer/);
  if (shots) await page.screenshot({ path: path.join(shots, 'landing.png'), fullPage: true });
  await page.click('text=Start free trial');
  await page.waitForURL(/\/signup$/);
});

test('sign up in the browser and land on Quick Checkout', async () => {
  await page.fill('#su-name', 'Owner');
  await page.fill('#su-email', 'owner@example.com');
  await page.fill('#su-password', 'short');
  await page.check('#su-terms');
  await page.click('#signup button[type=submit]');
  // The browser's own minlength check stops it first; then the server's message.
  await page.fill('#su-password', PASSWORD);
  await page.click('#signup button[type=submit]');
  await page.waitForURL(/\/app\?welcome=1/);
  await page.waitForSelector('#q-list li[data-id]');
  assert.equal(await page.locator('#q-list li[data-id]').count(), 7);
  assert.match(await page.textContent('#q-list li:first-child'), /Day UPC.*Kmart · SKU 43818648 · \$360\.00/s);
  assert.match(await page.textContent('#ext-status'), /isn't in this browser/);
  assert.match(await page.textContent('#plan-pill'), /Admin/, 'ADMIN_EMAILS account');
  assert.equal(await page.isVisible('#admin-link'), true);
  if (shots) await page.screenshot({ path: path.join(shots, 'dashboard.png'), fullPage: true });
});

test('Quick Checkout: add, edit, reorder, quantity, hide, delete', async () => {
  await page.click('#q-add-toggle');
  await page.fill('#q-url', 'https://www.ebgames.com.au/product/toys-and-collectibles/312345-one-piece-card-game-op-18-booster-box');
  await page.fill('#q-name', 'OP-18 Box');
  await page.fill('#q-price', '159');
  await page.click('#q-save');
  await page.waitForFunction(() => document.querySelectorAll('#q-list li[data-id]').length === 8);
  const last = page.locator('#q-list li[data-id]').last();
  assert.match(await last.textContent(), /OP-18 Box.*EB Games · SKU 312345 · \$159\.00/s);
  await last.getByRole('button', { name: 'Move up' }).click();
  await page.waitForFunction(() => /OP-18 Box/.test(document.querySelector('#q-list li:nth-child(7)').textContent));
  const row = page.locator('#q-list li', { hasText: 'OP-18 Box' });
  await row.locator('input.qty').fill('3');
  await row.locator('input.qty').dispatchEvent('change');
  const owner = env.app.repo.userByEmail('owner@example.com');
  await waitFor(() => env.app.repo.listProducts(owner.id).find((p) => p.sku === '312345').quantity === 3, { message: 'quantity saved' });
  await row.getByRole('button', { name: 'Edit' }).click();
  await page.fill('#q-name', 'OP-18 Booster Box');
  await page.click('#q-save');
  await page.waitForSelector('#q-list li:has-text("OP-18 Booster Box")');
  await page.locator('#q-list li', { hasText: 'OP-18 Booster Box' }).getByRole('button', { name: 'Hide' }).click();
  await page.waitForSelector('#q-list li.off:has-text("OP-18 Booster Box")');
  page.once('dialog', (d) => d.accept());
  await page.locator('#q-list li', { hasText: 'OP-18 Booster Box' }).getByRole('button', { name: 'Delete OP-18 Booster Box' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#q-list li[data-id]').length === 7);
});

test('⚡ Buy without the extension still opens the product (with a one-time code)', async () => {
  // Never touch the real store from tests: answer for it locally.
  const opened = [];
  await page.context().route('https://www.kmart.com.au/**', (route) => {
    opened.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' });
  });
  const row = page.locator('#q-list li', { hasText: 'Knock Out Collection' });
  const [tab] = await Promise.all([page.context().waitForEvent('page'), row.getByRole('button', { name: '⚡ Buy' }).click()]);
  await waitFor(() => opened.length > 0, { message: 'the product page opens' });
  assert.match(opened[0], /^https:\/\/www\.kmart\.com\.au\/product\/.*43818556\/$/);
  await waitFor(() => /#tcb-go=[\w-]{20,}$/.test(tab.url()), { message: 'one-time code in the address' });
  await page.waitForSelector('.toast.warn');
  assert.match(await page.textContent('#toasts'), /extension isn't connected/);
  await tab.close();
});

test('Delivery details: saved per account, validated', async () => {
  await page.click('a[data-tab="details"]');
  await page.waitForFunction(() => document.querySelector('#p-email').placeholder === 'owner@example.com');
  assert.equal(await page.getAttribute('#p-email', 'placeholder'), 'owner@example.com');
  await page.fill('#p-first', 'Jamie');
  await page.fill('#p-a1', '1 George St');
  await page.fill('#p-suburb', 'Sydney');
  await page.selectOption('#p-state', 'NSW');
  await page.fill('#p-postcode', '200');
  await page.click('#p-form button[type=submit]');
  await page.waitForFunction(() => /4 digits/.test(document.querySelector('#p-msg').textContent));
  await page.fill('#p-postcode', '2000');
  await page.click('#p-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#p-msg').textContent === 'Saved.');
  const owner = env.app.repo.userByEmail('owner@example.com');
  assert.equal(env.app.repo.getData(owner.id, 'profile').address1, '1 George St');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#p-a1').value === '1 George St');
  assert.match(await page.textContent('[data-panel="details"]'), /never stored on our servers/);
});

test('Watchlist, Alerts, Activity, Billing, Account tabs', async () => {
  await page.click('a[data-tab="watch"]');
  await page.fill('#w-url', 'https://www.jbhifi.com.au/products/pokemon-tcg-30th-etb');
  await page.fill('#w-name', '30th ETB');
  await page.fill('#w-max', '120');
  await page.click('#w-form button[type=submit]');
  await page.waitForSelector('#w-list li[data-id]');
  assert.match(await page.textContent('#w-list'), /30th ETB.*JB Hi-Fi.*alert at ≤ \$120\.00.*Checking soon/s);

  await page.click('a[data-tab="alerts"]');
  await page.waitForFunction(() => document.querySelector('#a-email-note').textContent !== '');
  await page.fill('#a-hook', 'https://example.com/not-discord');
  await page.click('#a-form button[type=submit]');
  await page.waitForFunction(() => /Discord webhook must look like/.test(document.querySelector('#a-msg').textContent));
  await page.fill('#a-hook', 'https://discord.com/api/webhooks/123/abc');
  await page.click('#a-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#a-msg').textContent === 'Saved.');
  await page.click('#a-test');
  await page.waitForSelector('.toast.urgent');
  assert.equal(env.discord.length, 1);

  await page.click('a[data-tab="activity"]');
  await page.waitForFunction(() => /Test alert|alerts look/.test(document.querySelector('#feed').textContent));
  assert.match(await page.textContent('#feed'), /Welcome to TCGCopBot/);

  await page.click('a[data-tab="billing"]');
  await page.waitForFunction(() => document.querySelector('#b-info').textContent.includes('Plan'));
  assert.match(await page.textContent('#b-note'), /not set up/);

  await page.click('a[data-tab="account"]');
  await page.fill('#acct-name', 'Jamie Owner');
  await page.click('#acct-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#acct-msg').textContent === 'Saved.');
  if (shots) await page.screenshot({ path: path.join(shots, 'account.png'), fullPage: true });
});

test('admin page: customers and plans, not their details', async () => {
  const other = await Client.signup(env.url, 'customer@example.com');
  await other.put('/api/profile', { address1: '42 Secret St' });
  await page.goto(`${env.url}/admin`);
  await page.waitForSelector('#users tr[data-id]');
  const text = await page.textContent('#admin');
  assert.match(text, /customer@example.com/);
  assert.doesNotMatch(text, /Secret St/);
  const row = page.locator('#users tr', { hasText: 'customer@example.com' });
  await row.locator('select').selectOption('comped');
  await page.waitForFunction(() => /Free access/.test(document.querySelector('#users').textContent));
  await page.waitForFunction(() => /plan trial → comped/.test(document.querySelector('#audit').textContent));
  if (shots) await page.screenshot({ path: path.join(shots, 'admin.png'), fullPage: true });
});

test('phone-sized screen: no sideways scrolling', async () => {
  const phone = await browser.newPage({ viewport: { width: 375, height: 800 } });
  phone.on('pageerror', (e) => errors.push(e.message));
  for (const p of ['/', '/signup', '/terms', '/privacy']) {
    await phone.goto(env.url + p);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${p} overflows by ${overflow}px`);
  }
  await phone.close();
});

test('log out', async () => {
  await page.goto(`${env.url}/app`);
  await page.click('#logout');
  await page.waitForURL(`${env.url}/`);
  await page.goto(`${env.url}/app`);
  await page.waitForURL(/\/login\?next=/);
});

test('no JavaScript errors or blocked scripts/styles on any page', () => {
  assert.deepEqual(errors, []);
});
