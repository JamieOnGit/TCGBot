/* TCGCopBot — your card, kept only in this browser.

   The card is encrypted with a passphrase you choose (PBKDF2-SHA256 →
   AES-256-GCM) and saved in the extension's own storage under the account
   it belongs to. It is never sent to the TCGCopBot server. Unlocking keeps
   the card in memory-only session storage (cleared when the browser closes,
   or sooner if you choose), which web pages can't read. Another account
   connected to this browser can't see or use it. */

var TCBVault = (function () {
  'use strict';

  var ITERATIONS = 310000;
  var enc = new TextEncoder();
  var dec = new TextDecoder();

  function b64(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function unb64(s) {
    return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); });
  }
  var vaultKey = function (userId) { return 'vault:' + userId; };
  var openKey = function (userId) { return 'card:' + userId; };

  async function deriveKey(passphrase, salt) {
    var base = await crypto.subtle.importKey('raw', enc.encode(String(passphrase).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  function luhn(num) {
    var sum = 0;
    for (var i = 0; i < num.length; i++) {
      var d = +num[num.length - 1 - i];
      if (i % 2) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return sum % 10 === 0;
  }

  function brandOf(num) {
    if (/^4/.test(num)) return 'Visa';
    if (/^(5[1-5]|2[2-7])/.test(num)) return 'Mastercard';
    if (/^3[47]/.test(num)) return 'Amex';
    return 'Card';
  }

  /** Check and tidy card details. Throws an Error with a friendly message. */
  function normalizeCard(input) {
    var number = String(input.number || '').replace(/[\s-]/g, '');
    if (!/^\d{12,19}$/.test(number) || !luhn(number)) throw new Error('That card number doesn\'t look right');
    var name = String(input.name || '').trim().slice(0, 80);
    var m = String(input.expiry || '').match(/^\s*(\d{1,2})\s*\/\s*(\d{2}|\d{4})\s*$/);
    var expMonth = m ? parseInt(m[1], 10) : parseInt(input.expMonth, 10);
    var expYear = m ? parseInt(m[2], 10) : parseInt(input.expYear, 10);
    if (expYear < 100) expYear += 2000;
    if (!(expMonth >= 1 && expMonth <= 12) || !(expYear >= 2000 && expYear < 2100)) throw new Error('Expiry should look like MM/YY');
    var now = new Date();
    if (expYear < now.getFullYear() || (expYear === now.getFullYear() && expMonth < now.getMonth() + 1)) throw new Error('That card has expired');
    var cvc = String(input.cvc || '').trim();
    if (cvc && !/^\d{3,4}$/.test(cvc)) throw new Error('Security code (CVV) is 3 or 4 digits');
    return { number: number, name: name, expMonth: String(expMonth).padStart(2, '0'), expYear: String(expYear), cvc: cvc };
  }

  async function save(userId, input, passphrase) {
    if (!userId) throw new Error('Connect the extension to your account first');
    if (String(passphrase || '').length < 6) throw new Error('Use a passphrase of at least 6 characters');
    var card = normalizeCard(input);
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var key = await deriveKey(passphrase, salt);
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode('tcgcopbot-card:' + userId) }, key, enc.encode(JSON.stringify(card)));
    var record = {
      v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct),
      last4: card.number.slice(-4), brand: brandOf(card.number), expMonth: card.expMonth, expYear: card.expYear, hasCvc: !!card.cvc, savedAt: Date.now(),
    };
    var set = {};
    set[vaultKey(userId)] = record;
    await chrome.storage.local.set(set);
    return status(userId);
  }

  /** hours: how long to stay unlocked (0 = until the browser closes). */
  async function unlock(userId, passphrase, hours) {
    var got = await chrome.storage.local.get(vaultKey(userId));
    var rec = got[vaultKey(userId)];
    if (!rec) throw new Error('No card saved for this account');
    var card;
    try {
      var key = await deriveKey(passphrase, unb64(rec.salt));
      var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv), additionalData: enc.encode('tcgcopbot-card:' + userId) }, key, unb64(rec.ct));
      card = JSON.parse(dec.decode(pt));
    } catch (e) {
      throw new Error('Wrong passphrase');
    }
    var set = {};
    set[openKey(userId)] = { card: card, until: hours ? Date.now() + hours * 3600 * 1000 : null };
    await chrome.storage.session.set(set);
    return status(userId);
  }

  async function lock(userId) {
    await chrome.storage.session.remove(openKey(userId));
  }

  async function remove(userId) {
    await chrome.storage.session.remove(openKey(userId));
    await chrome.storage.local.remove(vaultKey(userId));
  }

  /** The unlocked card, or null. */
  async function card(userId) {
    if (!userId) return null;
    var got = await chrome.storage.session.get(openKey(userId));
    var open = got[openKey(userId)];
    if (!open) return null;
    if (open.until && Date.now() > open.until) {
      await lock(userId);
      return null;
    }
    return open.card;
  }

  async function status(userId) {
    if (!userId) return { saved: false, unlocked: false };
    var got = await chrome.storage.local.get(vaultKey(userId));
    var rec = got[vaultKey(userId)];
    if (!rec) return { saved: false, unlocked: false };
    var openCard = await card(userId);
    var s = await chrome.storage.session.get(openKey(userId));
    return {
      saved: true, unlocked: !!openCard, until: openCard && s[openKey(userId)] ? s[openKey(userId)].until : null,
      last4: rec.last4, brand: rec.brand, expMonth: rec.expMonth, expYear: rec.expYear, hasCvc: rec.hasCvc,
    };
  }

  return { save: save, unlock: unlock, lock: lock, remove: remove, card: card, status: status, normalizeCard: normalizeCard };
})();
