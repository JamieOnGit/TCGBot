// A retailer knows how to: check one product page, search its catalogue (to
// find products that are not listed yet), resolve a SKU to a product page, and
// where its cart/checkout live. Most retailers are described purely by data
// (see specs.js); Shopify stores get a faster JSON-based implementation.

import { extractProduct, extractProductLinks, slugWords } from '../extract.js';
import { STATUS } from '../status.js';

export class BlockedError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BlockedError';
    this.httpStatus = status;
  }
}

export class Retailer {
  constructor(spec) {
    this.spec = spec;
    this.id = spec.id;
    this.name = spec.name;
    this.base = String(spec.base).replace(/\/+$/, '');
    this.platform = spec.platform || 'generic';
    this.hosts = spec.hosts || [new URL(this.base).host.replace(/^www\./, '')];
    this.productPath = spec.productPath || /./;
    this.skuFromPath = spec.skuFromPath || null;
    this.searchPath = spec.searchPath || null;
    this.productPathFromSku = spec.productPathFromSku || null;
    this.cartPath = spec.cartPath ?? '/cart';
    this.checkoutPath = spec.checkoutPath ?? '/checkout';
    this.loginPath = spec.loginPath ?? '/';
    this.hints = spec.hints || {};
    this.notes = spec.notes || '';
    this.group = spec.group || 'other';
    this.minGapSeconds = spec.minGapSeconds ?? null;
  }

  toJSON() {
    return { id: this.id, name: this.name, base: this.base, platform: this.platform, notes: this.notes, group: this.group, searchable: !!this.searchPath };
  }

  ownsUrl(url) {
    try {
      const u = new URL(url);
      const host = u.host.replace(/^www\./, '');
      const basePath = new URL(this.base).pathname.replace(/\/+$/, '');
      if (basePath && !u.pathname.startsWith(basePath + '/')) return false;
      return this.hosts.some((h) => host === h || host.endsWith('.' + h));
    } catch {
      return false;
    }
  }

  isProductUrl(url) {
    try {
      return this.ownsUrl(url) && this.productPath.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }

  skuFromUrl(url) {
    if (!this.skuFromPath) return null;
    try {
      const m = new URL(url).pathname.match(this.skuFromPath);
      return m ? decodeURIComponent(m[1]) : null;
    } catch {
      return null;
    }
  }

  url(path) {
    if (!path) return null;
    if (/^https?:/i.test(path)) return path;
    return this.base + (path.startsWith('/') ? path : '/' + path);
  }

  searchUrl(query) {
    return this.searchPath ? this.url(this.searchPath.replace('{q}', encodeURIComponent(query))) : null;
  }

  cartUrl() { return this.url(this.cartPath); }
  checkoutUrl() { return this.url(this.checkoutPath); }
  loginUrl() { return this.url(this.loginPath); }

  /** Check a product page. `ctx.fetch(url, {kind})` -> {status, url, body, blocked}. */
  async check(url, ctx, item = {}) {
    const res = await ctx.fetch(url, { kind: 'page' });
    return this.interpretPage(res, item);
  }

  interpretPage(res, item = {}) {
    const via = res.via || 'http';
    if (res.status === 404 || res.status === 410) {
      return { status: STATUS.NOT_FOUND, url: res.url, signals: [{ source: 'http', status: STATUS.NOT_FOUND, detail: `HTTP ${res.status}` }], via };
    }
    if (res.blocked) {
      return { status: STATUS.BLOCKED, url: res.url, signals: [{ source: 'http', status: STATUS.BLOCKED, detail: `HTTP ${res.status} — the site refused the request` }], via };
    }
    if (res.status >= 400 || res.status === 0) {
      return { status: STATUS.ERROR, url: res.url, error: `HTTP ${res.status}`, signals: [{ source: 'http', status: STATUS.ERROR, detail: `HTTP ${res.status}` }], via };
    }
    const r = extractProduct(res.body, { url: res.url, sku: item.sku, hints: this.hints });
    r.url = res.url;
    r.sku = r.sku || this.skuFromUrl(res.url);
    r.via = via;
    return r;
  }

  /** Search the catalogue. Returns [{url, name, slug}] (unfiltered — the caller ranks by keywords). */
  async search(query, ctx) {
    const sUrl = this.searchUrl(query);
    if (!sUrl) return [];
    const res = await ctx.fetch(sUrl, { kind: 'search' });
    if (res.blocked) throw new BlockedError(`${this.name} blocked the search request (HTTP ${res.status})`, res.status);
    if (res.status >= 400) throw new Error(`${this.name} search failed: HTTP ${res.status}`);
    // Searching an exact code often redirects straight to the product page.
    if (this.isProductUrl(res.url) && !this.isProductUrl(sUrl)) {
      const r = extractProduct(res.body, { url: res.url });
      const slug = slugWords(new URL(res.url).pathname);
      return [{ url: res.url, name: r.title || slug, slug }];
    }
    return extractProductLinks(res.body, res.url, this.productPath);
  }

  /** Turn a SKU / product code into a product page URL (or null if not listed yet). */
  async resolveSku(sku, ctx) {
    if (this.productPathFromSku) return this.url(this.productPathFromSku.replace('{sku}', encodeURIComponent(sku)));
    const hits = await this.search(sku, ctx);
    const s = String(sku).toLowerCase();
    const exact = hits.find((h) => (this.skuFromUrl(h.url) || '').toLowerCase() === s)
      || hits.find((h) => h.url.toLowerCase().includes(s));
    if (exact) return exact.url;
    return hits.length === 1 ? hits[0].url : null;
  }
}
