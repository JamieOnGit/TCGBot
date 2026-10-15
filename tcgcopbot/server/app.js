// Puts the server together: database, routes, security checks, background monitor.

import http from 'node:http';
import { Billing, entitlement } from './billing.js';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { Hub } from './hub.js';
import { Router, RateLimiter, clientIp, parseCookies, parseJson, readBody, securityHeaders, sendJson } from './http.js';
import { Mailer } from './mailer.js';
import { Monitor } from './monitor/index.js';
import { Notifier } from './notifier.js';
import { Repo } from './repo.js';
import { HttpError } from './schema.js';
import * as admin from './routes/admin.js';
import * as auth from './routes/auth.js';
import * as billingRoutes from './routes/billing.js';
import * as ext from './routes/ext.js';
import { servePage } from './routes/pages.js';
import * as user from './routes/user.js';

const UNSAFE = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * options: config overrides (see config.js), plus
 *   fetch: used for outbound requests (Stripe, email, Discord, store pages) — tests pass a fake
 *   now: clock — tests pass a fake
 */
export async function createApp(options = {}) {
  const { fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), ...overrides } = options;
  const cfg = options.cfg || loadConfig(overrides);
  const db = new Db(cfg.databasePath);
  const repo = new Repo(db, cfg, now);
  const hub = new Hub();
  const mailer = new Mailer(cfg, fetchImpl);
  const notifier = new Notifier({ cfg, repo, hub, mailer, fetchImpl });
  const billing = new Billing({ cfg, repo, notifier, fetchImpl, now });
  const monitor = new Monitor({ cfg, repo, notifier, hub, fetchImpl, now });
  const limiter = new RateLimiter(now);
  const ctx = { cfg, db, repo, hub, mailer, notifier, billing, monitor, limiter, pageCache: new Map() };

  const router = new Router();
  auth.register(router, ctx);
  user.register(router, ctx);
  ext.register(router, ctx);
  billingRoutes.register(router, ctx);
  admin.register(router, ctx);

  const headers = securityHeaders(cfg);
  const allowedOrigins = () => new Set([new URL(cfg.baseUrl).origin, ...cfg.extraOrigins]);
  const cookieName = auth.sessionCookieName(cfg);

  async function handleApi(req, res, url) {
    const m = router.match(req.method, url.pathname);
    if (!m) throw new HttpError(404, 'Not found');
    if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
    const { route, params } = m;
    const o = route.opts;
    const mode = o.auth || 'user';
    req.params = params;

    // Requests from the dashboard must come from our own pages (blocks cross-site request forgery).
    if (UNSAFE.has(req.method) && mode !== 'device' && o.csrf !== false) {
      const origin = req.headers.origin;
      if (req.headers['x-tcgcopbot'] !== '1' || (origin && !allowedOrigins().has(origin))) throw new HttpError(403, 'Request blocked (cross-site)');
    }

    if (mode === 'device') {
      const m2 = String(req.headers.authorization || '').match(/^Bearer\s+([A-Za-z0-9_-]{20,100})$/);
      const found = m2 ? repo.deviceByToken(m2[1]) : null;
      if (!found) throw new HttpError(401, 'This browser is not connected — connect it again from your dashboard');
      req.user = found.user;
      req.device = found.device;
    } else if (mode === 'user' || mode === 'admin') {
      if (!req.user) throw new HttpError(401, 'Please log in');
      if (mode === 'admin' && req.user.role !== 'admin') throw new HttpError(404, 'Not found');
    }
    if (o.entitled && !entitlement(req.user, repo.now()).active) {
      throw new HttpError(402, 'Your free trial has ended — subscribe under Billing to keep using this', { code: 'subscription_required' });
    }

    if (UNSAFE.has(req.method)) {
      const raw = await readBody(req, o.raw ? 1024 * 1024 : 64 * 1024);
      if (o.raw) req.rawBody = raw;
      else req.body = parseJson(raw);
    } else {
      req.body = {};
    }

    const out = await route.handler(req, res);
    if (out && out.$handled) return;
    if (out && out.$raw) {
      res.writeHead(200, { 'content-type': out.type, 'cache-control': 'no-store', ...(out.headers || {}), ...req.extraHeaders() });
      res.end(out.$raw);
      return;
    }
    sendJson(res, 200, out ?? { ok: true }, req.extraHeaders());
  }

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    const cookies = [];
    req.setCookie = (c) => cookies.push(c);
    req.extraHeaders = () => (cookies.length ? { 'set-cookie': cookies } : {});
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      res.writeHead(400).end();
      return;
    }
    req.query = url.searchParams;
    req.ip = clientIp(req, cfg.trustProxy);
    try {
      // Who is this? (session cookie)
      const token = parseCookies(req.headers.cookie)[cookieName];
      if (token) {
        req.sessionToken = token;
        const s = repo.sessionUser(token);
        if (s) {
          req.user = s.user;
          req.sessionHash = s.sessionHash;
        }
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (!servePage(ctx, req, res, url)) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Not found</title><p>Page not found. <a href="/">Go home</a></p>');
      }
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof HttpError) {
        sendJson(res, e.status, { error: e.message, ...e.extra }, req.extraHeaders());
      } else {
        cfg.log('[error]', req.method, url.pathname, e.stack || e.message);
        sendJson(res, 500, { error: 'Something went wrong on our side — please try again' });
      }
    }
  });
  server.headersTimeout = 20000;
  server.requestTimeout = 30000;

  const app = {
    cfg,
    ctx,
    db,
    repo,
    hub,
    monitor,
    billing,
    server,
    url: null,
    async listen(port = cfg.port, host = cfg.host) {
      await new Promise((resolve) => server.listen(port, host, resolve));
      const addr = server.address();
      app.url = `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${addr.port}`;
      if (cfg.baseUrlAuto) cfg.baseUrl = app.url;
      monitor.start();
      return app.url;
    },
    async close() {
      monitor.stop();
      hub.close();
      await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
      db.close();
    },
  };
  return app;
}
