// Reads stock status, price and title from a retailer's product page HTML.
//
// Signals are gathered from several independent sources and the most
// trustworthy one wins (structured data first, then visible UI). Every signal
// is returned so the dashboard can show *why* the bot thinks something is in
// stock — essential for checking a new retailer works before relying on it.

import { parseHTML, walk, findAll, findFirst, textContent, identity } from './html.js';
import { STATUS, combineStatuses } from './status.js';

// ---------------------------------------------------------------------------
// Text classifiers
// ---------------------------------------------------------------------------

export function mapAvailability(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value ? STATUS.IN_STOCK : STATUS.OUT_OF_STOCK;
  const v = String(value).toLowerCase().split(/[/#:]/).pop().replace(/[^a-z]/g, '');
  if (!v) return null;
  if (['instock', 'onlineonly', 'limitedavailability', 'available', 'instockonline', 'yes', 'true', 'lowstock', 'instockonlineonly'].includes(v)) return STATUS.IN_STOCK;
  if (['preorder', 'presale', 'backorder', 'availableforpreorder', 'preordernow', 'onbackorder', 'preorderable'].includes(v)) return STATUS.PREORDER;
  if (['outofstock', 'soldout', 'discontinued', 'oos', 'unavailable', 'instoreonly', 'no', 'false', 'notavailable', 'outofstockonline'].includes(v)) return STATUS.OUT_OF_STOCK;
  if (['comingsoon', 'notyetavailable', 'newsoon', 'notreleased', 'upcoming'].includes(v)) return STATUS.COMING_SOON;
  return null;
}

export function parsePrice(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  const m = String(v).replace(/\s/g, '').match(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, '') + (m[2] ? '.' + m[2] : ''));
  return Number.isFinite(n) ? n : null;
}

const IGNORE_ACTION_RE = /wish ?list|favou?rite|compare|registry|gift ?card|afterpay|zip ?pay|\bzip\b|paypal|klarna|humm|latitude|apple ?pay|google ?pay|shop ?pay|laybuy|lay-?by|find (in|a) store|check (store |in-?store )?stock|store availability|click (&|and) collect|pick ?up|size guide|share|write a review|read reviews/i;
const SOON_RE = /\b(coming soon|notify me|email me|notify when|register (your )?interest|available soon|alert me|get notified|remind me|join (the )?wait ?list|back in stock alert)\b/i;
const SOLD_RE = /\b(sold out|out of stock|currently unavailable|unavailable|no longer available|not available|in-?store only|not in stock|no stock|discontinued|unavailable online)\b/i;
const PRE_RE = /\bpre-?\s?(order|sale)/i;
const ATC_RE = /\b(add to (cart|bag|basket|trolley|order)|buy (it )?now|add to my (cart|bag))\b/i;

/** Classify the label of a buy button. */
export function classifyActionText(text) {
  if (!text) return null;
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (!s || s.length > 120) return null;
  if (IGNORE_ACTION_RE.test(s)) return null;
  if (SOON_RE.test(s)) return STATUS.COMING_SOON;
  if (SOLD_RE.test(s)) return STATUS.OUT_OF_STOCK;
  if (PRE_RE.test(s)) return STATUS.PREORDER;
  if (ATC_RE.test(s) || /^add$/i.test(s)) return STATUS.IN_STOCK;
  return null;
}

/** Classify a short stock message such as "In stock", "Sold out online" or "Pre-order now". */
export function classifyAvailabilityText(text) {
  if (!text) return null;
  const s = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
  if (!s || s.length > 160) return null;
  if (/\b(in-?store only|not available (for delivery|online)|unavailable online|online unavailable|sold out online|out of stock online|no online stock|delivery unavailable)\b/.test(s)) return STATUS.OUT_OF_STOCK;
  // Store-level stock ("3 in stock at Chadstone") says nothing about online stock.
  if (/\b(in-?stores?|stores?|pick ?up|collect)\b/.test(s) && !/\b(online|deliver(y|ed)?|ship(ping|s|ped)?|dispatch(es|ed)?)\b/.test(s)) return null;
  if (SOON_RE.test(s)) return STATUS.COMING_SOON;
  if (/\b(sold out|out of stock|currently unavailable|unavailable|not available|no stock|not in stock|discontinued)\b/.test(s)) return STATUS.OUT_OF_STOCK;
  if (PRE_RE.test(s)) return STATUS.PREORDER;
  if (/\b(in stock|available (now|online|for delivery|to (buy|order|ship))|only \d+ left|low stock|limited stock|ready to ship|ships? (today|tomorrow|in|within)|dispatch(es|ed)? (today|tomorrow|in|within)|delivery available|usually dispatched)\b/.test(s)) return STATUS.IN_STOCK;
  return null;
}

// ---------------------------------------------------------------------------
// Scoping: ignore site chrome and recommendation carousels
// ---------------------------------------------------------------------------

export const DEFAULT_SKIP_RE = /(recommend|related|carousel|upsell|up-sell|cross-?sell|also[-_ ]?(like|bought|viewed)|similar|recently[-_ ]?viewed|mini-?cart|cart-?drawer|side-?cart|newsletter|quick-?view|product-?(tile|card|grid|list-?item)|search-?results|mega-?menu|site-?header|site-?footer|cookie|you[-_ ]?may[-_ ]?(also)?[-_ ]?like|frequently[-_ ]?bought|complete[-_ ]?the[-_ ]?(look|set))/i;
const ALWAYS_SKIP_TAGS = new Set(['nav', 'noscript', 'template', 'svg', 'dialog']);
const HIDDEN_CLASS_RE = /(^|\s)(hidden|d-none|is-hidden|hide|invisible|u-hidden|visually-hidden-until)(\s|$)/i;

function isHidden(n) {
  const a = n.attrs;
  if ('hidden' in a) return true;
  if (a['aria-hidden'] === 'true') return true;
  if (a.style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style)) return true;
  if (a.class && HIDDEN_CLASS_RE.test(a.class)) return true;
  return false;
}

