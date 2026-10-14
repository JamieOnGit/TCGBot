// Checkout assist: in your logged-in browser window it adds the product to the
// cart, goes to checkout, fills in your details step by step, and STOPS at the
// final "Place order"/"Pay now" button so you make the purchase yourself.
//
// When it hits something only a person should do — a CAPTCHA, a queue, a
// login, or a field it doesn't understand — it pauses, alerts you, and carries
// on once you've dealt with it. It never clicks the final purchase button.

import fs from 'node:fs';
import path from 'node:path';
import { classifyActionText } from './extract.js';
import { STATUS } from './status.js';
import { autofillPage, profileValues } from './autofill.js';
import { pageScanButtons, pageState, pageSignature, pageHighlightFinal, pageBanner } from './pagescripts.js';

const EXCLUDE_RE = /paypal|afterpay|zip ?pay|\bzip\b|klarna|humm|latitude|apple ?pay|google ?pay|\bg ?pay\b|shop ?pay|amazon ?pay|laybuy|openpay|sign ?in|log ?in|register|create (an )?account|continue shopping|keep shopping|\bback\b|\bedit\b|\bchange\b|remove|delete|cancel|apply|gift ?card|voucher|promo|coupon|discount|wish ?list|save for later|newsletter|subscribe|view (cart|bag|basket)|close/;
const FINAL_RE = /^(place (my |your )?order( (and|&) pay| now)?|pay now|pay securely( now)?|complete (my |your )?(order|purchase|payment)|submit (my )?(order|payment)|confirm (and|&) pay|confirm (my )?(order|purchase|payment)|pay \$?\s?[\d,.]+( now)?|purchase|place your order and pay|buy now and pay|complete checkout)$/;
const GUEST_RE = /^(continue as (a )?guest|guest checkout|check ?out as (a )?guest|continue (without|w\/o) (an )?account|checkout as guest)$/;
const MANUAL_RE = /enter (your |the |an )?address manually|enter (it )?manually|manual(ly)? (address|entry)|can.?t find (your |my )?address|add (an )?address manually|type (your )?address/;
const CONTINUE_RE = /^(continue|next|proceed|save (and|&) continue|continue to [a-z ]{3,30}|proceed to [a-z ]{3,30}|go to (delivery|shipping|payment|review|checkout)|use this address|use (this|selected) (address|delivery|shipping|payment)( method| option)?|deliver (here|to this address)|ship (here|to this address)|confirm (address|delivery|shipping)( details)?|review (my |your )?order|continue (to )?checkout|next step|save address|deliver to this address)$/;
const CHECKOUT_RE = /^((secure |proceed to |go to )?check ?out( now| securely)?|checkout now|begin checkout|start checkout)$/;
const CONFIRM_URL_RE = /order-?confirm|confirmation|thank-?you|\/thanks|order-?complete|order-?received|checkout\/success|orderconfirmation|order-?success/i;
const CONFIRM_TEXT_RE = /thank you for (your )?(order|purchase)|your order (has been|is|was) (placed|confirmed|received|successful)|order (confirmation|confirmed|complete)\b|order (number|no\.?|#|reference)\s*[:#]?\s*[a-z0-9-]{4,}/i;

const ANALYTICS_RE = /collect|analytics|track|event|beacon|\blog\b|metrics|telemetry|pixel|gtm|doubleclick|facebook|tiktok|hotjar|segment|optimizely|newrelic|sentry|datadog/i;
const CART_REQ_RE = /cart|basket|bag|add|graphql|checkout|order|item|line/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normText(t) {
  return String(t || '').toLowerCase().replace(/[›»→>←‹«]/g, ' ').replace(/[^a-z0-9$.,&/' -]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** What does a checkout-page button do? 'final' | 'guest' | 'manual' | 'continue' | 'checkout' | null */
export function classifyCheckoutButton(text) {
  const t = normText(text);
  if (!t || t.length > 60) return null;
  if (MANUAL_RE.test(t)) return 'manual';
  if (EXCLUDE_RE.test(t)) return null;
  if (FINAL_RE.test(t)) return 'final';
  if (GUEST_RE.test(t)) return 'guest';
  if (CONTINUE_RE.test(t)) return 'continue';
  if (CHECKOUT_RE.test(t)) return 'checkout';
  return null;
}

export function isConfirmationPage({ url, text }) {
  return CONFIRM_URL_RE.test(url || '') || CONFIRM_TEXT_RE.test(text || '');
}

export class Assist {
  /**
   * @param {{browser, store, vault, notifier, bus, dataDir: string, timeouts?: object}} deps
   */
  constructor({ browser, store, vault, notifier, bus, dataDir, timeouts = {} }) {
    this.browser = browser;
    this.store = store;
    this.vault = vault;
    this.notifier = notifier;
    this.bus = bus;
    this.dataDir = dataDir;
    this.t = {
      total: 180000, // automation budget before handing over
      human: 10 * 60 * 1000, // how long to wait for you to solve a CAPTCHA / log in
      atc: 15000,
      step: 10000,
      watchPurchase: 20 * 60 * 1000,
      ...timeouts,
    };
    this.running = new Map();
  }

  /**
   * @param {object} item  watch item
   * @param {import('./retailers/base.js').Retailer} retailer
   * @param {{url?: string, variantId?: number|string, mode?: 'cart'|'assist', onUpdate?: Function}} opts
   */
  async run(item, retailer, { url, variantId = null, mode = 'assist', onUpdate = () => {} } = {}) {
    const lockKey = retailer ? retailer.base : 'unknown';
    if (this.running.has(lockKey)) {
      this.bus.log('warn', `${item.name}: checkout assist already running at ${retailer.name} — skipping.`, { itemId: item.id });
      return { state: 'busy' };
    }
    this.running.set(lockKey, item.id);
    const t0 = Date.now();
    const update = (state, message) => {
      const info = { state, message, elapsedMs: Date.now() - t0 };
      onUpdate(info);
      this.bus.log(state === 'failed' ? 'error' : state === 'needs_you' ? 'warn' : state === 'ready' || state === 'in_cart' || state === 'purchased' ? 'success' : 'info',
        `[${retailer?.name || '?'}] ${item.name}: ${message}`, { itemId: item.id });
      return info;
    };
    let page = null;
    let handedOver = false;
    try {
      if (!retailer) throw new Error('Unknown retailer');
      if (!url && !variantId) throw new Error('No product page yet — the bot has not found a listing for this item.');
      update('running', mode === 'cart' ? 'Adding to cart…' : 'Starting checkout assist…');
      page = await this.browser.newPage();
      page.setDefaultTimeout(15000);
      const values = profileValues(this.store.profile, this.vault?.card || null);
      const qty = item.quantity || 1;

      if (retailer.platform === 'shopify' && variantId) {
        if (mode === 'cart') {
          await this.goto(page, retailer.addToCartUrl(variantId, qty));
          await page.bringToFront().catch(() => {});
          const info = update('in_cart', `In your cart (${Math.round((Date.now() - t0) / 100) / 10}s). Finish checkout in the browser window.`);
          this.alertDone(item, retailer, info, page.url(), 'In cart');
          handedOver = true;
          return info;
        }
        await this.goto(page, retailer.cartPermalink(variantId, qty));
        update('running', 'At checkout — filling in your details…');
      } else {
        await this.goto(page, url);
        await this.handleChallenge(page, item, update);
        await this.addToCart(page, item, qty, update);
        if (mode === 'cart') {
          if (retailer.cartUrl()) await this.goto(page, retailer.cartUrl());
          await page.bringToFront().catch(() => {});
          const info = update('in_cart', `In your cart (${Math.round((Date.now() - t0) / 100) / 10}s). Finish checkout in the browser window.`);
          this.alertDone(item, retailer, info, page.url(), 'In cart');
          handedOver = true;
          return info;
        }
        await this.goToCheckout(page, retailer, update);
      }

      const result = await this.checkoutLoop(page, item, values, update, t0);
      await page.bringToFront().catch(() => {});
      if (result.state === 'ready') {
        const secs = Math.round((Date.now() - t0) / 100) / 10;
        const info = update('ready', `Ready in ${secs}s — review and click "${result.button}" in the browser window.${result.finalDisabled ? ' (The button is disabled: something on the page still needs your input.)' : ''}`);
        this.alertDone(item, retailer, info, page.url(), 'READY TO BUY');
        handedOver = true;
        this.watchForPurchase(page, item, update);
        return info;
      }
      if (result.state === 'purchased') {
        const info = update('purchased', 'Order confirmation page detected.');
        handedOver = true;
        return info;
      }
      const info = update('needs_you', result.message || 'Handing over to you in the browser window.');
      this.notifier.alert({ level: 'warning', title: `Needs you: ${item.name}`, message: info.message, url: page.url(), itemId: item.id });
      handedOver = true;
      return info;
    } catch (e) {
      const message = e.message.split('\n')[0];
      const shot = page ? await this.screenshot(page, item).catch(() => null) : null;
      const info = update('failed', message + (shot ? ` (screenshot: ${shot})` : ''));
      this.notifier.alert({ level: 'error', title: `Checkout assist failed: ${item.name}`, message, url: page && !page.isClosed() ? page.url() : url, itemId: item.id });
      if (page && !page.isClosed()) {
        await page.evaluate(pageBanner, `TCGBot couldn't finish automatically: ${message}`).catch(() => {});
        await page.bringToFront().catch(() => {});
        handedOver = true;
      }
      return { ...info, error: message };
    } finally {
      this.running.delete(lockKey);
      if (!handedOver && page && !page.isClosed()) await page.close().catch(() => {});
    }
  }

  alertDone(item, retailer, info, url, label) {
    this.notifier.alert({
      level: 'urgent',
      title: `${label}: ${item.name} @ ${retailer.name}`,
      message: info.message,
      url,
      itemId: item.id,
    });
  }

  async goto(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }

  async settle(page) {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await sleep(250);
  }

  async state(page) {
    for (let i = 0; i < 3; i++) {
      try {
        return await page.evaluate(pageState);
      } catch {
        await sleep(300); // navigating
      }
    }
    return { url: page.url(), title: '', text: '', challenge: null, hasPassword: false, sig: String(Math.random()) };
  }

  async buttons(page) {
    try {
      return await page.evaluate(pageScanButtons);
    } catch {
      return [];
    }
  }

  async click(page, key) {
    await page.locator(`[data-tcgbot-b="${key}"]`).first().click({ timeout: 8000 });
  }

  async waitForChange(page, before, timeout = this.t.step) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      await sleep(200);
      let sig;
      try {
        sig = await page.evaluate(pageSignature);
      } catch {
        sig = null; // navigation in progress
      }
      if (sig !== before) {
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await sleep(200);
        return true;
      }
    }
    return false;
  }

  /** Pause for the human while a CAPTCHA/queue is on screen. */
  async handleChallenge(page, item, update) {
    let st = await this.state(page);
    if (!st.challenge) return;
    const what = st.challenge === 'queue' ? 'a queue / waiting room' : 'a CAPTCHA / "are you human" check';
    const info = update('needs_you', `The site is showing ${what}. Complete it in the browser window — the bot will carry on automatically.`);
    this.notifier.alert({ level: 'warning', title: `Action needed: ${item.name}`, message: info.message, url: st.url, itemId: item.id });
    await page.evaluate(pageBanner, 'TCGBot is paused: please complete this check. It will continue automatically.').catch(() => {});
    await page.bringToFront().catch(() => {});
    const end = Date.now() + this.t.human;
    while (Date.now() < end) {
      if (page.isClosed()) throw new Error('Browser tab was closed');
      await sleep(1000);
      st = await this.state(page);
      if (!st.challenge) {
        update('running', 'Check passed — continuing…');
        await page.evaluate(() => document.getElementById('tcgbot-banner')?.remove()).catch(() => {});
        return;
      }
    }
    throw new Error('Timed out waiting for the CAPTCHA/queue to be completed');
  }

  async addToCart(page, item, qty, update) {
    update('running', 'Adding to cart…');
    if (qty > 1) {
      try {
        const q = page.locator('input[name*="qty" i]:visible, input[name*="quantity" i]:visible, input[id*="quantity" i]:visible').first();
        if (await q.count()) await q.fill(String(qty), { timeout: 2000 });
      } catch { /* keep default quantity */ }
    }
    const start = Date.now();
    while (Date.now() - start < this.t.atc) {
      const btns = await this.buttons(page);
      const candidates = btns.filter((b) => !b.chrome && !b.footer);
      const atc = candidates.find((b) => {
        const st = classifyActionText(b.text);
        return (st === STATUS.IN_STOCK || st === STATUS.PREORDER) && !b.disabled;
      });
      if (atc) {
        const before = page.url();
        const resp = page.waitForResponse((r) => {
          const req = r.request();
          if (req.method() === 'GET' && req.resourceType() !== 'document') return false;
          const u = r.url();
          return CART_REQ_RE.test(u) && !ANALYTICS_RE.test(u);
        }, { timeout: 8000 }).catch(() => null);
        const nav = page.waitForURL((u) => u.href !== before, { timeout: 8000 }).catch(() => null);
        await this.click(page, atc.key);
        await Promise.race([resp, nav]);
        await sleep(500);
        update('running', `Clicked "${atc.text}"`);
        return;
      }
      const sold = candidates.find((b) => classifyActionText(b.text) === STATUS.OUT_OF_STOCK || classifyActionText(b.text) === STATUS.COMING_SOON);
      if (sold && Date.now() - start > 3000) {
        throw new Error(`The product page says "${sold.text}" — it can't be added to cart right now.`);
      }
      await this.handleChallenge(page, item, update);
      await sleep(400); // the page may still be loading its buy box
    }
    throw new Error("Couldn't find an Add to cart / Pre-order button on the product page.");
  }

  async goToCheckout(page, retailer, update) {
    update('running', 'Going to checkout…');
    // 1. A checkout button that appeared after adding (mini-cart drawer / popup).
    for (let i = 0; i < 3; i++) {
      const btns = await this.buttons(page);
      const c = btns.find((b) => classifyCheckoutButton(b.text) === 'checkout' && !b.disabled);
      if (c) {
        const before = await page.evaluate(pageSignature).catch(() => '');
        await this.click(page, c.key).catch(() => {});
        if (await this.waitForChange(page, before)) return;
      }
      await sleep(300);
    }
    // 2. The cart page's checkout button.
    if (retailer.cartUrl()) {
      await this.goto(page, retailer.cartUrl());
      await this.settle(page);
      for (let i = 0; i < 6; i++) {
        const btns = await this.buttons(page);
        const c = btns.find((b) => classifyCheckoutButton(b.text) === 'checkout' && !b.disabled);
        if (c) {
          const before = await page.evaluate(pageSignature).catch(() => '');
          await this.click(page, c.key);
          await this.waitForChange(page, before);
          return;
        }
        await sleep(500);
      }
    }
    // 3. Go straight to the checkout URL.
    if (retailer.checkoutUrl()) {
      await this.goto(page, retailer.checkoutUrl());
      return;
    }
    throw new Error("Couldn't find the checkout button in the cart.");
  }

  async checkoutLoop(page, item, values, update, t0) {
    const deadline = t0 + this.t.total;
    let lastClick = null;
    let repeats = 0;
    let idle = 0;
    let manualTried = false;
    let step = 0;
    while (Date.now() < deadline) {
      step += 1;
      if (page.isClosed()) throw new Error('Browser tab was closed');
      await this.settle(page);
      const st = await this.state(page);
      if (isConfirmationPage(st)) return { state: 'purchased' };
      if (st.challenge) {
        await this.handleChallenge(page, item, update);
        continue;
      }

      const fill = await autofillPage(page, values);
      if (fill.filled.length) update('running', `Step ${step}: filled ${[...new Set(fill.filled)].join(', ')}`);
      const btns = (await this.buttons(page)).map((b) => ({ ...b, kind: classifyCheckoutButton(b.text) }));
      const finals = btns.filter((b) => b.kind === 'final');
      const finalEnabled = finals.find((b) => !b.disabled);
      const next = btns.find((b) => b.kind === 'guest' && !b.disabled)
        || btns.find((b) => b.kind === 'continue' && !b.disabled)
        || btns.find((b) => b.kind === 'checkout' && !b.disabled && !b.chrome);

      if (finalEnabled) {
        await page.evaluate(pageHighlightFinal, finalEnabled.key).catch(() => {});
        return { state: 'ready', button: finalEnabled.text, fill };
      }

      if (st.hasPassword && !btns.some((b) => b.kind === 'guest')) {
        await this.waitForHuman(page, item, update, 'Please log in to your account in the browser window (one time — the bot remembers it). It will carry on automatically.', (s) => !s.hasPassword);
        continue;
      }

      if (!manualTried && !fill.kinds.has('address1') && (fill.addressLookup || fill.kinds.has('suburb') || fill.kinds.has('postcode'))) {
        const man = btns.find((b) => b.kind === 'manual');
        if (man) {
          manualTried = true;
          await this.click(page, man.key).catch(() => {});
          await sleep(400);
          continue;
        }
      }

      if (next) {
        const sig = `${st.url}|${next.text}`;
        repeats = sig === lastClick ? repeats + 1 : 0;
        lastClick = sig;
        if (repeats >= 2) {
          const missing = [...new Set(fill.unknownRequired)].slice(0, 5).join(', ');
          await this.waitForHuman(page, item, update,
            `Stuck at this step${missing ? ` — fields the bot can't fill: ${missing}` : ''}. Fix it in the browser window and click "${next.text}"; the bot will continue.`,
            (s) => s.sig !== st.sig);
          repeats = 0;
          lastClick = null;
          continue;
        }
        const before = await page.evaluate(pageSignature).catch(() => '');
        update('running', `Step ${step}: clicking "${next.text}"`);
        await this.click(page, next.key).catch(() => {});
        await this.waitForChange(page, before);
        idle = 0;
        continue;
      }

      if (finals.length) {
        // A final button exists but is disabled and there's nothing else to press.
        await page.evaluate(pageHighlightFinal, finals[0].key).catch(() => {});
        return { state: 'ready', button: finals[0].text, fill, finalDisabled: true };
      }

      idle += 1;
      if (idle > 8) {
        await this.waitForHuman(page, item, update, "Couldn't find the next step on this page. Continue in the browser window — the bot picks up again on the next page.", (s) => s.sig !== st.sig);
        idle = 0;
        continue;
      }
      await sleep(500);
    }
    return { state: 'needs_you', message: 'Took too long to reach the final step — please finish in the browser window.' };
  }

  async waitForHuman(page, item, update, message, doneWhen) {
    const info = update('needs_you', message);
    this.notifier.alert({ level: 'warning', title: `Needs you: ${item.name}`, message: info.message, url: page.url(), itemId: item.id });
    await page.evaluate(pageBanner, `TCGBot is paused: ${message}`).catch(() => {});
    await page.bringToFront().catch(() => {});
    const end = Date.now() + this.t.human;
    while (Date.now() < end) {
      if (page.isClosed()) throw new Error('Browser tab was closed');
      await sleep(1000);
      const s = await this.state(page);
      if (doneWhen(s)) {
        update('running', 'Continuing…');
        await page.evaluate(() => document.getElementById('tcgbot-banner')?.remove()).catch(() => {});
        return;
      }
    }
    throw new Error('Timed out waiting for you');
  }

  /** After handing over, notice when you complete the order (so the item stops). */
  watchForPurchase(page, item, update) {
    const end = Date.now() + this.t.watchPurchase;
    const tick = async () => {
      if (page.isClosed() || Date.now() > end) return;
      const st = await this.state(page).catch(() => null);
      if (st && isConfirmationPage(st)) {
        update('purchased', 'Order placed — confirmation page detected. This item has been paused.');
        this.notifier.alert({ level: 'success', title: `Order placed: ${item.name}`, message: 'Confirmation page detected. The item has been paused so it won\'t buy again.', url: st.url, itemId: item.id });
        return;
      }
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 2000);
  }

  async screenshot(page, item) {
    const dir = path.join(this.dataDir, 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const file = `${item.id}-${Date.now()}.png`;
    await page.screenshot({ path: path.join(dir, file), fullPage: false, timeout: 5000 });
    // Keep the 30 most recent.
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 30))) fs.unlinkSync(path.join(dir, f));
    return file;
  }
}
