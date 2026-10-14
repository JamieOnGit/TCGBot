// The monitor: checks every enabled watch item on its own schedule, finds
// listings for products that aren't listed yet, notices restocks/pre-order
// openings, and fires the configured action exactly once per restock.

import { EventEmitter } from 'node:events';
import { STATUS, STATUS_LABEL, isOrderable } from './status.js';
import { rankHits, searchQueryFor } from './match.js';
import { retailerForItem, BlockedError } from './retailers/index.js';

const MAX_BACKOFF_MS = 5 * 60 * 1000;

function money(p) {
  return typeof p === 'number' ? `$${p.toFixed(2)}` : null;
}

export class Engine extends EventEmitter {
  /**
   * @param {{store, bus, notifier, fetcher, assist?, retailerFor?: Function}} deps
   */
  constructor({ store, bus, notifier, fetcher, assist = null, retailerFor = retailerForItem }) {
    super();
    this.store = store;
    this.bus = bus;
    this.notifier = notifier;
    this.fetcher = fetcher;
    this.assist = assist;
    this.retailerFor = retailerFor;
    this.running = false;
    this.timers = new Map();
    this.inflight = new Map();
    this.rt = new Map();
    this.store.on('change', (what, info) => this.onStoreChange(what, info));
  }

  // ---------------------------------------------------------------------------
  // Runtime state
  // ---------------------------------------------------------------------------

  runtime(id) {
    if (!this.rt.has(id)) {
      this.rt.set(id, {
        status: STATUS.UNKNOWN, title: null, price: null, url: null, variantId: null, lastChecked: null, lastChange: null,
        checks: 0, errors: 0, error: null, signals: [], decidedBy: null, via: null, ms: null, history: [], matches: [],
        triggeredAt: null, attempts: 0, purchased: false, overPrice: false, overPriceNotified: false, assist: null,
      });
    }
    return this.rt.get(id);
  }

  snapshot(id) {
    const rt = this.runtime(id);
    return {
      id,
      status: rt.status,
      statusLabel: STATUS_LABEL[rt.status] || rt.status,
      orderable: isOrderable(rt.status),
      title: rt.title,
      price: rt.price,
      url: rt.url,
      lastChecked: rt.lastChecked,
      lastChange: rt.lastChange,
      checks: rt.checks,
      errors: rt.errors,
      error: rt.error,
      signals: rt.signals,
      decidedBy: rt.decidedBy,
      via: rt.via,
      ms: rt.ms,
      history: rt.history.slice(0, 10),
      matches: rt.matches,
      triggered: !!rt.triggeredAt,
      attempts: rt.attempts,
      purchased: rt.purchased,
      overPrice: rt.overPrice,
      assist: rt.assist,
      checking: this.inflight.has(id),
    };
  }

  status() {
    return { running: this.running, items: this.store.items.length, enabled: this.store.items.filter((i) => i.enabled).length, checking: this.inflight.size };
  }

