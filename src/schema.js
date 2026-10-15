// Validation and defaults for everything the user can edit in the dashboard.

import { randomUUID } from 'node:crypto';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const MODES = ['notify', 'cart', 'assist'];
export const METHODS = ['auto', 'http', 'browser'];
export const AU_STATES = {
  NSW: 'New South Wales',
  VIC: 'Victoria',
  QLD: 'Queensland',
  WA: 'Western Australia',
  SA: 'South Australia',
  TAS: 'Tasmania',
  ACT: 'Australian Capital Territory',
  NT: 'Northern Territory',
};

export const DEFAULT_SETTINGS = Object.freeze({
  pollSeconds: 15,
  minHostGapSeconds: 4,
  jitterPercent: 20,
  requestTimeoutSeconds: 20,
  userAgent: '',
  discordWebhook: '',
  discordMention: '',
  browserChannel: 'chromium',
  browserPath: '',
  headless: false,
  blockImages: true,
  autoStart: false,
  maxAssistAttempts: 3,
});

export const DEFAULT_PROFILE = Object.freeze({
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  address1: '',
  address2: '',
  suburb: '',
  state: '',
  postcode: '',
  country: 'AU',
});

const str = (v, max = 500) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));

function num(v, { min, max, def = null, int = false }) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ValidationError(`"${v}" is not a number`);
  const x = int ? Math.round(n) : n;
  if (min !== undefined && x < min) throw new ValidationError(`Value must be at least ${min}`);
  if (max !== undefined && x > max) throw new ValidationError(`Value must be at most ${max}`);
  return x;
}