function insideProductRegion(n) {
  for (let p = n.parent; p; p = p.parent) {
    if (p.tag === 'main' || p.tag === 'article') return true;
    if (/\b(product|pdp)\b/i.test(identity(p))) return true;
  }
  return false;
}

export function makeSkip(hints = {}) {
  const skipRe = hints.skipRe || DEFAULT_SKIP_RE;
  return (n) => {
    if (ALWAYS_SKIP_TAGS.has(n.tag)) return true;
    if ((n.tag === 'header' || n.tag === 'footer') && !insideProductRegion(n)) return true;
    if (isHidden(n)) return true;
    const id = identity(n);
    if (id && skipRe.test(id)) return true;
    return false;
  };
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

function parseJsonLoose(text) {
  if (!text) return null;
  let t = text.trim().replace(/^<!--|-->$/g, '').replace(/^\s*\/\/\s*<!\[CDATA\[|\/\/\s*\]\]>\s*$/g, '').trim();
  if (t.endsWith(';')) t = t.slice(0, -1);
  try { return JSON.parse(t); } catch { /* fall through */ }
  try { return JSON.parse(t.replace(/[\u0000-\u001f]+/g, ' ')); } catch { /* fall through */ }
  try { return JSON.parse(t.replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

function typeIs(obj, ...names) {
  const t = obj && obj['@type'];
  if (!t) return false;
  const list = Array.isArray(t) ? t : [t];
  return list.some((x) => names.includes(String(x).replace(/^.*[/:]/, '').toLowerCase()));
}

function str(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return str(v[0]);
  if (typeof v === 'object') return str(v.name ?? v['@value'] ?? v.url ?? null);
  const s = String(v).trim();
  return s || null;
}

function collectOffers(o, out = [], depth = 0) {
  if (!o || depth > 5) return out;
  if (Array.isArray(o)) { for (const x of o) collectOffers(x, out, depth + 1); return out; }
  if (typeof o !== 'object') return out;
  if ('availability' in o || 'price' in o || 'lowPrice' in o || 'priceSpecification' in o) out.push(o);
  if (o.offers) collectOffers(o.offers, out, depth + 1);
  return out;
}

function ldProduct(obj) {
  const offers = collectOffers(obj.offers);
  const variantSkus = [];
  if (Array.isArray(obj.hasVariant)) {
    for (const v of obj.hasVariant) {
      if (v && typeof v === 'object') {
        collectOffers(v.offers, offers);
        if (v.sku) variantSkus.push(String(v.sku));
      }
    }
  }
  const statuses = offers.map((o) => mapAvailability(str(o.availability)));
  const first = offers.find((o) => o.price !== undefined || o.lowPrice !== undefined || o.priceSpecification) || {};
  const price = parsePrice(first.price ?? first.lowPrice ?? first.priceSpecification?.price ?? null);
  return {
    name: str(obj.name),
    sku: str(obj.sku) || str(obj.mpn) || str(obj.productID),
    ids: [obj.sku, obj.mpn, obj.productID, obj.gtin, obj.gtin8, obj.gtin12, obj.gtin13, obj.gtin14, ...variantSkus]
      .filter((x) => x !== undefined && x !== null && x !== '').map((x) => String(x).toLowerCase()),
    url: str(obj.url) || str(obj['@id']),
    image: str(obj.image),
    status: combineStatuses(statuses),
    availabilityRaw: offers.map((o) => str(o.availability)).filter(Boolean).join(', '),
    price,
    currency: str(first.priceCurrency) || null,
  };
}

export function jsonLdProducts(doc) {
  const products = [];
  const scripts = findAll(doc, (n) => n.tag === 'script' && /ld\+json/i.test(n.attrs.type || ''));
  for (const s of scripts) {
    const data = parseJsonLoose(s.text);
    if (!data) continue;
    const visit = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 8) return;
      if (Array.isArray(o)) { for (const x of o) visit(x, depth + 1); return; }
      // Lists of other products (related items, breadcrumbs) are not the page's product.
      if (typeIs(o, 'itemlist', 'breadcrumblist', 'offercatalog', 'searchresultspage')) return;
      if (typeIs(o, 'product', 'productgroup', 'productmodel', 'individualproduct', 'book', 'game', 'vehicle')) {
        products.push(ldProduct(o));
        return;
      }
      for (const k of Object.keys(o)) {
        if (k === '@context') continue;
        const v = o[k];
        if (v && typeof v === 'object') visit(v, depth + 1);
      }
    };
    visit(data, 0);
  }
  return products;
}

function pathOf(u, base) {
  try { return new URL(u, base || 'https://x.invalid').pathname.replace(/\/+$/, '').toLowerCase(); } catch { return ''; }
}

function pickProduct(products, sku, url) {
  if (!products.length) return null;
  if (sku) {
    const s = String(sku).toLowerCase();
    const bySku = products.find((p) => p.ids.includes(s));
    if (bySku) return bySku;
  }
  if (url) {
    const path = pathOf(url);
    const byUrl = products.find((p) => p.url && pathOf(p.url, url) === path);
    if (byUrl) return byUrl;
  }
  return products.find((p) => p.status) || products[0];
}

// ---------------------------------------------------------------------------
// Block / not-found page detection
// ---------------------------------------------------------------------------

const BLOCK_TITLE_RE = /access denied|pardon our interruption|request unsuccessful|attention required|just a moment|verify (you are|you're) (a )?human|are you a robot|robot check|security check|bot (detection|protection)|unusual traffic|you have been blocked|forbidden|too many requests/i;
const BLOCK_BODY_RE = /_Incapsula_Resource|cf-chl-|cf_chl_|px-captcha|captcha-delivery\.com|\/_sec\/cp_challenge|KPSDK|ak_bmsc_challenge|errors\.edgesuite\.net|Reference #\d+\.[0-9a-f]+\.\d+/i;

export function looksBlocked(html, title) {
  if (title && BLOCK_TITLE_RE.test(title)) return true;
  // Challenge pages are small; a full product page that merely loads a bot-protection script is not a block.
  const s = String(html || '');
  return s.length < 80000 && BLOCK_BODY_RE.test(s);
}

const NOT_FOUND_RE = /\b(page|product) (not found|cannot be found|could not be found|no longer (exists|available))\b|\b404\b|we can.?t (seem to )?find (that|the|this) page|oops/i;

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * @param {string} html
 * @param {{url?: string, sku?: string, hints?: object}} opts
 * @returns {{status, title, price, currency, sku, image, signals, decidedBy, blocked}}
 */
export function extractProduct(html, { url = '', sku = '', hints = {} } = {}) {
  const doc = parseHTML(html);
  const skip = makeSkip(hints);
  const signals = [];
  const out = { status: STATUS.UNKNOWN, title: null, price: null, currency: null, sku: null, image: null, signals, decidedBy: null, blocked: false };

  // 1. JSON-LD structured data.
  const products = jsonLdProducts(doc);
  const main = pickProduct(products, sku, url);
  if (main) {
    out.title = main.name;
    out.sku = main.sku;
    out.price = main.price;
    out.currency = main.currency;
    out.image = main.image;
    if (main.status) signals.push({ source: 'json-ld', status: main.status, detail: main.availabilityRaw });
  }

  // 2. Meta tags (OpenGraph / Facebook product tags).
  const meta = {};
  for (const m of findAll(doc, (n) => n.tag === 'meta')) {
    const key = (m.attrs.property || m.attrs.name || '').toLowerCase();
    if (key && m.attrs.content !== undefined && !(key in meta)) meta[key] = m.attrs.content;
  }
  const metaAvail = meta['product:availability'] ?? meta['og:availability'] ?? meta['og:product:availability'] ?? meta['availability'] ?? meta['product:stock'];
  if (metaAvail !== undefined) {
    const st = mapAvailability(metaAvail) || classifyAvailabilityText(metaAvail);
    if (st) signals.push({ source: 'meta', status: st, detail: metaAvail });
  }
  if (out.price === null) out.price = parsePrice(meta['product:price:amount'] ?? meta['og:price:amount'] ?? meta['product:sale_price:amount']);
  if (!out.currency) out.currency = meta['product:price:currency'] ?? meta['og:price:currency'] ?? null;
  if (!out.title) out.title = meta['og:title'] || meta['twitter:title'] || null;
  if (!out.image) out.image = meta['og:image'] || null;

  // 3. Microdata (itemprop="availability").
  const md = findFirst(doc, (n) => n.attrs.itemprop === 'availability', skip);
  if (md) {
    const raw = md.attrs.href || md.attrs.content || textContent(md);
    const st = mapAvailability(raw) || classifyAvailabilityText(raw);
    if (st) signals.push({ source: 'microdata', status: st, detail: raw });
  }
  if (out.price === null) {
    const mp = findFirst(doc, (n) => n.attrs.itemprop === 'price', skip);
    if (mp) out.price = parsePrice(mp.attrs.content ?? textContent(mp));
  }

  // 4. Stock message elements ("In stock", "Sold out online", ...).
  const availRe = hints.availabilityRe || /(^|[\s_-])(availability|availabilty|stock[-_]?(status|level|message|info|indicator|label|state|availability|msg)|inventory[-_]?(status|message|level)|product[-_]?stock|delivery[-_]?(status|availability)|online[-_]?(stock|availability))([\s_-]|$)/i;
  const availEls = findAll(doc, (n) => n.tag !== 'script' && n.tag !== 'meta' && availRe.test(identity(n)), skip);
  for (const n of availEls) {
    const t = textContent(n);
    const st = classifyAvailabilityText(t);
    if (st) { signals.push({ source: 'availability', status: st, detail: t.slice(0, 80) }); break; }
  }

  // 5. Buy buttons.
  const buttonRe = /\b(btn|button)\b|add-?to-?(cart|bag|basket)|buy|pre-?order|notify|sold-?out/i;
  const buttons = findAll(doc, (n) =>
    n.tag === 'button'
    || (n.tag === 'input' && /^(submit|button)$/i.test(n.attrs.type || ''))
    || n.attrs.role === 'button'
    || (n.tag === 'a' && buttonRe.test(identity(n))), skip);
  for (const b of buttons) {
    const text = textContent(b) || b.attrs.value || b.attrs['aria-label'] || b.attrs.title || '';
    const st = classifyActionText(text);
    if (!st) continue;
    const disabled = 'disabled' in b.attrs || b.attrs['aria-disabled'] === 'true'
      || /(^|\s)(disabled|is-disabled|btn--disabled|button--disabled|btn-disabled)(\s|$)/i.test(b.attrs.class || '')
      || insideDisabledFieldset(b);
    if ((st === STATUS.IN_STOCK || st === STATUS.PREORDER) && disabled) {
      signals.push({ source: 'button', status: STATUS.OUT_OF_STOCK, detail: `"${text.slice(0, 40)}" (disabled)` });
    } else {
      signals.push({ source: 'button', status: st, detail: `"${text.slice(0, 40)}"` });
    }
    break;
  }

  // 6. State classes on the product container (WooCommerce and many themes).
  const classEl = findFirst(doc, (n) => /(^|\s)(instock|in-stock|outofstock|out-of-stock|sold-out|soldout|onbackorder|is-preorder|coming-soon)(\s|$)/i.test(n.attrs.class || ''), skip);
  if (classEl) {
    const m = (classEl.attrs.class || '').match(/(^|\s)(instock|in-stock|outofstock|out-of-stock|sold-out|soldout|onbackorder|is-preorder|coming-soon)(\s|$)/i);
    const st = mapAvailability(m[2].replace('is-', ''));
    if (st) signals.push({ source: 'class', status: st, detail: m[2] });
  }

  // Title / price fallbacks.
  const h1 = findFirst(doc, (n) => n.tag === 'h1');
  const h1Text = h1 ? textContent(h1) : '';
  const titleEl = findFirst(doc, (n) => n.tag === 'title');
  const pageTitle = titleEl ? textContent(titleEl) : '';
  if (!out.title) out.title = h1Text || pageTitle || null;
  if (out.price === null) {
    const pe = findFirst(doc, (n) => /(^|[\s_-])price([\s_-]|$)|product-?price|price-?(now|current|value|sale)/i.test(identity(n)) && /\$\s?\d/.test(textContent(n)), skip);
    if (pe) out.price = parsePrice(textContent(pe).match(/\$\s?[\d,]+(\.\d{1,2})?/)?.[0]);
  }

  // Decide.
  const order = hints.priority || ['json-ld', 'meta', 'microdata', 'availability', 'button', 'class'];
  for (const src of order) {
    const s = signals.find((x) => x.source === src);
    if (s) { out.status = s.status; out.decidedBy = src; break; }
  }

  if (out.status === STATUS.UNKNOWN) {
    if (looksBlocked(html, pageTitle)) {
      out.status = STATUS.BLOCKED;
      out.blocked = true;
    } else if (!main && NOT_FOUND_RE.test(`${pageTitle} ${h1Text}`)) {
      out.status = STATUS.NOT_FOUND;
    }
  }
  if (out.title) out.title = out.title.replace(/\s+/g, ' ').trim().slice(0, 200);
  return out;
}

function insideDisabledFieldset(n) {
  for (let p = n.parent; p; p = p.parent) if (p.tag === 'fieldset' && 'disabled' in p.attrs) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Search / listing pages
// ---------------------------------------------------------------------------

export function slugWords(pathname) {
  const segs = String(pathname || '').split('/').filter((s) => s && /[a-z]/i.test(s) && !s.includes('='));
  // The product slug is the segment with the most words (later segments win ties,
  // so ".../toys-and-collectibles/123-pokemon-etb-box" picks the product, not the category).
  const wordCount = (s) => s.split(/[-_+]+/).filter(Boolean).length;
  let best = '';
  for (const s of segs) if (wordCount(s) >= wordCount(best)) best = s;
  let words;
  try { words = decodeURIComponent(best); } catch { words = best; }
  return words.replace(/\.(html?|aspx|php)$/i, '').replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Find links to product pages on a search/category page. Looks at anchors and
 * at URLs embedded in inline JSON (server-rendered app state).
 */
export function extractProductLinks(html, baseUrl, pathRe, { max = 80 } = {}) {
  const doc = parseHTML(html);
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const host = base.hostname.replace(/^www\./, '');
  const map = new Map();
  const add = (href, name) => {
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) return;
    let u;
    try { u = new URL(href, base); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    if (u.hostname.replace(/^www\./, '') !== host) return;
    if (!pathRe.test(u.pathname)) return;
    u.hash = '';
    u.search = '';
    const key = u.pathname.replace(/\/+$/, '').toLowerCase();
    const nm = cleanName(name);
    const prev = map.get(key);
    if (!prev) map.set(key, { url: u.href, name: nm, slug: slugWords(u.pathname) });
    else if (nm && nm.length > prev.name.length) prev.name = nm;
  };
  for (const a of findAll(doc, (n) => n.tag === 'a' && n.attrs.href)) {
    let name = textContent(a) || a.attrs.title || a.attrs['aria-label'] || '';
    if (!name) {
      const img = findFirst(a, (n) => n.tag === 'img' && n.attrs.alt);
      if (img) name = img.attrs.alt;
    }
    add(a.attrs.href, name);
  }
  for (const s of findAll(doc, (n) => n.tag === 'script' && n.text)) {
    const text = s.text.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/');
    for (const m of text.matchAll(/["'](https?:\/\/[^"'\s<>\\]+|\/[^"'\s<>\\]{3,})["']/g)) add(m[1], '');
    if (map.size > max * 3) break;
  }
  return [...map.values()].slice(0, max).map((h) => ({ ...h, name: h.name || titleCase(h.slug) }));
}

function titleCase(s) {
  return String(s || '').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export { parseHTML, walk };
