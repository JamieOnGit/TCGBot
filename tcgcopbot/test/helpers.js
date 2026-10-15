// Test helpers: a throwaway server with its own database, a browser-like
// API client with a cookie jar, a fake Stripe, and captured Discord messages.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';

export const PASSWORD = 'correct horse battery staple';

/** A fake Stripe API that records what it was asked. */
export async function startFakeStripe() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(body));
      calls.push({ method: req.method, path: req.url, params, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/checkout/sessions') return res.end(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.test/pay/cs_test_1' }));
      if (req.url === '/v1/billing_portal/sessions') return res.end(JSON.stringify({ id: 'bps_1', url: 'https://billing.stripe.test/session/bps_1' }));
      if (req.method === 'DELETE' && req.url.startsWith('/v1/subscriptions/')) return res.end(JSON.stringify({ id: req.url.split('/').pop(), status: 'canceled' }));
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: { message: 'unknown' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

export function stripeSignature(secret, payload, t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

/**
 * Start a server for one test file. opts are config overrides.
 * Returns { app, url, outbox, discord, stripe?, close() }.
 */
export async function startApp(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgcopbot-test-'));
  const outbox = [];
  const discord = [];
  // Outbound requests: Discord is captured; everything else (fake Stripe, fake store) goes through.
  const fetchImpl = async (url, init = {}) => {
    if (/^https:\/\/(discord\.com|discordapp\.com)\//.test(String(url))) {
      discord.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    return fetch(url, init);
  };
  const app = await createApp({
    databasePath: path.join(dir, 'tcgcopbot.db'),
    outbox,
    monitorEnabled: false,
    signupsPerHour: 1000,
    log: () => {},
    fetch: fetchImpl,
    ...opts,
  });
  const url = await app.listen(0, '127.0.0.1');
  return {
    app,
    url,
    dir,
    outbox,
    discord,
    async close() {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A browser-like client: keeps the session cookie and sends the dashboard's header. */
export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async call(method, p, body, headers = {}) {
    const res = await fetch(this.base + p, {
      method,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-tcgcopbot': '1', origin: this.base, ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) {
      const [pair] = c.split(';');
      const [name, value] = pair.split('=');
      this.cookie = value ? `${name}=${value}` : '';
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  get(p, h) { return this.call('GET', p, undefined, h); }
  post(p, b = {}, h) { return this.call('POST', p, b, h); }
  put(p, b = {}, h) { return this.call('PUT', p, b, h); }
  del(p, b, h) { return this.call('DELETE', p, b, h); }

  static async signup(base, email, extra = {}) {
    const c = new Client(base);
    const r = await c.post('/api/auth/signup', { email, password: PASSWORD, acceptTerms: true, ...extra });
    if (r.status !== 200) throw new Error(`signup failed: ${r.status} ${r.text}`);
    c.user = r.body.user;
    return c;
  }
}

/** The extension's view of the API: a device token instead of a cookie. */
export class Device {
  constructor(base, token) {
    this.base = base;
    this.token = token;
  }

  static async pair(base, client, name = 'Test browser') {
    const { body } = await client.post('/api/devices/pair-code');
    const res = await fetch(`${base}/api/ext/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: body.code, name }) });
    const data = await res.json();
    if (!res.ok) throw new Error(`pair failed: ${data.error}`);
    const d = new Device(base, data.token);
    d.user = data.user;
    return d;
  }

  async call(method, p, body) {
    const res = await fetch(this.base + p, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
}

export async function waitFor(fn, { timeout = 10000, interval = 100, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
