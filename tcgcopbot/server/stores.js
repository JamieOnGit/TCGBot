// Stores the extension works on, and how to read a product code from a link.

export const STORES = [
  { id: 'kmart', name: 'Kmart', host: 'www.kmart.com.au', sku: /-(\d{6,10})\/?$/ },
  { id: 'ebgames', name: 'EB Games', host: 'www.ebgames.com.au', sku: /^\/product\/[^/]+\/(\d+)/ },
  { id: 'zing', name: 'Zing Pop Culture', host: 'www.zingpopculture.com.au', sku: /^\/product\/[^/]+\/(\d+)/ },
  { id: 'jbhifi', name: 'JB Hi-Fi', host: 'www.jbhifi.com.au', sku: /\/products\/([^/?#.]+)/ },
  { id: 'target', name: 'Target', host: 'www.target.com.au', sku: /^\/p\/[^/]+\/([A-Za-z0-9_-]+)/ },
  { id: 'bigw', name: 'BIG W', host: 'www.bigw.com.au', sku: /\/p\/(\d+)/ },
  { id: 'toysrus', name: 'Toys"R"Us', host: 'www.toysrus.com.au', sku: /\/products\/([^/?#.]+)/ },
  { id: 'amazon', name: 'Amazon AU', host: 'www.amazon.com.au', sku: /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/ },
];

// Card boxes are often in a frame hosted by the store's payment provider.
export const PAYMENT_HOSTS = [
  'https://*.adyen.com/*',
  'https://*.braintreegateway.com/*',
  'https://js.stripe.com/*',
  'https://*.cybersource.com/*',
  'https://*.checkout.com/*',
  'https://*.worldpay.com/*',
  'https://*.qvalent.com/*',
  'https://*.payway.com.au/*',
  'https://*.windcave.com/*',
  'https://*.eway.io/*',
  'https://*.securepay.com.au/*',
  'https://checkout.shopifycs.com/*',
];

export function storeFor(url) {
  try {
    const host = new URL(url).host;
    return STORES.find((s) => s.host === host || host.endsWith(`.${s.host.replace(/^www\./, '')}`)) || null;
  } catch {
    return null;
  }
}

/** Best guess at the product code in a product link. */
export function skuFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  let p = u.pathname;
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  const store = storeFor(url);
  if (store) {
    const m = p.match(store.sku);
    if (m) return m[1];
  }
  const shopify = p.match(/\/products\/([^/?#.]+)/);
  if (shopify) return shopify[1];
  const digits = p.match(/(\d{6,12})(?!.*\d{6,12})/);
  return digits ? digits[1] : '';
}

export function storeName(url) {
  const s = storeFor(url);
  if (s) return s.name;
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; }
}
