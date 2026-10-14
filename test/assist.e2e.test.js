// End-to-end: real (headless) Chromium drives the fake store's checkout.
// Verifies add-to-cart, guest checkout, address entry, delivery choice, card
// entry in a cross-origin iframe, stopping at "Place order", CAPTCHA pauses,
// the Shopify fast path, and that the bot NEVER places the order itself.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, waitFor, sleep, PROFILE, CARD } from './helpers.js';
import { STATUS } from '../src/status.js';

let env;
before(async () => {
  env = await setup();
  env.app.store.setProfile(PROFILE);
  await env.app.vault.save('test-pass-123', CARD);
});
after(async () => { await env.teardown(); });
beforeEach(async () => {
  env.alerts.length = 0;
  env.app.engine.stop();
  for (const it of [...env.app.store.items]) env.app.store.removeItem(it.id);
  const s = env.store.state;
  s.cart = []; s.shipping = null; s.delivery = null; s.challenge = false; s.blockNonBrowsers = false; s.orders = [];
  s.shopify.cart = []; s.shopify.orders = [];
  env.store.set('311002', { status: 'in_stock', listed: true, price: 159 });
  env.store.setShopify('one-piece-op-18-booster-box', true);
  // Close tabs from the previous test.
  if (env.app.browser.isOpen()) for (const p of (await env.app.browser.context()).pages()) await p.close().catch(() => {});
});

async function pageAt(re) {
  const ctx = await env.app.browser.context();
  return waitFor(() => ctx.pages().find((p) => !p.isClosed() && re.test(p.url())), { message: `page ${re}` });
}

test('checkout assist: product → cart → guest → shipping → delivery → payment, stops at Place order', async () => {
  const { app, store } = env;
  const item = app.store.addItem({ retailer: 'demo', url: store.productUrl('311002'), mode: 'assist', quantity: 2, method: 'http' });
  const t0 = Date.now();
  const outcome = await app.engine.goNow(item.id);
  const secs = (Date.now() - t0) / 1000;
  assert.equal(outcome.state, 'ready', `assist outcome: ${JSON.stringify(outcome)}`);
  assert.match(outcome.message, /Place Order/);
  assert.ok(secs < 30, `took ${secs}s`);

  // The store received exactly the right shipping details.
  const ship = store.state.shipping;
  assert.equal(ship.email, PROFILE.email);
  assert.equal(ship.firstName, 'Ash');
  assert.equal(ship.lastName, 'Ketchum');
  assert.equal(ship.phone, PROFILE.phone);
  assert.equal(ship.street, PROFILE.address1);
  assert.equal(ship.unit, PROFILE.address2);
  assert.equal(ship.suburb, 'Sydney');
  assert.equal(ship.state, 'NSW');
  assert.equal(ship.postcode, '2000');
  assert.ok(!ship.news, 'did not opt into marketing');
  assert.equal(ship.addressLookup || '', '', 'left the address-lookup box alone');
  assert.equal(store.state.delivery, 'standard', 'home delivery, not click & collect');
  assert.equal(store.state.cart[0].qty, 2, 'quantity respected');

  // Payment page: card typed into the cross-origin iframe, terms ticked, nothing submitted.
  const page = await pageAt(/\/checkout\/payment/);
  const frame = page.frames().find((f) => f.url().includes('/card-frame'));
  assert.ok(frame, 'card iframe present');
  assert.notEqual(new URL(frame.url()).origin, new URL(page.url()).origin, 'iframe is cross-origin');
  assert.equal(await frame.inputValue('[name=cardnumber]'), '4242 4242 4242 4242');
  assert.equal(await frame.inputValue('[name=exp-date]'), '07 / 27');
  assert.equal(await frame.inputValue('[name=cvc]'), '123');
  assert.equal(await frame.inputValue('[name=ccname]'), 'Ash Ketchum');
  assert.equal(await page.isChecked('input[name=method][value=card]'), true);
  assert.equal(await page.isChecked('input[name=terms]'), true);
  assert.equal(await page.isChecked('input[name=marketing]'), false);
  assert.equal(await page.locator('#tcgbot-banner').count(), 1, 'review banner shown');
  assert.equal(store.state.orders.length, 0, 'the bot did NOT place the order');
  assert.equal(app.engine.snapshot(item.id).assist.state, 'ready');
  assert.ok(env.alerts.some((a) => a.level === 'urgent' && /READY TO BUY/.test(a.title)));

  // When the human clicks Place order, the bot notices the confirmation and pauses the item.
  await page.click('#place');
  await waitFor(() => app.engine.snapshot(item.id).purchased, { timeout: 10000, message: 'purchase detected' });
  assert.equal(store.state.orders.length, 1);
  assert.equal(app.store.getItem(item.id).enabled, false, 'item paused after purchase');
});

test('monitoring triggers checkout assist automatically on restock', async () => {
  const { app, store } = env;
  store.set('311002', { status: 'out_of_stock' });
  const item = app.store.addItem({ retailer: 'demo', url: store.productUrl('311002'), mode: 'assist', method: 'http', pollSeconds: 0.1 });
  app.engine.start();
  await waitFor(() => app.engine.snapshot(item.id).checks >= 2, { message: 'initial checks' });
  assert.equal(app.engine.snapshot(item.id).assist, null);
  const t0 = Date.now();
  store.set('311002', { status: 'in_stock' });
  await waitFor(() => app.engine.snapshot(item.id).assist?.state === 'ready', { timeout: 40000, message: 'assist ready' });
  const secs = (Date.now() - t0) / 1000;
  app.engine.stop();
  assert.ok(secs < 30, `restock → ready in ${secs}s`);
  assert.equal(env.alerts.filter((a) => a.level === 'urgent' && /^In stock/.test(a.title)).length, 1);
  assert.equal(store.state.orders.filter((o) => o.ts > t0).length, 0);
});

