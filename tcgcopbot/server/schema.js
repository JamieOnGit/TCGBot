// Input checks. Everything a user sends goes through one of these first.

import { skuFromUrl } from './stores.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const bad = (message) => new HttpError(400, message);

export const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v)).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

export function num(v, { min = -Infinity, max = Infinity, def = null, int = false } = {}) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  const x = int ? Math.round(n) : n;
  return Math.min(max, Math.max(min, x));
}

export const bool = (v, def = false) => (v === undefined || v === null ? def : v === true || v === 'true' || v === 1 || v === '1' || v === 'on');

export function httpUrl(value, label = 'Link', { required = true } = {}) {
  const s = str(value, 2000);
  if (!s) {
    if (required) throw bad(`${label} is required`);
    return '';
  }
  let u;
  try { u = new URL(s); } catch { throw bad(`${label} isn't a valid web address`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad(`${label} must start with https://`);
  if (u.username || u.password) throw bad(`${label} can't contain a username or password`);
  u.hash = '';
  return u.toString();
}

const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;
export function email(v) {
  const s = str(v, 254).toLowerCase();
  if (!EMAIL_RE.test(s)) throw bad('Enter a valid email address');
  return s;
}

export function password(v) {
  const s = typeof v === 'string' ? v : '';
  if (s.length < 10) throw bad('Use at least 10 characters for your password');
  if (s.length > 200) throw bad('That password is too long');
  if (/^(.)\1+$/.test(s) || /^(password|1234567890|qwertyuiop)/i.test(s)) throw bad('Choose a less guessable password');
  return s;
}

// --- Quick Checkout products -------------------------------------------------
export function product(input, existing = null) {
  const src = { ...(existing || {}), ...(input || {}) };
  const url = httpUrl(src.url, 'Product link');
  const out = {
    name: str(src.name, 120),
    sku: str(src.sku, 60) || skuFromUrl(url),
    url,
    price: num(src.price, { min: 0, max: 100000, def: null }),
    quantity: num(src.quantity, { min: 1, max: 10, def: 1, int: true }),
    enabled: bool(src.enabled, true),
  };
  if (!out.sku) throw bad("Couldn't find the product code in that link — enter the SKU / keycode");
  if (!out.name) out.name = out.sku;
  return out;
}

// --- Delivery details ----------------------------------------------------------
export const AU_STATES = { NSW: 'New South Wales', VIC: 'Victoria', QLD: 'Queensland', WA: 'Western Australia', SA: 'South Australia', TAS: 'Tasmania', ACT: 'Australian Capital Territory', NT: 'Northern Territory' };
export const EMPTY_PROFILE = { firstName: '', lastName: '', email: '', phone: '', address1: '', address2: '', suburb: '', state: '', postcode: '', country: 'AU' };

export function profile(input) {
  const p = { ...EMPTY_PROFILE, ...(input || {}) };
  const state = str(p.state, 40).toUpperCase();
  const out = {
    firstName: str(p.firstName, 80),
    lastName: str(p.lastName, 80),
    email: str(p.email, 200),
    phone: str(p.phone, 40),
    address1: str(p.address1, 200),
    address2: str(p.address2, 200),
    suburb: str(p.suburb, 100),
    state: AU_STATES[state] ? state : Object.entries(AU_STATES).find(([, full]) => full.toUpperCase() === state)?.[0] || state,
    postcode: str(p.postcode, 10),
    country: 'AU',
  };
  if (out.email && !EMAIL_RE.test(out.email)) throw bad('Checkout email looks wrong');
  if (out.postcode && !/^\d{4}$/.test(out.postcode)) throw bad('Australian postcodes have 4 digits');
  if (out.state && !AU_STATES[out.state]) throw bad('State must be one of NSW, VIC, QLD, WA, SA, TAS, ACT, NT');
  return out;
}

// --- Alerts --------------------------------------------------------------------
export const DEFAULT_ALERTS = { discordWebhook: '', discordMention: '', emailOnRestock: true, emailOnCheckout: false };

export function alerts(input, existing = DEFAULT_ALERTS) {
  const a = { ...DEFAULT_ALERTS, ...existing, ...(input || {}) };
  const hook = str(a.discordWebhook, 500);
  if (hook) {
    let u;
    try { u = new URL(hook); } catch { throw bad("Discord webhook isn't a valid link"); }
    if (u.protocol !== 'https:' || !/(^|\.)(discord\.com|discordapp\.com)$/.test(u.hostname) || !u.pathname.startsWith('/api/webhooks/')) {
      throw bad('Discord webhook must look like https://discord.com/api/webhooks/…');
    }
  }
  return {
    discordWebhook: hook,
    discordMention: str(a.discordMention, 100).replace(/@(everyone|here)/g, '$1'),
    emailOnRestock: bool(a.emailOnRestock, true),
    emailOnCheckout: bool(a.emailOnCheckout, false),
  };
}

// --- Watchlist ------------------------------------------------------------------
export function watchItem(input, existing = null) {
  const src = { ...(existing || {}), ...(input || {}) };
  const url = httpUrl(src.url, 'Product link');
  return {
    name: str(src.name, 120) || new URL(url).pathname.split('/').filter(Boolean).pop()?.slice(0, 120) || 'Product',
    url,
    maxPrice: num(src.maxPrice ?? src.max_price, { min: 0, max: 100000, def: null }),
    enabled: bool(src.enabled, true),
  };
}
