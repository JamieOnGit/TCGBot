// Fetching with per-site politeness.
//
// * Every request to the same host is spaced out by at least `minHostGapSeconds`
//   no matter how many items watch that site.
// * Plain HTTP requests identify themselves honestly (configurable in Settings).
// * If a site refuses plain requests, the "auto" method switches that site to a
//   real browser window (your normal logged-in session) instead.

import { looksBlocked } from './extract.js';

export const DEFAULT_USER_AGENT = 'TCGBot/1.0 (personal restock monitor)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HostLimiter {
  constructor() {
    this.next = new Map();
  }

  /** Wait until it is this host's turn. */
  async wait(host, gapMs) {
    const now = Date.now();
    const at = Math.max(now, this.next.get(host) || 0);
    this.next.set(host, at + Math.max(0, gapMs));
    if (at > now) await sleep(at - now);
  }

  /** Push a host's next slot back (used after 429 / blocks). */
  delay(host, ms) {
    this.next.set(host, Math.max(this.next.get(host) || 0, Date.now() + ms));
  }
}

export function isBlockedResponse(status, body) {
  if (status === 429) return true;
  if (status === 403 || status === 401) return true;
  if (status === 503 || status === 200) {
    const title = (String(body || '').match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    return looksBlocked(body, title);
  }
  return false;
}

export class Fetcher {
  /**
   * @param {{getSettings: () => object, browser?: object, log?: Function, fetchImpl?: Function}} opts
   */
  constructor({ getSettings, browser = null, log = () => {}, fetchImpl = globalThis.fetch } = {}) {
    this.getSettings = getSettings;
    this.browser = browser;
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.limiter = new HostLimiter();
    this.hostMode = new Map();
  }

  gapFor(host, retailerGap) {
    const s = this.getSettings();
    const base = Number(s.minHostGapSeconds ?? 4);
    return Math.max(base, Number(retailerGap || 0)) * 1000;
  }

  /**
   * @param {string} url
   * @param {{kind?: 'page'|'json'|'search', method?: 'auto'|'http'|'browser', minGapSeconds?: number}} opts
   */
  async fetch(url, { kind = 'page', method = 'auto', minGapSeconds = null } = {}) {
    const host = new URL(url).host;
    await this.limiter.wait(host, this.gapFor(host, minGapSeconds));
    const wantBrowser = method === 'browser' || (method === 'auto' && this.hostMode.get(host) === 'browser');
    if (wantBrowser && this.browser) return this.browser.fetchViaPage(url, { kind });

    const res = await this.httpGet(url, { kind });
    if (res.status === 429) this.limiter.delay(host, 30000);
    if (res.blocked && method === 'auto' && this.browser && (await this.browser.isAvailable())) {
      if (this.hostMode.get(host) !== 'browser') this.log('warn', `${host} refused plain requests (HTTP ${res.status}) — switching this site to the Browser method.`);
      this.hostMode.set(host, 'browser');
      return this.browser.fetchViaPage(url, { kind });
    }
    return res;
  }

  async httpGet(url, { kind = 'page' } = {}) {
    const s = this.getSettings();
    const t0 = Date.now();
    const headers = {
      'user-agent': s.userAgent || DEFAULT_USER_AGENT,
      accept: kind === 'json'
        ? 'application/json, text/javascript, */*;q=0.1'
        : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-AU,en;q=0.9',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    };
    const timeoutMs = Number(s.requestTimeoutSeconds ?? 20) * 1000;
    const resp = await this.fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const body = await resp.text();
    return {
      status: resp.status,
      url: resp.url || url,
      body,
      ms: Date.now() - t0,
      blocked: isBlockedResponse(resp.status, body),
      via: 'http',
    };
  }
}
