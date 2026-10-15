// Trials, subscriptions (Stripe Checkout, portal, webhooks) and what an
// account can do with and without an active plan. Admin plan changes.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, startApp, startFakeStripe, stripeSignature } from './helpers.js';
import { entitlement } from '../server/billing.js';

const SECRET = 'whsec_test_123';
let env;
let stripe;
let clock;
before(async () => {
  stripe = await startFakeStripe();
  clock = { offset: 0 };
  env = await startApp({
    stripeSecretKey: 'sk_test_abc',
    stripePriceId: 'price_123',
    stripeWebhookSecret: SECRET,
    stripeApiBase: stripe.url,
    trialDays: 7,
    now: () => Date.now() + clock.offset,
  });
});
after(async () => {
  await env.close();
  await stripe.close();
});

async function webhook(event, { secret = SECRET, t } = {}) {
  const payload = JSON.stringify(event);
  return fetch(`${env.url}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignature(secret, payload, t) },
    body: payload,
  });
}

let n = 0;
const evt = (type, object) => ({ id: `evt_${++n}`, type, data: { object } });

test('entitlement rules', () => {
  const now = Date.now();
  assert.equal(entitlement({ plan: 'trial', trial_ends_at: now + 1000 }, now).active, true);
  assert.equal(entitlement({ plan: 'trial', trial_ends_at: now - 1 }, now).active, false);
  assert.equal(entitlement({ plan: 'active' }, now).active, true);
  assert.equal(entitlement({ plan: 'past_due' }, now).warning, true);
  assert.equal(entitlement({ plan: 'canceled' }, now).active, false);
  assert.equal(entitlement({ plan: 'comped' }, now).active, true);
  assert.equal(entitlement({ plan: 'canceled', role: 'admin' }, now).active, true);
});

test('subscribe: Stripe Checkout gets the price, your account id and the rest of your trial', async () => {
  const c = await Client.signup(env.url, 'payer@example.com');
  const r = await c.post('/api/billing/checkout');
  assert.equal(r.status, 200);
  assert.equal(r.body.url, 'https://checkout.stripe.test/pay/cs_test_1');
  const call = stripe.calls.at(-1);
  assert.equal(call.auth, 'Bearer sk_test_abc');
  assert.equal(call.params.mode, 'subscription');
  assert.equal(call.params['line_items[0][price]'], 'price_123');
  assert.equal(call.params.client_reference_id, c.user.id);
  assert.equal(call.params.customer_email, 'payer@example.com');
  assert.ok(Number(call.params['subscription_data[trial_end]']) > Date.now() / 1000 + 6 * 86400, 'keeps the remaining trial days');
  assert.equal((await c.post('/api/billing/portal')).status, 400, 'no subscription to manage yet');
});

test('webhooks: signature checked; checkout completes → active; updates, failures and cancellation', async () => {
  const c = await Client.signup(env.url, 'sub@example.com');
  const id = c.user.id;
  const completed = evt('checkout.session.completed', { mode: 'subscription', client_reference_id: id, customer: 'cus_A', subscription: 'sub_A' });
  assert.equal((await webhook(completed, { secret: 'whsec_wrong' })).status, 400, 'bad signature refused');
  assert.equal((await webhook(completed, { t: Math.floor(Date.now() / 1000) - 3600 })).status, 400, 'old signature refused');
  assert.equal(env.app.repo.userById(id).plan, 'trial');

  assert.equal((await webhook(completed)).status, 200);
  let u = env.app.repo.userById(id);
  assert.equal(u.plan, 'active');
  assert.equal(u.stripe_customer_id, 'cus_A');
  assert.equal((await webhook(completed)).status, 200, 'duplicates are fine');

  const end = Math.floor(Date.now() / 1000) + 30 * 86400;
  await webhook(evt('customer.subscription.updated', { id: 'sub_A', customer: 'cus_A', status: 'active', cancel_at_period_end: true, items: { data: [{ current_period_end: end }] } }));
  u = env.app.repo.userById(id);
  assert.equal(u.cancel_at_period_end, 1);
  assert.equal(u.current_period_end, end * 1000);
  assert.match((await c.get('/api/me')).body.entitlement.label, /cancels at period end/);

  await webhook(evt('invoice.payment_failed', { customer: 'cus_A' }));
  assert.equal(env.app.repo.userById(id).plan, 'past_due');
  assert.equal((await c.get('/api/me')).body.entitlement.active, true, 'grace while Stripe retries');

  await webhook(evt('customer.subscription.updated', { id: 'sub_A', customer: 'cus_A', status: 'active', current_period_end: end }));
  assert.equal(env.app.repo.userById(id).plan, 'active');

  const portal = await c.post('/api/billing/portal');
  assert.equal(portal.body.url, 'https://billing.stripe.test/session/bps_1');
  assert.equal(stripe.calls.at(-1).params.customer, 'cus_A');

  await webhook(evt('customer.subscription.deleted', { id: 'sub_A', customer: 'cus_A', status: 'canceled' }));
  assert.equal(env.app.repo.userById(id).plan, 'canceled');
  assert.equal((await c.get('/api/me')).body.entitlement.active, false);
  const events = (await c.get('/api/events')).body.events.map((e) => e.message);
  assert.ok(events.some((m) => /Subscription started/.test(m)));
  assert.ok(events.some((m) => /subscription has ended/.test(m)));
});

test("a webhook can't move a Stripe customer onto another account", async () => {
  const a = await Client.signup(env.url, 'first@example.com');
  const b = await Client.signup(env.url, 'second@example.com');
  await webhook(evt('checkout.session.completed', { mode: 'subscription', client_reference_id: a.user.id, customer: 'cus_X', subscription: 'sub_X' }));
  await webhook(evt('checkout.session.completed', { mode: 'subscription', client_reference_id: b.user.id, customer: 'cus_X', subscription: 'sub_X' }));
  assert.equal(env.app.repo.userById(a.user.id).stripe_customer_id, 'cus_X');
  assert.equal(env.app.repo.userById(b.user.id).stripe_customer_id, null);
  assert.equal(env.app.repo.userById(b.user.id).plan, 'trial');
});

test('trial ended: lists and details stay; ⚡ Buy, autofill and claims need a subscription', async () => {
  const c = await Client.signup(env.url, 'lapsed@example.com');
  const device = await Device.pair(env.url, c);
  const p = (await c.get('/api/products')).body.products[0];
  clock.offset = 8 * 86400000; // 8 days later
  try {
    const me = (await c.get('/api/me')).body.entitlement;
    assert.equal(me.active, false);
    assert.equal(me.label, 'Free trial ended');
    const go = await c.post(`/api/products/${p.id}/go`, { quantity: 1 });
    assert.equal(go.status, 402);
    assert.equal(go.body.code, 'subscription_required');
    assert.equal((await device.call('GET', '/api/ext/profile')).status, 402);
    assert.equal((await device.call('POST', '/api/ext/claim', { code: 'whatever-code' })).status, 402);
    // Still yours to see and edit.
    assert.equal((await c.get('/api/products')).status, 200);
    assert.equal((await c.put('/api/profile', { firstName: 'Still me' })).status, 200);
    assert.equal((await device.call('GET', '/api/ext/products')).body.active, false);
    assert.equal((await c.post('/api/billing/checkout')).status, 200, 'can subscribe');
    assert.equal(stripe.calls.at(-1).params['subscription_data[trial_end]'], undefined, 'no trial left to carry over');
  } finally {
    clock.offset = 0;
  }
});

test('admin: give free access, extend trials, suspend — all audited', async () => {
  const boss = await Client.signup(env.url, 'admin@example.com');
  env.app.repo.updateUser(boss.user.id, { role: 'admin' });
  const c = await Client.signup(env.url, 'friend@example.com');
  const id = c.user.id;

  assert.equal((await boss.put(`/api/admin/users/${id}`, { plan: 'comped' })).status, 200);
  assert.equal((await c.get('/api/me')).body.entitlement.label, 'Free access');
  const trialEnds = env.app.repo.userById(id).trial_ends_at;
  await boss.put(`/api/admin/users/${id}`, { extendTrialDays: 14 });
  assert.ok(env.app.repo.userById(id).trial_ends_at >= trialEnds + 14 * 86400000 - 1000);
  assert.equal((await boss.put(`/api/admin/users/${id}`, { plan: 'gold' })).status, 400);

  await boss.put(`/api/admin/users/${id}`, { disabled: true });
  assert.equal((await c.get('/api/me')).status, 401, 'suspended accounts are signed out');
  assert.equal((await new Client(env.url).post('/api/auth/login', { email: 'friend@example.com', password: 'correct horse battery staple' })).status, 403);
  await boss.put(`/api/admin/users/${id}`, { disabled: false });
  assert.equal((await boss.put(`/api/admin/users/${boss.user.id}`, { disabled: true })).status, 400, "can't lock yourself out");

  const audit = (await boss.get('/api/admin/audit')).body.entries.map((e) => e.detail);
  assert.ok(audit.some((d) => /friend@example.com: plan trial → comped/.test(d)));
  assert.ok(audit.some((d) => /suspended/.test(d)));
  const stats = (await boss.get('/api/admin/stats')).body;
  assert.ok(stats.users >= 2);

  assert.equal((await boss.del(`/api/admin/users/${id}`, { confirm: 'wrong@example.com' })).status, 400);
  assert.equal((await boss.del(`/api/admin/users/${id}`, { confirm: 'friend@example.com' })).status, 200);
  assert.equal(env.app.repo.userById(id), null);
});

test('deleting a subscribed account cancels the subscription with Stripe', async () => {
  const c = await Client.signup(env.url, 'leaver@example.com');
  await webhook(evt('checkout.session.completed', { mode: 'subscription', client_reference_id: c.user.id, customer: 'cus_L', subscription: 'sub_L' }));
  assert.equal((await c.post('/api/me/delete', { password: 'correct horse battery staple' })).status, 200);
  assert.ok(stripe.calls.some((x) => x.method === 'DELETE' && x.path === '/v1/subscriptions/sub_L'));
});

test('without Stripe keys, billing says so instead of failing', async () => {
  const plain = await startApp();
  try {
    const c = await Client.signup(plain.url, 'free@example.com');
    const b = (await c.get('/api/billing')).body;
    assert.equal(b.configured, false);
    assert.equal((await c.post('/api/billing/checkout')).status, 503);
  } finally {
    await plain.close();
  }
});
