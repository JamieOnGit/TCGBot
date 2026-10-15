// Subscriptions through Stripe (Checkout for paying, the Customer Portal for
// managing/cancelling, webhooks to keep each account's plan up to date).
// Card payments for subscriptions are handled entirely by Stripe's pages.

import crypto from 'node:crypto';
import { HttpError } from './schema.js';
import { billingConfigured } from './config.js';

const DAY = 24 * 60 * 60 * 1000;

/** Can this account use ⚡ Buy, the extension and restock alerts right now? */
export function entitlement(user, now = Date.now()) {
  const trialEndsAt = user.trial_ends_at || null;
  const base = { plan: user.plan, trialEndsAt, currentPeriodEnd: user.current_period_end || null, cancelAtPeriodEnd: !!user.cancel_at_period_end };
  if (user.role === 'admin') return { ...base, active: true, label: 'Admin' };
  switch (user.plan) {
    case 'active': return { ...base, active: true, label: user.cancel_at_period_end ? 'Subscribed (cancels at period end)' : 'Subscribed' };
    case 'comped': return { ...base, active: true, label: 'Free access' };
    case 'past_due': return { ...base, active: true, label: 'Payment failed — update your card', warning: true };
    case 'trial': {
      const left = trialEndsAt ? trialEndsAt - now : 0;
      return left > 0
        ? { ...base, active: true, label: `Free trial — ${Math.max(1, Math.ceil(left / DAY))} day${Math.ceil(left / DAY) === 1 ? '' : 's'} left` }
        : { ...base, active: false, label: 'Free trial ended' };
    }
    default: return { ...base, active: false, label: 'No active subscription' };
  }
}

const STATUS_TO_PLAN = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'canceled', canceled: 'canceled', incomplete_expired: 'canceled', paused: 'canceled' };