function bool(v, def) {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function checkUrl(u, label = 'Link') {
  if (!u) return '';
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw new ValidationError(`${label} is not a valid URL: ${u}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new ValidationError(`${label} must start with http:// or https://`);
  return parsed.href;
}

/**
 * Clean up an item from the dashboard. `existing` is the stored item when editing.
 * `knownRetailers` is the list of valid built-in retailer ids.
 */
export function normalizeItem(input, knownRetailers, existing = null, { allowFastPolling = false } = {}) {
  const src = { ...(existing || {}), ...(input || {}) };
  const retailer = str(src.retailer, 100);
  const valid = new Set([...knownRetailers, 'shopify', 'generic']);
  if (!valid.has(retailer)) throw new ValidationError(`Unknown retailer "${retailer}"`);

  const item = {
    id: existing?.id || str(src.id, 40) || randomUUID().slice(0, 8),
    name: str(src.name, 200),
    retailer,
    domain: retailer === 'shopify' ? str(src.domain, 200).replace(/\/+$/, '') : '',
    url: checkUrl(str(src.url, 2000), 'Product link'),
    sku: str(src.sku, 100),
    keywords: str(src.keywords, 500),
    exclude: str(src.exclude, 500),
    searchQuery: str(src.searchQuery, 200),
    maxPrice: num(src.maxPrice, { min: 0, max: 100000, def: null }),
    quantity: num(src.quantity, { min: 1, max: 20, def: 1, int: true }),
    mode: MODES.includes(src.mode) ? src.mode : 'notify',
    method: METHODS.includes(src.method) ? src.method : 'auto',
    pollSeconds: num(src.pollSeconds, { min: allowFastPolling ? 0.01 : 3, max: 3600, def: null }),
    enabled: bool(src.enabled, true),
    group: str(src.group, 60),
    resolvedUrl: existing ? existing.resolvedUrl || '' : '',
    resolvedName: existing ? existing.resolvedName || '' : '',
    createdAt: existing?.createdAt || Date.now(),
  };
  if (retailer === 'shopify' && !item.domain && !item.url) throw new ValidationError('Enter the Shopify store domain (e.g. store.com.au) or a product link.');
  if (retailer === 'generic' && !item.url) throw new ValidationError('"Other website" needs a product link.');
  if (!item.url && !item.sku && !item.keywords) throw new ValidationError('Give the bot something to look for: a product link, a SKU, or keywords.');
  if (!item.name) item.name = item.keywords ? item.keywords.split(',')[0].replace(/\|.*/, '').trim() : item.sku || item.url;

  // When what we are looking for changes, forget the product we found earlier.
  if (existing && (existing.url !== item.url || existing.sku !== item.sku || existing.keywords !== item.keywords
    || existing.retailer !== item.retailer || existing.domain !== item.domain || existing.exclude !== item.exclude)) {
    item.resolvedUrl = '';
    item.resolvedName = '';
  }
  return item;
}

/** A product in the Quick Checkout list. `sku` is used to recognise its page. */
export function normalizeQuickProduct(input, existing = null) {
  const src = { ...(existing || {}), ...(input || {}) };
  const url = checkUrl(str(src.url, 2000), 'Product link');
  if (!url) throw new ValidationError('Product link is required');
  const p = {
    id: existing?.id || str(src.id, 40) || randomUUID().slice(0, 8),
    name: str(src.name, 120),
    sku: str(src.sku, 60),
    url,
    price: num(src.price, { min: 0, max: 100000, def: null }),
    quantity: num(src.quantity, { min: 1, max: 10, def: 1, int: true }),
    enabled: bool(src.enabled, true),
  };
  if (!p.sku) throw new ValidationError('Product code (SKU) is required — it is how the panel recognises the product page');
  if (!p.name) p.name = p.sku;
  return p;
}

export function normalizeSettings(input, existing = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...existing, ...(input || {}) };
  return {
    pollSeconds: num(s.pollSeconds, { min: 3, max: 3600, def: DEFAULT_SETTINGS.pollSeconds }),
    minHostGapSeconds: num(s.minHostGapSeconds, { min: 1, max: 600, def: DEFAULT_SETTINGS.minHostGapSeconds }),
    jitterPercent: num(s.jitterPercent, { min: 0, max: 90, def: DEFAULT_SETTINGS.jitterPercent }),
    requestTimeoutSeconds: num(s.requestTimeoutSeconds, { min: 3, max: 120, def: 20 }),
    userAgent: str(s.userAgent, 400),
    discordWebhook: s.discordWebhook ? checkUrl(str(s.discordWebhook, 500), 'Discord webhook') : '',
    discordMention: str(s.discordMention, 100),
    browserChannel: ['chromium', 'chrome', 'msedge'].includes(s.browserChannel) ? s.browserChannel : 'chromium',
    browserPath: str(s.browserPath, 500),
    headless: bool(s.headless, false),
    blockImages: bool(s.blockImages, true),
    autoStart: bool(s.autoStart, false),
    maxAssistAttempts: num(s.maxAssistAttempts, { min: 1, max: 10, def: 3, int: true }),
  };
}

export function normalizeProfile(input, existing = DEFAULT_PROFILE) {
  const p = { ...DEFAULT_PROFILE, ...existing, ...(input || {}) };
  const state = str(p.state, 40).toUpperCase();
  const stateAbbr = AU_STATES[state] ? state
    : Object.entries(AU_STATES).find(([, full]) => full.toUpperCase() === state)?.[0] || state;
  const out = {
    firstName: str(p.firstName, 80),
    lastName: str(p.lastName, 80),
    email: str(p.email, 200),
    phone: str(p.phone, 40),
    address1: str(p.address1, 200),
    address2: str(p.address2, 200),
    suburb: str(p.suburb, 100),
    state: stateAbbr,
    postcode: str(p.postcode, 10),
    country: 'AU',
  };
  if (out.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) throw new ValidationError('Email address looks wrong');
  if (out.postcode && !/^\d{4}$/.test(out.postcode)) throw new ValidationError('Australian postcodes have 4 digits');
  if (out.state && !AU_STATES[out.state]) throw new ValidationError('State must be one of NSW, VIC, QLD, WA, SA, TAS, ACT, NT');
  return out;
}