  emitItem(id) {
    this.emit('item', this.snapshot(id));
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  start() {
    if (this.running) return this.status();
    this.running = true;
    const items = this.store.items.filter((i) => i.enabled);
    // Stagger the first round so we don't hit every site at once.
    items.forEach((item, idx) => this.schedule(item.id, idx * 150));
    this.bus.log('info', `Monitoring started — ${items.length} item(s) armed.`);
    this.emit('engine', this.status());
    return this.status();
  }

  stop() {
    if (!this.running) return this.status();
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.bus.log('info', 'Monitoring stopped.');
    this.emit('engine', this.status());
    return this.status();
  }

  schedule(id, delayMs) {
    clearTimeout(this.timers.get(id));
    if (!this.running) return;
    const t = setTimeout(() => this.tick(id), Math.max(0, delayMs));
    this.timers.set(id, t);
  }

  nextDelay(item) {
    const s = this.store.settings;
    const base = (item.pollSeconds ?? s.pollSeconds) * 1000;
    const j = (s.jitterPercent || 0) / 100;
    let d = base * (1 + (Math.random() * 2 - 1) * j);
    const rt = this.runtime(item.id);
    if (rt.errors > 0) d = Math.min(Math.max(d, 5000) * 2 ** Math.min(rt.errors - 1, 6), MAX_BACKOFF_MS);
    return d;
  }

  async tick(id) {
    this.timers.delete(id);
    const item = this.store.getItem(id);
    if (!this.running || !item || !item.enabled) return;
    try {
      await this.checkItem(item);
    } catch (e) {
      this.bus.log('error', `Check failed for ${item.name}: ${e.message}`, { itemId: id });
    }
    const fresh = this.store.getItem(id);
    if (this.running && fresh && fresh.enabled && !this.timers.has(id)) this.schedule(id, this.nextDelay(fresh));
  }

  onStoreChange(what, info = {}) {
    if (what !== 'items' || info.quiet) return;
    if (info.removed) {
      clearTimeout(this.timers.get(info.removed));
      this.timers.delete(info.removed);
      this.rt.delete(info.removed);
      return;
    }
    const id = info.added || info.updated;
    if (!id) return;
    if (info.updated) {
      // What we look for may have changed: start fresh for this item.
      this.rt.delete(id);
    }
    const item = this.store.getItem(id);
    if (this.running && item && item.enabled) this.schedule(id, 0);
    else {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
    }
    this.emitItem(id);
  }

  // ---------------------------------------------------------------------------
  // Checking
  // ---------------------------------------------------------------------------

  /** Check one item now. Concurrent calls for the same item share one check. */
  async checkItem(item, { suppressAction = false } = {}) {
    if (this.inflight.has(item.id)) {
      await this.inflight.get(item.id);
      return this.snapshot(item.id);
    }
    const p = this._check(item, { suppressAction });
    this.inflight.set(item.id, p);
    this.emitItem(item.id);
    try {
      return await p;
    } finally {
      this.inflight.delete(item.id);
      this.emitItem(item.id);
    }
  }

  async _check(item, { suppressAction }) {
    const rt = this.runtime(item.id);
    const t0 = Date.now();
    let result;
    try {
      result = await this.performCheck(item);
    } catch (e) {
      result = {
        status: e instanceof BlockedError ? STATUS.BLOCKED : STATUS.ERROR,
        error: e.name === 'TimeoutError' ? 'Request timed out' : e.message,
        signals: [{ source: 'error', status: STATUS.ERROR, detail: e.message }],
      };
    }
    rt.errors = result.status === STATUS.BLOCKED || result.status === STATUS.ERROR ? rt.errors + 1 : 0;
    rt.ms = Date.now() - t0;
    rt.checks += 1;
    rt.lastChecked = Date.now();
    this.apply(item, result, { suppressAction });
    return { ...this.snapshot(item.id), result };
  }

  fetchCtx(item, retailer) {
    return {
      fetch: (url, opts = {}) => this.fetcher.fetch(url, { method: item.method || 'auto', minGapSeconds: retailer.minGapSeconds, ...opts }),
    };
  }

  async performCheck(item) {
    const retailer = this.retailerFor(item);
    if (!retailer) throw new Error('Retailer not available for this item');
    const ctx = this.fetchCtx(item, retailer);
    const rt = this.runtime(item.id);
    let url = item.url || item.resolvedUrl;
    let discovered = null;

    if (!url && item.sku) {
      const found = await retailer.resolveSku(item.sku, ctx);
      if (found) {
        url = found;
        this.store.patchItem(item.id, { resolvedUrl: found });
        discovered = { url: found, name: null, via: 'sku' };
      }
    }
    if (!url && item.keywords) {
      if (!retailer.searchPath && retailer.platform !== 'shopify') {
        return { status: STATUS.ERROR, error: `${retailer.name} can't be searched — add a product link instead.`, signals: [] };
      }
      const q = item.searchQuery || searchQueryFor(item.keywords);
      const hits = await retailer.search(q, ctx);
      const ranked = rankHits(hits, item.keywords, item.exclude);
      rt.matches = ranked.slice(0, 5).map((h) => ({ url: h.url, name: h.name }));
      if (!ranked.length) {
        return { status: STATUS.NOT_LISTED, signals: [{ source: 'search', status: STATUS.NOT_LISTED, detail: `${hits.length} result(s) for "${q}", none matched the keywords` }] };
      }
      const best = ranked[0];
      url = best.url;
      this.store.patchItem(item.id, { resolvedUrl: best.url, resolvedName: best.name });
      discovered = { url: best.url, name: best.name, via: 'keywords', others: ranked.length - 1 };
    }
    if (!url) {
      return { status: STATUS.NOT_LISTED, signals: [{ source: 'sku', status: STATUS.NOT_LISTED, detail: `SKU ${item.sku} not found on ${retailer.name} yet` }] };
    }

    const res = await retailer.check(url, ctx, item);
    if (discovered) res.discovered = discovered;
    // The listing we found earlier has gone: search again next time.
    if (res.status === STATUS.NOT_FOUND && !item.url && item.resolvedUrl) {
      this.store.patchItem(item.id, { resolvedUrl: '', resolvedName: '' });
    }
    return res;
  }

  apply(item, result, { suppressAction = false } = {}) {
    const rt = this.runtime(item.id);
    const retailer = this.retailerFor(item);
    const prev = rt.status;
    const status = result.status;
    rt.status = status;
    if (result.title) rt.title = result.title;
    if (result.price !== undefined && result.price !== null) rt.price = result.price;
    if (result.url) rt.url = result.url;
    if (result.variantId) rt.variantId = result.variantId;
    // Items added with only a link/SKU get the product's real name on first check.
    if (result.title && (item.name === item.url || item.name === item.sku)) {
      this.store.patchItem(item.id, { name: result.title.slice(0, 200) });
    }
    rt.signals = result.signals || [];
    rt.decidedBy = result.decidedBy || null;
    rt.error = result.error || null;
    rt.via = result.via || rt.via;

    if (status !== prev) {
      rt.lastChange = Date.now();
      rt.history.unshift({ ts: Date.now(), from: prev, to: status });
      rt.history.length = Math.min(rt.history.length, 20);
      if (prev !== STATUS.UNKNOWN || isOrderable(status)) {
        this.bus.log(isOrderable(status) ? 'success' : 'info', `${item.name} @ ${retailer?.name}: ${STATUS_LABEL[prev] || prev} → ${STATUS_LABEL[status] || status}`, { itemId: item.id });
      }
    }

    if (result.discovered && result.discovered.via === 'keywords') {
      this.notifier.alert({
        level: 'success',
        title: `Listing found at ${retailer?.name}: ${result.title || result.discovered.name}`,
        message: `Matched your keywords. Status: ${STATUS_LABEL[status] || status}.${result.discovered.others ? ` (${result.discovered.others} other match(es))` : ''}`,
        url: result.url || result.discovered.url,
        itemId: item.id,
      });
    }

    if ((status === STATUS.ERROR || status === STATUS.BLOCKED) && rt.errors === 5) {
      this.notifier.alert({
        level: 'warning',
        title: `Trouble checking ${item.name} at ${retailer?.name}`,
        message: status === STATUS.BLOCKED
          ? 'The site keeps refusing requests. Try the Browser method or a longer interval for this item.'
          : (result.error || 'Repeated errors'),
        url: rt.url || item.url,
        itemId: item.id,
      });
    }

    if (!isOrderable(status)) {
      // Back to sold out: the next restock should trigger again.
      if (status === STATUS.OUT_OF_STOCK || status === STATUS.COMING_SOON || status === STATUS.NOT_FOUND || status === STATUS.NOT_LISTED) {
        rt.triggeredAt = null;
        rt.attempts = 0;
        rt.overPriceNotified = false;
      }
      rt.overPrice = false;
      this.emitItem(item.id);
      return;
    }

    const overPrice = item.maxPrice !== null && item.maxPrice !== undefined && typeof rt.price === 'number' && rt.price > item.maxPrice;
    rt.overPrice = overPrice;
    if (overPrice) {
      if (!rt.overPriceNotified) {
        rt.overPriceNotified = true;
        this.notifier.alert({
          level: 'warning',
          title: `${STATUS_LABEL[status]} but over your max price: ${rt.title || item.name}`,
          message: `${retailer?.name} — ${money(rt.price)} (max ${money(item.maxPrice)}). Not acting on it.`,
          url: rt.url,
          itemId: item.id,
        });
      }
      this.emitItem(item.id);
      return;
    }

    if (rt.triggeredAt || rt.purchased || suppressAction) {
      this.emitItem(item.id);
      return;
    }
    rt.triggeredAt = Date.now();
    this.notifier.alert({
      level: 'urgent',
      title: `${STATUS_LABEL[status]}: ${rt.title || item.name}`,
      message: `${retailer?.name}${money(rt.price) ? ` — ${money(rt.price)}` : ''}${this.running && item.mode !== 'notify' ? (item.mode === 'cart' ? ' — adding to cart now' : ' — starting checkout assist now') : ''}`,
      url: rt.url,
      itemId: item.id,
      fields: [
        { name: 'Retailer', value: retailer?.name || item.retailer },
        { name: 'Price', value: money(rt.price) || 'unknown' },
        { name: 'Qty', value: String(item.quantity || 1) },
      ],
    });
    this.emitItem(item.id);
    if (this.running && item.enabled && item.mode !== 'notify' && this.assist) {
      this.runAssist(item, { manual: false }).catch((e) => this.bus.log('error', `Assist error: ${e.message}`, { itemId: item.id }));
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async runAssist(item, { manual = false } = {}) {
    if (!this.assist) throw new Error('Checkout assist is not available');
    const rt = this.runtime(item.id);
    const retailer = this.retailerFor(item);
    const max = this.store.settings.maxAssistAttempts || 3;
    if (!manual && rt.attempts >= max) {
      this.bus.log('warn', `${item.name}: reached ${max} assist attempts for this restock — press Reset to allow more.`, { itemId: item.id });
      return { state: 'skipped' };
    }
    rt.attempts += 1;
    const outcome = await this.assist.run(item, retailer, {
      url: rt.url || item.url || item.resolvedUrl,
      variantId: rt.variantId,
      mode: item.mode === 'cart' ? 'cart' : 'assist',
      onUpdate: (info) => this.onAssistUpdate(item.id, info),
    });
    if (outcome.state === 'failed' || outcome.state === 'busy') {
      // Let the next in-stock check try again (bounded by maxAssistAttempts).
      rt.triggeredAt = null;
    }
    return outcome;
  }

  onAssistUpdate(id, info) {
    const rt = this.runtime(id);
    rt.assist = { ...info, at: Date.now() };
    if (info.state === 'purchased') {
      rt.purchased = true;
      const item = this.store.getItem(id);
      if (item) this.store.patchItem(id, { enabled: false });
    }
    this.emitItem(id);
  }

  /** "Go" button: check now, then run add-to-cart / checkout assist regardless of the last status. */
  async goNow(id) {
    const item = this.store.getItem(id);
    if (!item) throw new Error('Item not found');
    await this.checkItem(item, { suppressAction: true });
    const rt = this.runtime(id);
    rt.triggeredAt = Date.now();
    const mode = item.mode === 'notify' ? 'assist' : item.mode;
    return this.runAssist({ ...item, mode }, { manual: true });
  }

  reset(id, { forgetListing = false } = {}) {
    const item = this.store.getItem(id);
    if (!item) throw new Error('Item not found');
    const rt = this.runtime(id);
    rt.triggeredAt = null;
    rt.attempts = 0;
    rt.purchased = false;
    rt.assist = null;
    rt.overPriceNotified = false;
    if (forgetListing) {
      this.store.patchItem(id, { resolvedUrl: '', resolvedName: '' });
      rt.matches = [];
    }
    if (this.running && item.enabled) this.schedule(id, 0);
    this.emitItem(id);
    return this.snapshot(id);
  }
}
