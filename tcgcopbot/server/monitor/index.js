// Restock monitor for everyone's watchlists.
//
// Each product page is checked once per interval however many people watch
// it (so a popular product doesn't mean more requests to the store), with a
// minimum gap between requests to the same store. Requests identify
// themselves honestly as TCGCopBot. If a store refuses them, the page is
// marked "Blocked by site" and checked less often — there is no attempt to
// get around a store's bot protection.
//
// When a page becomes available, each person watching it gets their own
// alert (their dashboard, their Discord, their email) — only accounts with an
// active trial or subscription are checked and alerted.

import { extractProduct } from './extract.js';
import { BlockedUrlError, safeFetch } from './safeurl.js';
import { STATUS, STATUS_LABEL, isOrderable } from './status.js';

const ENTITLED_SQL = "(u.role = 'admin' OR u.plan IN ('active', 'comped', 'past_due') OR (u.plan = 'trial' AND u.trial_ends_at > :now))";
const MAX_BACKOFF_MS = 30 * 60 * 1000;

export class Monitor {
  constructor({ cfg, repo, notifier, hub, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    Object.assign(this, { cfg, repo, notifier, hub, fetch: fetchImpl, now });
    this.db = repo.db;
    this.hostNext = new Map();
    this.inFlight = new Set();
    this.timer = null;
    this.ticks = 0;
  }

  start() {
    if (this.timer || !this.cfg.monitor.enabled) return;
    this.timer = setInterval(() => { this.tick().catch((e) => this.cfg.log('[monitor]', e.message)); }, this.cfg.monitor.tickMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    const now = this.now();
    if (this.ticks++ % 300 === 0) {
      // Forget pages nobody watches any more.
      this.db.run('DELETE FROM page_checks WHERE NOT EXISTS (SELECT 1 FROM watch_items w WHERE w.url = page_checks.url)');
    }
    const due = this.db.all(`SELECT c.url, c.host FROM page_checks c
      WHERE c.next_check_at <= :now AND EXISTS (
        SELECT 1 FROM watch_items w JOIN users u ON u.id = w.user_id
        WHERE w.url = c.url AND w.enabled = 1 AND u.disabled = 0 AND ${ENTITLED_SQL})
      ORDER BY c.next_check_at LIMIT 25`, { now });
    const jobs = [];
    for (const page of due) {
      if (this.inFlight.has(page.url) || this.inFlight.size >= 4) continue;
      if ((this.hostNext.get(page.host) || 0) > now) continue;
      this.hostNext.set(page.host, now + this.cfg.monitor.hostGapSeconds * 1000);
      this.inFlight.add(page.url);
      jobs.push(this.checkPage(page.url).finally(() => this.inFlight.delete(page.url)));
    }
    await Promise.all(jobs);
    return jobs.length;
  }

  /** Read the page's stock status (Shopify's product JSON first, if it's a Shopify link). */
  async read(url) {
    const headers = { 'user-agent': this.cfg.monitor.userAgent, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'en-AU,en;q=0.9' };
    const signal = () => AbortSignal.timeout(this.cfg.monitor.timeoutMs);
    const get = (target) => safeFetch(this.fetch, target, { headers, signal: signal() }, { allowPrivate: this.cfg.monitor.allowPrivateHosts });
    const u = new URL(url);
    if (/\/products\/[^/]+\/?$/.test(u.pathname)) {
      try {
        const res = await get(`${u.origin}${u.pathname.replace(/\/$/, '')}.js`);
        if (res.ok && /json|javascript/.test(res.headers.get('content-type') || '')) {
          const p = await res.json();
          if (p && Array.isArray(p.variants)) {
            const avail = p.variants.some((v) => v.available);
            const v = p.variants.find((x) => x.available) || p.variants[0];
            return { status: avail ? STATUS.IN_STOCK : STATUS.OUT_OF_STOCK, title: p.title || null, price: v && typeof v.price === 'number' ? v.price / 100 : null, decidedBy: 'shopify-json' };
          }
        }
      } catch (e) {
        if (e instanceof BlockedUrlError) throw e;
        /* fall back to the page */
      }
    }
    const res = await get(url);
    if (res.status === 404 || res.status === 410) return { status: STATUS.NOT_FOUND };
    if (res.status === 403 || res.status === 429 || res.status === 503) return { status: STATUS.BLOCKED, error: `The store refused the check (HTTP ${res.status})` };
    if (!res.ok) return { status: STATUS.ERROR, error: `HTTP ${res.status}` };
    const html = (await res.text()).slice(0, 3_000_000);
    const r = extractProduct(html, { url });
    return { status: r.status, title: r.title, price: r.price, decidedBy: r.decidedBy, error: r.blocked ? 'The store showed a bot check instead of the page' : '' };
  }

  async checkPage(url) {
    const prev = this.db.get('SELECT * FROM page_checks WHERE url = :url', { url });
    if (!prev) return null;
    let r;
    try {
      r = await this.read(url);
    } catch (e) {
      r = { status: STATUS.ERROR, error: e instanceof BlockedUrlError ? e.message : e.name === 'TimeoutError' ? 'The store took too long to answer' : "Couldn't reach the store" };
    }
    const now = this.now();
    const failed = r.status === STATUS.BLOCKED || r.status === STATUS.ERROR;
    const failCount = failed ? prev.fail_count + 1 : 0;
    const interval = this.cfg.monitor.urlIntervalSeconds * 1000;
    const next = now + (failed ? Math.min(MAX_BACKOFF_MS, interval * 2 ** Math.min(failCount, 6)) : interval);
    // A failed check keeps the last known stock status (so a block doesn't look like a restock later).
    const status = failed && prev.status && prev.status !== STATUS.BLOCKED && prev.status !== STATUS.ERROR && failCount < 3 ? prev.status : r.status;
    this.db.run(`UPDATE page_checks SET status = :status, title = COALESCE(:title, title), price = COALESCE(:price, price), signals = :sig,
      checked_at = :now, next_check_at = :next, fail_count = :fails, error = :err WHERE url = :url`,
    { url, status, title: r.title || null, price: r.price ?? null, sig: r.decidedBy || null, now, next, fails: failCount, err: r.error || '' });

    const changed = status !== prev.status;
    if (changed || failed !== !!prev.error) {
      const watchers = this.db.all('SELECT DISTINCT user_id FROM watch_items WHERE url = :url', { url });
      for (const w of watchers) this.hub.publish(w.user_id, 'watch', { url, status, title: r.title || prev.title, price: r.price ?? prev.price, checkedAt: now, error: r.error || '' });
    }
    if (isOrderable(status) && !isOrderable(prev.status)) await this.alertWatchers(url, status, r.title || prev.title, r.price ?? prev.price);
    return { status, previous: prev.status };
  }

  async alertWatchers(url, status, title, price) {
    const now = this.now();
    const items = this.db.all(`SELECT w.* FROM watch_items w JOIN users u ON u.id = w.user_id
      WHERE w.url = :url AND w.enabled = 1 AND u.disabled = 0 AND ${ENTITLED_SQL}`, { url, now });
    for (const w of items) {
      if (w.max_price !== null && price !== null && price !== undefined && price > w.max_price) {
        this.repo.addEvent(w.user_id, { type: 'restock', level: 'info', message: `${w.name} is ${STATUS_LABEL[status].toLowerCase()} but $${price.toFixed(2)} is over your limit of $${w.max_price.toFixed(2)}`, name: w.name, url });
        continue;
      }
      this.db.run('UPDATE watch_items SET last_alert_at = :now WHERE id = :id', { now, id: w.id });
      const priceText = typeof price === 'number' ? ` — $${price.toFixed(2)}` : '';
      await this.notifier.notify(w.user_id, {
        type: 'restock', level: 'urgent', channel: 'restock',
        title: `${STATUS_LABEL[status]}: ${w.name}`,
        message: `${title || w.name}${priceText}`,
        name: w.name, url,
      });
    }
  }
}
