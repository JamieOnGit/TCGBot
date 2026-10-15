// API for the TCGCopBot browser extension. The extension signs in with a
// device token (from pairing) and only ever sees the account it's paired to.
// Card details are not part of this API: they stay in the extension.

import { entitlement } from '../billing.js';
import { EMPTY_PROFILE, HttpError, bad, str } from '../schema.js';
import { storeName } from '../stores.js';

const EVENT_TYPES = { add: 'info', basket: 'info', step: 'info', checkout: 'success', ready: 'success', error: 'warn' };

export function register(router, ctx) {
  const { repo, limiter } = ctx;

  // Pairing: a code shown in the dashboard → a device token for this browser.
  router.post('/api/ext/pair', async (req) => {
    if (!limiter.hit(`pair-ip:${req.ip}`, 15, 15 * 60 * 1000)) throw new HttpError(429, 'Too many attempts — wait 15 minutes');
    const userId = repo.redeemPairCode(str(req.body.code, 20));
    if (!userId) throw new HttpError(400, "That code is wrong or has expired — get a new one from your dashboard");
    const user = repo.userById(userId);
    if (!user || user.disabled) throw new HttpError(403, 'This account is not available');
    const { token, device } = repo.addDevice(userId, str(req.body.name, 60) || 'Browser', str(req.body.version, 20));
    repo.addEvent(userId, { type: 'device', level: 'success', message: `Extension connected: ${device.name}` });
    ctx.hub.publish(userId, 'devices', {});
    return { token, device, user: { id: user.id, email: user.email, name: user.name } };
  }, { auth: 'none', csrf: false });

  router.get('/api/ext/me', async (req) => {
    const version = str(req.query.get('v'), 20);
    if (version && version !== req.device.version) repo.setDeviceVersion(req.user.id, req.device.id, version);
    return { user: { id: req.user.id, email: req.user.email, name: req.user.name }, device: req.device, entitlement: entitlement(req.user, repo.now()) };
  }, { auth: 'device' });

  router.post('/api/ext/unpair', async (req) => {
    repo.deleteDevice(req.user.id, req.device.id);
    ctx.hub.publish(req.user.id, 'devices', {});
    return { ok: true };
  }, { auth: 'device' });

  router.get('/api/ext/products', async (req) => ({
    products: repo.listProducts(req.user.id).map((p) => ({ ...p, store: storeName(p.url) })),
    active: entitlement(req.user, repo.now()).active,
  }), { auth: 'device' });

  // Redeem a ⚡ Buy code. Codes only work for the account that made them.
  router.post('/api/ext/claim', async (req) => {
    if (!limiter.hit(`claim:${req.device.id}`, 60, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const row = repo.claimGoCode(req.user.id, str(req.body.code, 100));
    if (!row) throw new HttpError(404, 'That ⚡ Buy link has expired — press ⚡ Buy again');
    return { ok: true, productId: row.product_id, sku: row.sku, name: row.name, quantity: row.quantity, host: row.host };
  }, { auth: 'device', entitled: true });

  // Delivery details for checkout autofill.
  router.get('/api/ext/profile', async (req) => {
    if (!limiter.hit(`profile:${req.device.id}`, 120, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const profile = { ...EMPTY_PROFILE, ...(repo.getData(req.user.id, 'profile', {}) || {}) };
    if (!profile.email) profile.email = req.user.email;
    return { profile };
  }, { auth: 'device', entitled: true });

  // What happened on the store page ("added to bag", "at checkout"…).
  router.post('/api/ext/events', async (req) => {
    if (!limiter.hit(`events:${req.device.id}`, 300, 60 * 1000)) throw new HttpError(429, 'Too many events');
    const type = str(req.body.type, 20);
    if (!EVENT_TYPES[type]) throw bad('Unknown event type');
    const name = str(req.body.name, 120) || null;
    const message = str(req.body.message, 300) || type;
    const rawUrl = str(req.body.url, 1000);
    const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : null; // only web links (shown as links in the dashboard)
    const atCheckout = type === 'checkout' || type === 'ready';
    await ctx.notifier.notify(req.user.id, {
      type: 'quick', level: EVENT_TYPES[type], message: name ? `${name}: ${message}` : message, name, sku: str(req.body.sku, 60) || null, url,
      title: atCheckout ? `At checkout${name ? `: ${name}` : ''}` : null,
      channel: type === 'ready' ? 'checkout' : null,
    });
    return { ok: true };
  }, { auth: 'device' });
}
