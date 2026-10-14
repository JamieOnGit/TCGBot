// Shopify storefronts expose small public JSON endpoints that are much faster
// and more reliable than parsing HTML:
//   /products/<handle>.js         -> variants with an `available` flag (prices in cents)
//   /search/suggest.json?q=...    -> predictive search results
//   /products.json?limit=250      -> recent catalogue (catches brand-new listings)
// and a cart permalink (/cart/<variant>:<qty>) that jumps straight to checkout.

import { Retailer, BlockedError } from './base.js';
import { STATUS } from '../status.js';
import { parsePrice } from '../extract.js';

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export class ShopifyRetailer extends Retailer {
  constructor(spec) {
    super({
      productPath: /\/products\/[^/]+\/?$/,
      skuFromPath: /\/products\/([^/?#.]+)/,
      searchPath: '/search?q={q}&type=product',
      cartPath: '/cart',
      checkoutPath: '/checkout',
      ...spec,
      platform: 'shopify',
    });
  }

  handleFromUrl(url) {
    try {
      const m = new URL(url).pathname.match(/\/products\/([^/?#.]+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  async check(url, ctx, item = {}) {
    const handle = this.handleFromUrl(url);
    if (handle) {
      // Keep any path prefix (e.g. a locale like /en-au) in front of /products/.
      const u = new URL(url);
      const origin = u.origin + u.pathname.slice(0, u.pathname.indexOf('/products/'));
      let res = null;
      try {
        res = await ctx.fetch(`${origin}/products/${handle}.js`, { kind: 'json' });
      } catch {
        res = null;
      }
      if (res && res.blocked) {
        return { status: STATUS.BLOCKED, url, signals: [{ source: 'http', status: STATUS.BLOCKED, detail: `HTTP ${res.status}` }], via: res.via };
      }
      if (res && res.status === 200) {
        const p = safeJson(res.body);
        if (p && Array.isArray(p.variants)) return { ...this.fromProductJs(p, origin, item), via: res.via || 'http' };
      }
      // Headless storefronts and some themes disable the JSON endpoint: fall back to the HTML page.
    }
    return super.check(url, ctx, item);
  }

  fromProductJs(p, origin, item = {}) {
    const want = String(item.sku || '').toLowerCase();
    let v = want ? p.variants.find((x) => String(x.sku || '').toLowerCase() === want || String(x.id) === want) : null;
    if (!v) v = p.variants.find((x) => x.available) || p.variants[0];
    const tags = Array.isArray(p.tags) ? p.tags.join(' ') : String(p.tags || '');
    const pre = /pre-?\s?order/i.test(`${p.title} ${tags}`);
    const soon = /coming[- ]?soon/i.test(tags);
    let status;
    if (v && v.available) status = pre ? STATUS.PREORDER : STATUS.IN_STOCK;
    else status = soon ? STATUS.COMING_SOON : STATUS.OUT_OF_STOCK;
    const cents = v ? v.price : p.price;
    return {
      status,
      title: p.title,
      price: typeof cents === 'number' ? cents / 100 : parsePrice(cents),
      currency: null,
      sku: (v && v.sku) || null,
      variantId: v ? v.id : null,
      url: `${origin}/products/${p.handle}`,
      decidedBy: 'shopify-json',
      signals: [{ source: 'shopify-json', status, detail: v ? `variant ${v.id} available=${v.available}` : 'no variants' }],
    };
  }

  async search(query, ctx) {
    const origin = this.base;
    const q = encodeURIComponent(query);
    // 1. Predictive search.
    try {
      const res = await ctx.fetch(`${origin}/search/suggest.json?q=${q}&resources[type]=product&resources[limit]=10&resources[options][unavailable_products]=last`, { kind: 'json' });
      if (res.blocked) throw new BlockedError(`${this.name} blocked the search request (HTTP ${res.status})`, res.status);
      if (res.status === 200) {
        const data = safeJson(res.body);
        const products = data?.resources?.results?.products;
        if (Array.isArray(products) && products.length) {
          return products.map((p) => {
            const u = new URL(p.url || `/products/${p.handle}`, origin);
            u.search = '';
            return { url: u.href, name: p.title, slug: p.handle || '', available: p.available, price: parsePrice(p.price) };
          });
        }
      }
    } catch (e) {
      if (e instanceof BlockedError) throw e;
    }
    // 2. Recent catalogue — catches listings before the search index updates.
    try {
      const res = await ctx.fetch(`${origin}/products.json?limit=250`, { kind: 'json' });
      if (res.status === 200) {
        const data = safeJson(res.body);
        if (Array.isArray(data?.products) && data.products.length) {
          return data.products.map((p) => ({
            url: `${origin}/products/${p.handle}`,
            name: p.title,
            slug: p.handle,
            available: Array.isArray(p.variants) && p.variants.some((v) => v.available),
            price: parsePrice(p.variants?.[0]?.price),
          }));
        }
      }
    } catch {
      /* fall through to HTML search */
    }
    // 3. HTML search page.
    return super.search(query, ctx);
  }

  cartPermalink(variantId, qty = 1) {
    return `${this.base}/cart/${variantId}:${qty}`;
  }

  addToCartUrl(variantId, qty = 1) {
    return `${this.base}/cart/add?id=${variantId}&quantity=${qty}`;
  }
}