test('add-to-cart mode stops at the cart', async () => {
  const { app, store } = env;
  const item = app.store.addItem({ retailer: 'demo', url: store.productUrl('311002'), mode: 'cart', method: 'http' });
  const outcome = await app.engine.goNow(item.id);
  assert.equal(outcome.state, 'in_cart');
  assert.equal(store.state.cart.length, 1);
  assert.equal(store.state.shipping, null, 'did not start checkout');
});

test('CAPTCHA on the page: pauses for the human, then carries on', async () => {
  const { app, store } = env;
  store.state.challenge = true;
  const item = app.store.addItem({ retailer: 'demo', url: store.productUrl('311002'), mode: 'assist', method: 'http' });
  const run = app.engine.goNow(item.id);
  await waitFor(() => app.engine.snapshot(item.id).assist?.state === 'needs_you', { timeout: 20000, message: 'needs_you' });
  assert.match(app.engine.snapshot(item.id).assist.message, /CAPTCHA/);
  assert.ok(env.alerts.some((a) => a.level === 'warning' && /Action needed/.test(a.title)));
  await sleep(1500);
  assert.equal(store.state.cart.length, 0, 'waits instead of clicking through the CAPTCHA');
  store.state.challenge = false; // "the human solved it"
  const outcome = await run;
  assert.equal(outcome.state, 'ready');
  assert.equal(store.state.orders.length, 0);
});

test('sold-out product: assist fails cleanly with a clear message', async () => {
  const { app, store } = env;
  store.set('311002', { status: 'out_of_stock' });
  const item = app.store.addItem({ retailer: 'demo', url: store.productUrl('311002'), mode: 'assist', method: 'http' });
  const outcome = await app.engine.goNow(item.id);
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.error, /Sold Out/);
  assert.equal(store.state.cart.length, 0);
});

test('Shopify fast path: cart permalink → one-page checkout filled → stops at Pay now', async () => {
  const { app, store } = env;
  const item = app.store.addItem({ retailer: 'demoshop', url: `${store.url}/shop/products/one-piece-op-18-booster-box`, mode: 'assist', method: 'http' });
  const t0 = Date.now();
  const outcome = await app.engine.goNow(item.id);
  assert.equal(outcome.state, 'ready', JSON.stringify(outcome));
  assert.match(outcome.message, /Pay now/);
  const page = await pageAt(/\/checkouts\/c\/abc123$/);
  assert.equal(await page.inputValue('[name=email]'), PROFILE.email);
  assert.equal(await page.inputValue('[name=firstName]'), 'Ash');
  assert.equal(await page.inputValue('[name=address1]'), PROFILE.address1);
  assert.equal(await page.inputValue('[name=address2]'), PROFILE.address2);
  assert.equal(await page.inputValue('[name=city]'), 'Sydney');
  assert.equal(await page.inputValue('[name=zone]'), 'NSW');
  assert.equal(await page.inputValue('[name=postalCode]'), '2000');
  assert.equal(await page.inputValue('[name=countryCode]'), 'AU');
  const frame = page.frames().find((f) => f.url().includes('style=shopify'));
  assert.equal(await frame.inputValue('[name=number]'), '4242 4242 4242 4242');
  assert.equal(await frame.inputValue('[name=expiry]'), '07 / 27');
  assert.equal(await frame.inputValue('[name=verification_value]'), '123');
  assert.equal(await frame.inputValue('[name=name]'), 'Ash Ketchum');
  assert.deepEqual(store.state.shopify.cart, [{ variant: 4400001, qty: 1 }]);
  assert.equal(store.state.shopify.orders.length, 0, 'did not pay');
  assert.ok((Date.now() - t0) / 1000 < 20);
});

test('site that refuses plain requests: Auto switches to the browser and still reads stock', async () => {
  const { app, store } = env;
  store.state.blockNonBrowsers = true;
  const item = app.store.addItem({ retailer: 'demo', url: store.productUrl('311002'), mode: 'notify', method: 'auto' });
  const snap = await app.engine.checkItem(item);
  assert.equal(snap.status, STATUS.IN_STOCK);
  assert.equal(snap.via, 'browser');
  const again = await app.engine.checkItem(item);
  assert.equal(again.via, 'browser', 'site stays on the browser method');
  assert.ok(app.bus.recent(50).some((e) => /switching this site to the Browser method/.test(e.message)));
});

test('locked card: fills everything else and leaves the card for you', async () => {
  const { app, store } = env;
  app.vault.lock();
  try {
    const item = app.store.addItem({ retailer: 'demo', url: store.productUrl('311002'), mode: 'assist', method: 'http' });
    const outcome = await app.engine.goNow(item.id);
    assert.equal(outcome.state, 'ready');
    const page = await pageAt(/\/checkout\/payment/);
    const frame = page.frames().find((f) => f.url().includes('/card-frame'));
    assert.equal(await frame.inputValue('[name=cardnumber]'), '');
    assert.equal(store.state.shipping.email, PROFILE.email);
  } finally {
    await app.vault.unlock('test-pass-123');
  }
});
