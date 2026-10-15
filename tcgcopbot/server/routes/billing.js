// Subscribe / manage subscription, and Stripe's webhook.

import { entitlement } from '../billing.js';

export function register(router, ctx) {
  const { billing, repo } = ctx;

  router.get('/api/billing', async (req) => ({
    configured: billing.configured,
    price: ctx.cfg.priceDisplay,
    entitlement: entitlement(req.user, repo.now()),
    hasCustomer: !!req.user.stripe_customer_id,
  }));

  router.post('/api/billing/checkout', async (req) => ({ url: await billing.checkoutUrl(req.user) }));

  router.post('/api/billing/portal', async (req) => ({ url: await billing.portalUrl(req.user) }));

  router.post('/api/billing/webhook', async (req) => billing.handleWebhook(req.rawBody, req.headers['stripe-signature']), { auth: 'none', csrf: false, raw: true });
}
