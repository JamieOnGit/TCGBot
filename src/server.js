// Local dashboard server: static UI + JSON API + live updates (Server-Sent Events).
// Listens on 127.0.0.1 only. State-changing requests must carry the
// X-TCGBot header (which other websites can't send cross-origin) and the
// Host header must be localhost — so no other site can drive your bot.

import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError } from './schema.js';
import { listRetailers, detectRetailer, retailerForItem } from './retailers/index.js';
import { rankHits, searchQueryFor } from './match.js';
import { STATUS_LABEL } from './status.js';
import { PRESETS } from './presets.js';
import { bookmarkletHref, EXTENSION_DIR } from './bookmarklet.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, 'Request too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export function itemView(app, item) {
  const r = retailerForItem(item);
  return { ...item, retailerName: r ? r.name : item.retailer, rt: app.engine.snapshot(item.id) };
}

export function fullState(app) {
  return {
    engine: app.engine.status(),
    settings: app.store.settings,
    profile: app.store.profile,
    vault: app.vault.summary(),
    browser: { open: app.browser.isOpen() },
    retailers: listRetailers().map((r) => r.toJSON()),
    presets: PRESETS,
    statusLabels: STATUS_LABEL,
    items: app.store.items.map((i) => itemView(app, i)),
    quick: quickView(app),
    log: app.bus.recent(200),
  };
}

const EXTENSION_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8')).version; } catch { return null; }
})();

export function quickView(app) {
  const p = app.store.profile;
  return {
    rev: app.store.quick.rev,
    extensionPath: EXTENSION_DIR,
    extensionVersion: EXTENSION_VERSION,
    autofill: {
      profileReady: !!(p.email && p.firstName && p.address1 && p.suburb && p.state && p.postcode),
      cardSaved: app.vault.exists(),
      cardUnlocked: app.vault.unlocked,
    },
    products: app.store.quick.products.map((p) => {
      const d = detectRetailer(p.url);
      return { ...p, store: d ? d.name : '' };
    }),
  };
}

const QUICK_EVENT_TYPES = new Set(['add', 'basket', 'checkout', 'error']);

/**
 * @param {{app: object, port?: number, host?: string}} opts
 * app = {store, engine, bus, notifier, vault, browser, fetcher, dataDir}
 */
