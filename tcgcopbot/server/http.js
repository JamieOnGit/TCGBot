// A small HTTP toolkit: routing, JSON bodies, cookies, static files, rate
// limits and security headers. No framework, no dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './schema.js';

export class Router {
  constructor() {
    this.routes = [];
  }

  /**
   * opts.auth: 'user' (signed-in browser) | 'admin' | 'device' (extension token) | 'none'
   * opts.entitled: needs an active trial or subscription
   * opts.raw: keep the body as a Buffer (Stripe webhooks)
   */
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })}/?$`);
    this.routes.push({ method, re, keys, handler, opts });
  }

  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  put(p, h, o) { this.add('PUT', p, h, o); }
  delete(p, h, o) { this.add('DELETE', p, h, o); }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = pathname.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch { params[k] = m[i + 1]; } });
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request is too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseJson(buf) {
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

export function cookie(name, value, { maxAge = null, secure = false, httpOnly = true, sameSite = 'Lax', path: p = '/' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${p}`, `SameSite=${sameSite}`];
  if (httpOnly) bits.push('HttpOnly');
  if (secure) bits.push('Secure');
  if (maxAge !== null) bits.push(`Max-Age=${Math.floor(maxAge)}`);
  return bits.join('; ');
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fly = req.headers['fly-client-ip'];
    if (fly) return String(fly);
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || '';
}

export function securityHeaders(cfg) {
  const h = {
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin-allow-popups',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
  if (cfg.secureCookies) h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.zip': 'application/zip',
};

/** Serve a file from `root` (no directory escapes). Returns false if not found. */
export function sendFile(req, res, root, rel, { cache = 'public, max-age=300' } = {}) {
  const file = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
  if (!file.startsWith(path.resolve(root) + path.sep)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-length': stat.size, 'cache-control': cache });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
  return true;
}

/** Fixed-window counters, e.g. "10 login attempts per 15 minutes per IP". */
export class RateLimiter {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.hits = new Map();
    this.sweepAt = 0;
  }

  /** Count one hit; true if still within the limit. */
  hit(key, limit, windowMs) {
    const t = this.now();
    if (t > this.sweepAt) {
      for (const [k, v] of this.hits) if (v.reset < t) this.hits.delete(k);
      this.sweepAt = t + 60000;
    }
    let e = this.hits.get(key);
    if (!e || e.reset < t) {
      e = { n: 0, reset: t + windowMs };
      this.hits.set(key, e);
    }
    e.n += 1;
    return e.n <= limit;
  }

  peek(key) {
    const e = this.hits.get(key);
    return e && e.reset >= this.now() ? e.n : 0;
  }

  clear(key) {
    this.hits.delete(key);
  }
}