function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export class Billing {
  constructor({ cfg, repo, notifier, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    Object.assign(this, { cfg, repo, notifier, fetch: fetchImpl, now });
  }

  get configured() {
    return billingConfigured(this.cfg);
  }

  async stripe(path, params, method = 'POST') {
    const res = await this.fetch(`${this.cfg.stripe.apiBase}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.cfg.stripe.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form(params).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      this.cfg.log(`[billing] Stripe ${path} failed: HTTP ${res.status} ${body?.error?.message || ''}`);
      throw new HttpError(502, "Couldn't reach the payment provider — please try again in a minute");
    }
    return body;
  }

  /** A Stripe Checkout page for this user to subscribe. */
  async checkoutUrl(user) {
    if (!this.configured) throw new HttpError(503, 'Payments are not set up yet');
    const params = {
      mode: 'subscription',
      line_items: { 0: { price: this.cfg.stripe.priceId, quantity: 1 } },
      success_url: `${this.cfg.baseUrl}/app?billing=success#billing`,
      cancel_url: `${this.cfg.baseUrl}/app#billing`,
      client_reference_id: user.id,
      allow_promotion_codes: 'true',
      metadata: { user_id: user.id },
      subscription_data: { metadata: { user_id: user.id } },
    };
    if (user.stripe_customer_id) params.customer = user.stripe_customer_id;
    else params.customer_email = user.email;
    // Keep the rest of the free trial (Stripe needs at least 48 hours).
    if (user.plan === 'trial' && user.trial_ends_at && user.trial_ends_at - this.now() > 2 * DAY + 60000) {
      params.subscription_data.trial_end = Math.floor(user.trial_ends_at / 1000);
    }
    const session = await this.stripe('/v1/checkout/sessions', params);
    return session.url;
  }

  async portalUrl(user) {
    if (!this.configured) throw new HttpError(503, 'Payments are not set up yet');
    if (!user.stripe_customer_id) throw new HttpError(400, "You don't have a subscription to manage yet");
    const session = await this.stripe('/v1/billing_portal/sessions', { customer: user.stripe_customer_id, return_url: `${this.cfg.baseUrl}/app#billing` });
    return session.url;
  }

  /** Cancel straight away (used when someone deletes their account). */
  async cancelNow(user) {
    if (!this.configured || !user.stripe_subscription_id) return;
    await this.stripe(`/v1/subscriptions/${encodeURIComponent(user.stripe_subscription_id)}`, {}, 'DELETE');
  }

  /** Check the Stripe-Signature header (HMAC-SHA256 over "timestamp.body"). */
  verifySignature(raw, header, toleranceSec = 300) {
    const secret = this.cfg.stripe.webhookSecret;
    if (!secret) throw new HttpError(503, 'Webhook secret is not set');
    let t = null;
    const sigs = [];
    for (const item of String(header || '').split(',')) {
      const [k, v] = item.split('=');
      if (k === 't') t = Number(v);
      if (k === 'v1' && v) sigs.push(v);
    }
    if (!t || !sigs.length) throw new HttpError(400, 'Missing signature');
    if (Math.abs(this.now() / 1000 - t) > toleranceSec) throw new HttpError(400, 'Signature is too old');
    const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
    const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
    if (!ok) throw new HttpError(400, 'Bad signature');
  }

  async handleWebhook(raw, signature) {
    this.verifySignature(raw, signature);
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Bad JSON'); }
    if (!event || !event.id || !event.type) throw new HttpError(400, 'Not a Stripe event');
    if (!this.repo.markStripeEvent(event.id, event.type)) return { duplicate: true };
    const obj = event.data?.object || {};

    switch (event.type) {
      case 'checkout.session.completed': {
        const user = this.repo.userById(obj.client_reference_id || obj.metadata?.user_id) || this.repo.userByStripeCustomer(obj.customer);
        if (!user || obj.mode !== 'subscription') break;
        const other = this.repo.userByStripeCustomer(obj.customer);
        if (other && other.id !== user.id) break; // a customer belongs to one account only
        this.repo.updateUser(user.id, { stripe_customer_id: obj.customer, stripe_subscription_id: obj.subscription, plan: 'active' });
        await this.notifier.notify(user.id, { type: 'billing', level: 'success', message: 'Subscription started — thanks for subscribing!' });
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const user = this.repo.userByStripeCustomer(obj.customer) || this.linkByMetadata(obj);
        if (!user) break;
        const plan = event.type === 'customer.subscription.deleted' ? 'canceled' : STATUS_TO_PLAN[obj.status];
        if (!plan) break; // e.g. "incomplete": wait for the next update
        const periodEnd = obj.current_period_end || obj.items?.data?.[0]?.current_period_end || null;
        const fields = { stripe_subscription_id: obj.id, current_period_end: periodEnd ? periodEnd * 1000 : null, cancel_at_period_end: obj.cancel_at_period_end ? 1 : 0 };
        // Free access given by an admin isn't taken away by a lapsed subscription.
        if (!(user.plan === 'comped' && plan !== 'active')) fields.plan = plan;
        const before = user.plan;
        this.repo.updateUser(user.id, fields);
        if (fields.plan && fields.plan !== before) {
          const msg = { active: 'Subscription active.', past_due: 'Your last payment failed — update your card under Billing to keep access.', canceled: 'Your subscription has ended.' }[fields.plan];
          await this.notifier.notify(user.id, { type: 'billing', level: fields.plan === 'active' ? 'success' : 'warn', message: msg });
        }
        break;
      }
      case 'invoice.payment_failed': {
        const user = this.repo.userByStripeCustomer(obj.customer);
        if (user && user.plan === 'active') {
          this.repo.updateUser(user.id, { plan: 'past_due' });
          await this.notifier.notify(user.id, { type: 'billing', level: 'warn', message: 'Your last payment failed — update your card under Billing to keep access.' });
        }
        break;
      }
      default:
        break;
    }
    return { received: true };
  }

  linkByMetadata(sub) {
    const user = this.repo.userById(sub.metadata?.user_id);
    if (!user || user.stripe_customer_id) return null;
    if (this.repo.userByStripeCustomer(sub.customer)) return null;
    return this.repo.updateUser(user.id, { stripe_customer_id: sub.customer });
  }
}