export function createServer({ app, port = 8787, host = '127.0.0.1' }) {
  const clients = new Set();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  const onLog = (e) => broadcast('log', e);
  const onAlert = (a) => broadcast('alert', a);
  const onItem = (snap) => {
    const item = app.store.getItem(snap.id);
    if (item) broadcast('item', itemView(app, item));
  };
  const onEngine = (s) => broadcast('engine', s);
  const onStore = (what, info) => { if (!info?.quiet) broadcast('refresh', { what }); };
  app.bus.on('log', onLog);
  app.bus.on('alert', onAlert);
  app.engine.on('item', onItem);
  app.engine.on('engine', onEngine);
  app.store.on('change', onStore);

  const allowedHosts = () => new Set([`127.0.0.1:${server.address()?.port}`, `localhost:${server.address()?.port}`, `[::1]:${server.address()?.port}`]);

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };

  const requireItem = (id) => {
    const item = app.store.getItem(id);
    if (!item) throw new HttpError(404, 'Item not found');
    return item;
  };

  // --- API -----------------------------------------------------------------
  route('GET', '/api/state', () => fullState(app));
  route('GET', '/api/detect', (req, params, url) => detectRetailer(url.searchParams.get('url') || '') || { retailer: null });

  route('POST', '/api/items', async (req) => {
    const body = await readJson(req);
    const retailers = Array.isArray(body.retailers) && body.retailers.length ? body.retailers : [body.retailer];
    const group = retailers.length > 1 ? (body.group || `g${Date.now().toString(36)}`) : (body.group || '');
    const created = [];
    for (const r of retailers) {
      created.push(app.store.addItem({ ...body, retailer: r, group, retailers: undefined }));
    }
    return { items: created.map((i) => itemView(app, i)) };
  });
  route('PUT', '/api/items/:id', async (req, { id }) => {
    requireItem(id);
    const body = await readJson(req);
    return itemView(app, app.store.updateItem(id, body));
  });
  route('DELETE', '/api/items/:id', (req, { id }) => {
    app.store.removeItem(id);
    return { ok: true };
  });
  route('POST', '/api/items/:id/check', async (req, { id }) => {
    const item = requireItem(id);
    const snap = await app.engine.checkItem(item);
    return { item: itemView(app, item), result: snap.result };
  });
  route('POST', '/api/items/:id/go', (req, { id }) => {
    requireItem(id);
    // Runs in the background; progress arrives over /api/events.
    app.engine.goNow(id).catch((e) => app.bus.log('error', `Go failed: ${e.message}`, { itemId: id }));
    return { ok: true };
  });
  route('POST', '/api/items/:id/reset', async (req, { id }) => {
    requireItem(id);
    const body = await readJson(req);
    app.engine.reset(id, { forgetListing: !!body.forgetListing });
    return itemView(app, app.store.getItem(id));
  });
  route('POST', '/api/items/:id/open', async (req, { id }) => {
    const item = requireItem(id);
    const snap = app.engine.snapshot(id);
    const target = snap.url || item.url || item.resolvedUrl;
    if (!target) throw new HttpError(400, 'No product page found yet for this item');
    await app.browser.open(target);
    return { ok: true };
  });

  // --- Quick Checkout (browser extension + bookmark button) -------------------
  route('GET', '/api/quick', () => quickView(app));
  // Read by the TCGBot browser extension to stay in sync with the dashboard.
  route('GET', '/api/quick/products', () => ({ rev: app.store.quick.rev, products: app.store.quick.products }));
  const withSku = (body) => {
    if (body.url && !body.sku) {
      const d = detectRetailer(body.url);
      if (d && d.sku) return { ...body, sku: d.sku };
    }
    return body;
  };
  route('GET', '/api/quick/bookmarklet', () => {
    const href = bookmarkletHref(app.store.quick.products);
    return { href, rev: app.store.quick.rev, bytes: href.length };
  });
  route('POST', '/api/quick/products', async (req) => app.store.addQuickProduct(withSku(await readJson(req))));
  route('PUT', '/api/quick/products/:id', async (req, { id }) => {
    if (!app.store.getQuickProduct(id)) throw new HttpError(404, 'Product not found');
    return app.store.updateQuickProduct(id, withSku(await readJson(req)));
  });
  route('DELETE', '/api/quick/products/:id', (req, { id }) => {
    app.store.removeQuickProduct(id);
    return { ok: true };
  });
  route('POST', '/api/quick/reorder', async (req) => {
    const body = await readJson(req);
    if (!Array.isArray(body.ids)) throw new HttpError(400, 'ids must be a list');
    app.store.reorderQuick(body.ids.map(String));
    return quickView(app);
  });
  // "⚡ Buy" in the dashboard: open the product with a one-time code that the
  // extension redeems (once, within 2 minutes) to start Add to Bag → Checkout.
  const goCodes = new Map();
  const GO_TTL_MS = 2 * 60 * 1000;
  route('POST', '/api/quick/go', async (req) => {
    const body = await readJson(req);
    let product = app.store.getQuickProduct(String(body.id || ''));
    if (!product) throw new HttpError(404, 'Product not found');
    if (body.quantity !== undefined && Number(body.quantity) !== product.quantity) {
      product = app.store.updateQuickProduct(product.id, { quantity: body.quantity });
    }
    const now = Date.now();
    for (const [c, v] of goCodes) if (now - v.created > GO_TTL_MS) goCodes.delete(c);
    const code = crypto.randomBytes(12).toString('base64url');
    goCodes.set(code, { id: product.id, sku: product.sku, name: product.name, quantity: product.quantity, created: now });
    const u = new URL(product.url);
    u.hash = `tcgbot-go=${code}`;
    app.bus.log('info', `[Quick Checkout] ${product.name}: ⚡ Buy pressed (quantity ${product.quantity})`);
    return { url: u.href, quantity: product.quantity };
  });
  // Autofill passes: let the extension fetch your profile/card for one store's
  // checkout, for 15 minutes. Issued only for a redeemed ⚡ Buy code, or when
  // the extension asks after you pressed its panel button.
  const fillPasses = new Map();
  const FILL_TTL_MS = 15 * 60 * 1000;
  const newFillPass = (host) => {
    const now = Date.now();
    for (const [t, v] of fillPasses) if (now - v.created > FILL_TTL_MS) fillPasses.delete(t);
    const token = crypto.randomBytes(18).toString('base64url');
    fillPasses.set(token, { host, created: now, uses: 0, logged: false });
    return token;
  };
  route('POST', '/api/quick/claim', async (req) => {
    const body = await readJson(req);
    const entry = goCodes.get(String(body.code || ''));
    goCodes.delete(String(body.code || ''));
    if (!entry || Date.now() - entry.created > GO_TTL_MS) throw new HttpError(404, 'Unknown or expired code');
    const product = app.store.getQuickProduct(entry.id);
    const host = product ? new URL(product.url).host : '';
    return { ok: true, sku: entry.sku, name: entry.name, quantity: entry.quantity, fillToken: newFillPass(host), host };
  });
  route('POST', '/api/quick/fill-token', async (req) => {
    const body = await readJson(req);
    const host = String(body.host || '').slice(0, 200);
    if (!host) throw new HttpError(400, 'host required');
    return { fillToken: newFillPass(host), host };
  });
  route('POST', '/api/quick/fill', async (req) => {
    const body = await readJson(req);
    const pass = fillPasses.get(String(body.token || ''));
    if (!pass || Date.now() - pass.created > FILL_TTL_MS || pass.uses >= 80) throw new HttpError(403, 'Autofill pass expired — press ⚡ Buy again');
    pass.uses += 1;
    if (!pass.logged) {
      pass.logged = true;
      app.bus.log('info', `[Quick Checkout] Sent your saved details to the extension to fill in checkout${pass.host ? ` on ${pass.host}` : ''}${app.vault.unlocked ? ' (card included)' : ' (card locked — not included)'}.`);
    }
    const c = app.vault.card;
    return {
      profile: app.store.profile,
      card: c ? { number: c.number, name: c.name, expMonth: c.expMonth, expYear: c.expYear, cvc: c.cvc || '' } : null,
      cardLocked: !c && app.vault.exists(),
    };
  });

  let quickEvents = [];
  route('POST', '/api/quick/events', async (req) => {
    const body = await readJson(req);
    const now = Date.now();
    quickEvents = quickEvents.filter((t) => now - t < 60000);
    if (quickEvents.length >= 300) throw new HttpError(429, 'Too many events');
    quickEvents.push(now);
    const type = String(body.type || '');
    if (!QUICK_EVENT_TYPES.has(type)) throw new HttpError(400, 'Unknown event type');
    const name = String(body.name || body.sku || 'product').slice(0, 120);
    const message = String(body.message || '').slice(0, 200);
    const url = /^https?:\/\//i.test(String(body.url || '')) ? String(body.url).slice(0, 500) : undefined;
    if (type === 'checkout') {
      app.notifier.alert({ level: 'urgent', title: `At checkout: ${name}`, message: `Quick Checkout — ${message}. Finish the purchase in your browser.`, url });
    } else if (type === 'error') {
      app.notifier.alert({ level: 'warning', title: `Quick Checkout: ${name}`, message, url });
    } else {
      app.bus.log('info', `[Quick Checkout] ${name}: ${message}`);
    }
    return { ok: true };
  });

  route('POST', '/api/start', () => app.engine.start());
  route('POST', '/api/stop', () => app.engine.stop());

  route('PUT', '/api/settings', async (req) => app.store.setSettings(await readJson(req)));
  route('PUT', '/api/profile', async (req) => app.store.setProfile(await readJson(req)));

  route('POST', '/api/vault', async (req) => {
    const body = await readJson(req);
    try {
      return await app.vault.save(body.passphrase, body.card || {});
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  });
  route('POST', '/api/vault/unlock', async (req) => {
    const body = await readJson(req);
    try {
      return await app.vault.unlock(body.passphrase || '');
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  });
  route('POST', '/api/vault/lock', () => app.vault.lock());
  route('DELETE', '/api/vault', () => app.vault.remove());

  route('POST', '/api/browser/open', async (req) => {
    const body = await readJson(req);
    let target = body.url;
    if (!target && body.retailer) {
      const r = listRetailers().find((x) => x.id === body.retailer);
      if (!r) throw new HttpError(404, 'Unknown retailer');
      target = r.loginUrl();
    }
    if (target && !/^https?:\/\//i.test(target)) throw new HttpError(400, 'Invalid URL');
    if (target) await app.browser.open(target);
    else await app.browser.context();
    return { ok: true };
  });
  route('POST', '/api/browser/close', async () => {
    await app.browser.close();
    return { ok: true };
  });

  route('POST', '/api/test-alert', async () => {
    app.notifier.alert({ level: 'urgent', title: 'Test alert from TCGBot', message: 'If you can see/hear this, alerts are working.' });
    const discord = app.store.settings.discordWebhook ? await app.notifier.sendDiscord({ level: 'info', title: 'TCGBot Discord test', message: 'Discord alerts are working.', ts: Date.now() }) : { ok: false, reason: 'no webhook set' };
    return { ok: true, discord };
  });

  // Diagnostics: what does the bot see on this page / in this search?
  route('POST', '/api/probe', async (req) => {
    const body = await readJson(req);
    const det = body.retailer ? { retailer: body.retailer, domain: body.domain } : detectRetailer(body.url || '');
    if (!det || !det.retailer) throw new HttpError(400, 'Paste a product link');
    const item = { id: 'probe', name: 'probe', retailer: det.retailer, domain: det.domain || body.domain || '', url: body.url, sku: body.sku || '', method: body.method || 'auto' };
    const retailer = retailerForItem(item);
    if (!retailer) throw new HttpError(400, 'Unknown retailer for that link');
    const t0 = Date.now();
    const result = await retailer.check(body.url, app.engine.fetchCtx(item, retailer), item);
    return { retailer: retailer.name, ms: Date.now() - t0, statusLabel: STATUS_LABEL[result.status], ...result };
  });
  route('POST', '/api/search-test', async (req) => {
    const body = await readJson(req);
    const item = { id: 'probe', retailer: body.retailer, domain: body.domain || '', method: body.method || 'auto' };
    const retailer = retailerForItem(item);
    if (!retailer) throw new HttpError(400, 'Unknown retailer');
    const q = body.searchQuery || searchQueryFor(body.keywords || '');
    if (!q) throw new HttpError(400, 'Enter keywords first');
    const t0 = Date.now();
    const hits = await retailer.search(q, app.engine.fetchCtx(item, retailer));
    const ranked = rankHits(hits, body.keywords || q, body.exclude || '');
    return { retailer: retailer.name, query: q, ms: Date.now() - t0, total: hits.length, matches: ranked.slice(0, 10), sample: hits.slice(0, 10) };
  });

  // --- HTTP plumbing ---------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
      if (!allowedHosts().has(String(req.headers.host || '').toLowerCase())) throw new HttpError(403, 'Forbidden host');

      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
        clients.add(res);
        const hb = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clearInterval(hb); clients.delete(res); });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.headers['x-tcgbot'] !== '1') throw new HttpError(403, 'Missing X-TCGBot header');
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.re);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const out = await r.handler(req, params, url);
          return send(res, 200, out);
        }
        throw new HttpError(404, 'Not found');
      }

      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      if (url.pathname.startsWith('/screenshots/')) {
        const name = path.basename(url.pathname);
        const file = path.join(app.dataDir, 'screenshots', name);
        if (!/^[\w.-]+\.png$/.test(name) || !fs.existsSync(file)) throw new HttpError(404, 'Not found');
        return send(res, 200, fs.readFileSync(file), { 'content-type': 'image/png' });
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(PUBLIC_DIR, path.normalize(rel));
      if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Not found');
      return send(res, 200, fs.readFileSync(file), {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'content-security-policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
      });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof ValidationError ? 400 : 500;
      if (status === 500) app.bus.log('error', `API error on ${req.method} ${url?.pathname}: ${e.message}`);
      if (!res.headersSent) send(res, status, { error: e.message });
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const actual = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        close: () => new Promise((r) => {
          app.bus.off('log', onLog);
          app.bus.off('alert', onAlert);
          app.engine.off('item', onItem);
          app.engine.off('engine', onEngine);
          app.store.off('change', onStore);
          for (const c of clients) c.end();
          clients.clear();
          server.close(() => r());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}
