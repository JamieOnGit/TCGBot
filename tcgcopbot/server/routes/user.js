// The signed-in user's own data: Quick Checkout list, delivery details,
// watchlist, alert settings, activity and connected browsers. Every handler
// reads req.user.id — there is no parameter that could point at someone else.

import { entitlement } from '../billing.js';
import { EXTENSION_VERSION } from '../extension.js';
import { STARTER_PRODUCTS } from '../presets.js';
import { DEFAULT_ALERTS, EMPTY_PROFILE, HttpError, alerts as checkAlerts, bad, num, product as checkProduct, profile as checkProfile, watchItem as checkWatch } from '../schema.js';
import { STORES, storeName } from '../stores.js';
import { publicUser } from './auth.js';

const notFound = (what) => new HttpError(404, `${what} not found`);
const withStore = (p) => p && { ...p, store: storeName(p.url) };

export function register(router, ctx) {
  const { cfg, repo, limiter } = ctx;

  router.get('/api/me', async (req) => ({
    user: publicUser(req.user),
    entitlement: entitlement(req.user, repo.now()),
    app: {
      name: cfg.appName,
      price: cfg.priceDisplay,
      trialDays: cfg.trialDays,
      billing: ctx.billing.configured,
      email: ctx.mailer.configured,
      supportEmail: cfg.supportEmail,
      stores: STORES.map((s) => s.name),
      limits: cfg.limits,
      extensionVersion: EXTENSION_VERSION,
      chromeStoreUrl: cfg.chromeStoreUrl,
      monitorIntervalSeconds: cfg.monitor.urlIntervalSeconds,
    },
  }));

  // --- Quick Checkout --------------------------------------------------------
  router.get('/api/products', async (req) => ({ products: repo.listProducts(req.user.id).map(withStore) }));

  router.post('/api/products', async (req) => {
    if (repo.countProducts(req.user.id) >= cfg.limits.products) throw bad(`You can have up to ${cfg.limits.products} products`);
    return withStore(repo.addProduct(req.user.id, checkProduct(req.body)));
  });

  router.put('/api/products/:id', async (req) => {
    const existing = repo.getProduct(req.user.id, req.params.id);
    if (!existing) throw notFound('Product');
    return withStore(repo.updateProduct(req.user.id, existing.id, checkProduct(req.body, existing)));
  });

  router.delete('/api/products/:id', async (req) => {
    if (!repo.deleteProduct(req.user.id, req.params.id)) throw notFound('Product');
    return { ok: true };
  });

  router.post('/api/products/reorder', async (req) => {
    if (!Array.isArray(req.body.ids)) throw bad('ids must be a list');
    return { products: repo.reorderProducts(req.user.id, req.body.ids.slice(0, 500)).map(withStore) };
  });

  router.post('/api/products/starter', async (req) => {
    const have = new Set(repo.listProducts(req.user.id).map((p) => p.sku));
    let added = 0;
    for (const p of STARTER_PRODUCTS) {
      if (have.has(p.sku) || repo.countProducts(req.user.id) >= cfg.limits.products) continue;
      repo.addProduct(req.user.id, checkProduct(p));
      added += 1;
    }
    return { added, products: repo.listProducts(req.user.id).map(withStore) };
  });

  // ⚡ Buy: a one-time code the extension redeems on the product page.
  router.post('/api/products/:id/go', async (req) => {
    if (!limiter.hit(`go:${req.user.id}`, 60, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const p = repo.getProduct(req.user.id, req.params.id);
    if (!p) throw notFound('Product');
    const quantity = num(req.body.quantity, { min: 1, max: 10, int: true, def: p.quantity });
    const saved = quantity !== p.quantity ? repo.updateProduct(req.user.id, p.id, { ...p, quantity }) : p;
    const code = repo.createGoCode(req.user.id, saved, quantity);
    return { url: `${saved.url}#tcb-go=${code}`, quantity, product: withStore(saved) };
  }, { entitled: true });

  // --- Delivery details (encrypted with this user's key) ---------------------
  router.get('/api/profile', async (req) => ({ profile: { ...EMPTY_PROFILE, ...(repo.getData(req.user.id, 'profile', {}) || {}) } }));

  router.put('/api/profile', async (req) => {
    const profile = repo.setData(req.user.id, 'profile', checkProfile(req.body));
    return { profile };
  });

  // --- Alerts ---------------------------------------------------------------
  router.get('/api/alerts', async (req) => ({ alerts: { ...DEFAULT_ALERTS, ...(repo.getData(req.user.id, 'alerts', {}) || {}) } }));

  router.put('/api/alerts', async (req) => {
    const current = repo.getData(req.user.id, 'alerts', DEFAULT_ALERTS) || DEFAULT_ALERTS;
    return { alerts: repo.setData(req.user.id, 'alerts', checkAlerts(req.body, current)) };
  });

  router.post('/api/alerts/test', async (req) => {
    if (!limiter.hit(`alert-test:${req.user.id}`, 5, 10 * 60 * 1000)) throw new HttpError(429, 'You can send 5 test alerts every 10 minutes');
    await ctx.notifier.notify(req.user.id, {
      type: 'test', level: 'urgent', channel: 'restock',
      title: 'Test alert', message: `This is how ${cfg.appName} alerts look. You're all set!`, url: `${cfg.baseUrl}/app`,
    });
    return { ok: true };
  });

  // --- Watchlist ------------------------------------------------------------
  router.get('/api/watch', async (req) => ({ items: repo.listWatch(req.user.id).map(withStore), active: entitlement(req.user, repo.now()).active }));

  router.post('/api/watch', async (req) => {
    if (repo.countWatch(req.user.id) >= cfg.limits.watchItems) throw bad(`You can watch up to ${cfg.limits.watchItems} products`);
    return withStore(repo.addWatch(req.user.id, checkWatch(req.body)));
  });

  router.put('/api/watch/:id', async (req) => {
    const existing = repo.getWatch(req.user.id, req.params.id);
    if (!existing) throw notFound('Watch item');
    return withStore(repo.updateWatch(req.user.id, existing.id, checkWatch(req.body, existing)));
  });

  router.delete('/api/watch/:id', async (req) => {
    if (!repo.deleteWatch(req.user.id, req.params.id)) throw notFound('Watch item');
    return { ok: true };
  });

  router.post('/api/watch/:id/quick', async (req) => {
    const w = repo.getWatch(req.user.id, req.params.id);
    if (!w) throw notFound('Watch item');
    const existing = repo.listProducts(req.user.id).find((p) => p.url === w.url);
    if (existing) return withStore(existing);
    if (repo.countProducts(req.user.id) >= cfg.limits.products) throw bad(`You can have up to ${cfg.limits.products} products`);
    return withStore(repo.addProduct(req.user.id, checkProduct({ url: w.url, name: w.name, price: w.price, sku: req.body.sku })));
  });

  // --- Activity -------------------------------------------------------------
  router.get('/api/events', async (req) => ({
    events: repo.listEvents(req.user.id, { limit: num(req.query.get('limit'), { min: 1, max: 500, def: 100, int: true }), beforeId: num(req.query.get('before'), { int: true, def: null }) }),
  }));

  router.get('/api/stream', async (req, res) => {
    ctx.hub.subscribe(req.user.id, req, res);
    return { $handled: true };
  });

  // --- Connected browsers (the extension) -----------------------------------
  router.get('/api/devices', async (req) => ({ devices: repo.listDevices(req.user.id) }));

  router.post('/api/devices/pair-code', async (req) => {
    if (!limiter.hit(`paircode:${req.user.id}`, 20, 60 * 60 * 1000)) throw new HttpError(429, 'Too many codes — try again later');
    return repo.createPairCode(req.user.id);
  });

  router.delete('/api/devices/:id', async (req) => {
    if (!repo.deleteDevice(req.user.id, req.params.id)) throw notFound('Browser');
    return { ok: true };
  });
}
