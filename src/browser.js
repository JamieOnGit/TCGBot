// One real browser window with a persistent profile (data/browser-profile).
// You log in to each retailer in it once; cookies and saved addresses stay.
// The same window is used for checkout assist and for the "Browser" monitor
// method on sites that refuse plain requests.

import path from 'node:path';
import { looksBlocked } from './extract.js';

const BLOCKED_URL_PATTERNS = ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.mp4', '*.webm', '*.m3u8'];

export class BrowserManager {
  /**
   * @param {{dataDir: string, getSettings: () => object, bus: import('./log.js').Bus, launcher?: object}} opts
   */
  constructor({ dataDir, getSettings, bus, launcher = null }) {
    this.profileDir = path.join(dataDir, 'browser-profile');
    this.getSettings = getSettings;
    this.bus = bus;
    this.launcher = launcher; // injectable for tests: an object like playwright.chromium
    this.ctx = null;
    this.launching = null;
    this.monitorPages = new Map();
    this.hostLocks = new Map();
    this._available = null;
  }

  async playwright() {
    if (this.launcher) return this.launcher;
    try {
      const pw = await import('playwright');
      return pw.chromium;
    } catch {
      throw new Error('Playwright is not installed. Run "npm run setup" in the TCGBot folder.');
    }
  }

  async isAvailable() {
    if (this._available !== null) return this._available;
    try {
      await this.playwright();
      this._available = true;
    } catch {
      this._available = false;
    }
    return this._available;
  }

  isOpen() {
    return !!this.ctx;
  }

  async context() {
    if (this.ctx) return this.ctx;
    if (!this.launching) {
      this.launching = this._launch().finally(() => { this.launching = null; });
    }
    return this.launching;
  }

  async _launch() {
    const chromium = await this.playwright();
    const s = this.getSettings();
    const opts = {
      headless: !!s.headless,
      viewport: s.headless ? { width: 1366, height: 900 } : null,
      args: s.headless ? [] : ['--start-maximized'],
    };
    if (s.browserPath) opts.executablePath = s.browserPath;
    else if (s.browserChannel && s.browserChannel !== 'chromium') opts.channel = s.browserChannel;
    this.bus.log('info', `Opening browser (${opts.channel || (opts.executablePath ? 'custom' : 'chromium')}${opts.headless ? ', headless' : ''})…`);
    let ctx;
    try {
      ctx = await chromium.launchPersistentContext(this.profileDir, opts);
    } catch (e) {
      const hint = /Executable doesn't exist|executable/i.test(e.message)
        ? ' — run "npm run setup" (installs Chromium) or pick Chrome/Edge in Settings.'
        : /ProcessSingleton|already in use|lock/i.test(e.message) ? ' — the bot browser profile is already open in another window; close it first.' : '';
      throw new Error(`Could not start the browser: ${e.message.split('\n')[0]}${hint}`);
    }
    ctx.on('close', () => {
      this.ctx = null;
      this.monitorPages.clear();
      this.bus.log('info', 'Browser closed.');
    });
    if (s.blockImages) {
      ctx.on('page', (p) => this.applyBlocking(p));
      for (const p of ctx.pages()) this.applyBlocking(p);
    }
    this.ctx = ctx;
    return ctx;
  }

  async applyBlocking(page) {
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URL_PATTERNS });
    } catch {
      /* not Chromium, or page already closed — images just load normally */
    }
  }

  async newPage() {
    const ctx = await this.context();
    // Reuse the blank tab a fresh browser opens with.
    const blank = ctx.pages().find((p) => p.url() === 'about:blank' && !this.isMonitorPage(p) && !p.__tcgUsed);
    const page = blank || (await ctx.newPage());
    page.__tcgUsed = true;
    return page;
  }

  isMonitorPage(p) {
    for (const mp of this.monitorPages.values()) if (mp === p) return true;
    return false;
  }

  async open(url) {
    const page = await this.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    return page;
  }

  async withHostLock(host, fn) {
    const prev = this.hostLocks.get(host) || Promise.resolve();
    let release;
    const next = new Promise((r) => { release = r; });
    this.hostLocks.set(host, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Load a URL in a real browser tab (one reusable tab per site) and return its HTML. */
  async fetchViaPage(url, { kind = 'page' } = {}) {
    const ctx = await this.context();
    const u = new URL(url);
    return this.withHostLock(u.host, async () => {
      let page = this.monitorPages.get(u.host);
      if (!page || page.isClosed()) {
        page = await ctx.newPage();
        page.__tcgUsed = true;
        this.monitorPages.set(u.host, page);
      }
      const t0 = Date.now();
      if (kind === 'json') {
        if (!page.url().startsWith(u.origin)) await page.goto(`${u.origin}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const r = await page.evaluate(async (target) => {
          const res = await fetch(target, { credentials: 'include', headers: { accept: 'application/json' } });
          return { status: res.status, url: res.url, body: await res.text() };
        }, url);
        return { ...r, ms: Date.now() - t0, blocked: r.status === 403 || r.status === 429, via: 'browser' };
      }
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Client-rendered sites fill in the buy box after load: wait (briefly) for it.
      await page.waitForFunction(() => {
        if (document.querySelector('script[type="application/ld+json"]')) return true;
        const t = document.body ? document.body.innerText : '';
        return /add to (cart|bag|basket|trolley)|pre-?order|sold out|out of stock|notify me|coming soon|unavailable/i.test(t);
      }, null, { timeout: 6000, polling: 250 }).catch(() => {});
      const body = await page.content();
      const title = await page.title().catch(() => '');
      const status = resp ? resp.status() : 200;
      return { status, url: page.url(), body, ms: Date.now() - t0, blocked: status === 403 || status === 429 || looksBlocked(body, title), via: 'browser' };
    });
  }

  async close() {
    const ctx = this.ctx;
    this.ctx = null;
    this.monitorPages.clear();
    if (ctx) await ctx.close().catch(() => {});
  }
}
