import { Retailer } from './base.js';
import { ShopifyRetailer } from './shopify.js';
import { RETAILER_SPECS } from './specs.js';

export { Retailer, ShopifyRetailer, RETAILER_SPECS };
export { BlockedError } from './base.js';

const builtins = new Map();
const dynamic = new Map();

function make(spec) {
  return spec.platform === 'shopify' ? new ShopifyRetailer(spec) : new Retailer(spec);
}

for (const spec of RETAILER_SPECS) builtins.set(spec.id, make(spec));

/** Add or replace a retailer at runtime (used by the demo store and tests). */
export function registerRetailer(spec) {
  const r = make(spec);
  builtins.set(spec.id, r);
  return r;
}

export function listRetailers() {
  return [...builtins.values()];
}

export function getRetailer(id) {
  return builtins.get(id) || null;
}

function originFromDomain(domain) {
  const d = String(domain || '').trim();
  if (!d) return null;
  const withScheme = /^https?:\/\//i.test(d) ? d : `https://${d}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

/** The retailer implementation for a watch item. */
export function retailerForItem(item) {
  if (item.retailer === 'shopify') {
    const origin = originFromDomain(item.domain) || (item.url ? new URL(item.url).origin : null);
    if (!origin) return null;
    const key = `shopify:${origin}`;
    if (!dynamic.has(key)) dynamic.set(key, new ShopifyRetailer({ id: key, name: new URL(origin).host.replace(/^www\./, ''), base: origin, group: 'custom' }));
    return dynamic.get(key);
  }
  if (item.retailer === 'generic') {
    if (!item.url) return null;
    const origin = new URL(item.url).origin;
    const key = `generic:${origin}`;
    if (!dynamic.has(key)) dynamic.set(key, new Retailer({ id: key, name: new URL(origin).host.replace(/^www\./, ''), base: origin, group: 'custom', searchPath: null }));
    return dynamic.get(key);
  }
  return getRetailer(item.retailer);
}

/** Work out which retailer a pasted link belongs to. */
export function detectRetailer(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // Prefer the most specific match (a store mounted under a path beats one at the root).
  const owners = [...builtins.values()].filter((r) => r.ownsUrl(url))
    .sort((a, b) => new URL(b.base).pathname.length - new URL(a.base).pathname.length);
  if (owners.length) {
    const r = owners[0];
    return { retailer: r.id, name: r.name, sku: r.skuFromUrl(url), isProduct: r.isProductUrl(url) };
  }
  if (/\/products\/[^/]+/.test(u.pathname)) {
    return { retailer: 'shopify', domain: u.host, name: u.host.replace(/^www\./, ''), sku: null, isProduct: true, guess: true };
  }
  return { retailer: 'generic', name: u.host.replace(/^www\./, ''), sku: null, isProduct: true };
}
