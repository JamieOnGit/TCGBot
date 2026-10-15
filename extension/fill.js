/* TCGBot Quick Checkout — checkout autofill (runs in the page, and in card
   iframes). Fills empty fields from your TCGBot profile/card, presses the
   "Continue to …" step buttons, and STOPS at the final button ("Checkout
   securely", "Place order", "Pay now"…) — that one is never pressed. */

var TCGBotFill = (function () {
  'use strict';

  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var toArray = function (l) { return Array.prototype.slice.call(l); };

  var AU_STATES = { NSW: 'New South Wales', VIC: 'Victoria', QLD: 'Queensland', WA: 'Western Australia', SA: 'South Australia', TAS: 'Tasmania', ACT: 'Australian Capital Territory', NT: 'Northern Territory' };
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  var AUTOCOMPLETE = {
    email: 'email', tel: 'phone', 'tel-national': 'phone', 'given-name': 'firstName', 'family-name': 'lastName', name: 'fullName',
    'address-line1': 'address1', 'street-address': 'address1', 'address-line2': 'address2', 'address-level2': 'suburb', 'address-level1': 'state',
    'postal-code': 'postcode', country: 'country', 'country-name': 'country', 'cc-number': 'cardNumber', 'cc-name': 'cardName',
    'cc-exp': 'cardExpiry', 'cc-exp-month': 'cardExpMonth', 'cc-exp-year': 'cardExpYear', 'cc-csc': 'cardCvc',
  };
  // First match wins (same rules the dashboard's checkout assist uses).
  var RULES = [
    ['addressLookup', /(start typing|search|find|look ?up|lookup|enter).{0,25}address|address.{0,15}(search|finder|lookup|look ?up|autocomplete|autofill)/],
    [null, /company|business|organi[sz]ation|\babn\b|gift|message|instruction|comment|\bnote|coupon|promo|voucher|discount|referral|username|date of birth|\bdob\b|birthday|po number|reference|password/],
    ['cardNumber', /card.?number|cardnumber|cc.?num|encryptedcardnumber|credit.?card.?(no|num)|\bpan\b|card no\b/],
    ['cardCvc', /\bcvv|\bcvc|\bcsc\b|security.?code|verification.?value|encryptedsecuritycode|card.?code|\bcvn\b/],
    ['cardExpMonth', /exp\w*.?month|cc.?month|expirymonth|encryptedexpirymonth|card.?month/],
    ['cardExpYear', /exp\w*.?year|cc.?year|expiryyear|encryptedexpiryyear|card.?year/],
    ['cardExpiry', /expir|exp.?date|mm\s*\/\s*yy|encryptedexpirydate|valid.?(thru|until)|\bexp\b/],
    ['cardName', /name.?on.?card|card.?holder|cardholder|holder.?name|cc.?name|card.?name|nameoncard/],
    ['email', /e-?mail/],
    ['phone', /phone|mobile|\btel\b|telephone|contact.?number/],
    ['firstName', /first.?name|given.?name|\bfname\b|firstname/],
    ['lastName', /last.?name|surname|family.?name|\blname\b|lastname/],
    ['address2', /address.?(line)?.?2|addr(ess)?2|apartment|\bunit\b|suite|\bapt\b|line ?2/],
    ['address1', /address.?(line)?.?1|addr(ess)?1|street|\baddress\b|line ?1/],
    ['suburb', /suburb|city|town|locality/],
    ['postcode', /post.?code|postal|\bzip\b/],
    ['country', /country/],
    ['state', /\bstate\b|province|region|territory/],
    ['fullName', /full.?name|\bname\b|recipient/],
  ];
  var CARD_KINDS = ['cardNumber', 'cardCvc', 'cardExpMonth', 'cardExpYear', 'cardExpiry', 'cardName'];

  // Buttons
  var FINAL_RE = /^(check ?out securely|place (my |your )?order( (and|&) pay| now)?|place your order|pay now|pay securely( now)?|complete (my |your )?(order|purchase|payment)|submit (my )?(order|payment)|confirm (and|&) pay|confirm (my )?(order|purchase|payment)|pay \$?\s?[\d,.]+( now)?|buy now and pay|complete checkout)$/;
  var STEP_RE = /^(continue to (details|delivery|shipping|payment|review|checkout)|continue|next|next step|proceed( to (delivery|shipping|payment|checkout))?|save (and|&) continue|use this address|deliver (here|to this address)|ship to this address|confirm (address|delivery|details)|review (my |your )?order)$/;
  var GUEST_RE = /^(continue as (a )?guest|guest checkout|check ?out as (a )?guest)$/;
  var MANUAL_RE = /enter (your |the |an )?address manually|enter (it )?manually|manual(ly)? (address|entry)|can.?t find (your |my )?address|add (an )?address manually|type (your )?address/;
  var EXCLUDE_RE = /paypal|afterpay|\bzip\b|klarna|humm|latitude|apple ?pay|google ?pay|shop ?pay|sign ?in|log ?in|register|create (an )?account|continue shopping|keep shopping|\bback\b|\bedit\b|\bchange\b|remove|delete|cancel|apply|gift ?card|voucher|promo|coupon|newsletter|subscribe|\+ ?add\b/;

  // ------------------------------------------------------------------------
  function isVisible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }
  function inPanel(el) {
    return !!el.closest('#tcgbot-qc, #tcgbot-quick-checkout, #kmart-upc-quick-checkout, #tcgbot-banner');
  }
  function textOf(el) {
    return (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
  }
  function norm(t) {
    return String(t || '').toLowerCase().replace(/[›»→>←‹«]/g, ' ').replace(/[^a-z0-9$.,&/' +-]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** 'final' | 'step' | 'guest' | 'manual' | null */
  function classifyButton(label) {
    var t = norm(label);
    if (!t || t.length > 60) return null;
    if (MANUAL_RE.test(t)) return 'manual';
    if (FINAL_RE.test(t)) return 'final';
    if (EXCLUDE_RE.test(t)) return null;
    if (GUEST_RE.test(t)) return 'guest';
    if (STEP_RE.test(t)) return 'step';
    return null;
  }

  function labelText(el) {
    var parts = [];
    if (el.id) {
      try { var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) parts.push(l.innerText); } catch (e) { /* ignore */ }
    }
    var wrap = el.closest('label');
    if (wrap) parts.push(wrap.innerText);
    var lb = el.getAttribute('aria-labelledby');
    if (lb) lb.split(/\s+/).forEach(function (id) { var x = document.getElementById(id); if (x) parts.push(x.innerText); });
    if (!parts.length && el.parentElement) {
      // Floating-label designs: the label is a sibling.
      var sib = el.parentElement.querySelector('label, legend, span');
      if (sib && sib !== el && (sib.innerText || '').length < 60) parts.push(sib.innerText);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function describe(el) {
    return [el.getAttribute('autocomplete'), el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'),
      el.getAttribute('data-fieldtype'), el.getAttribute('data-testid'), labelText(el)].filter(Boolean).join(' | ').toLowerCase().slice(0, 300);
  }

  function classifyField(el) {
    var type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (type === 'checkbox' || type === 'radio') return null;
    var desc = describe(el);
    var tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
    var last = tokens[tokens.length - 1];
    if (last && AUTOCOMPLETE[last]) {
      var k = AUTOCOMPLETE[last];
      return k === 'fullName' && /card|holder/.test(desc) ? 'cardName' : k;
    }
    if (type === 'email') return 'email';
    if (type === 'tel' && !/card|cvv|cvc|security/.test(desc)) return 'phone';
    for (var i = 0; i < RULES.length; i++) if (RULES[i][1].test(desc)) return RULES[i][0];
    return null;
  }

  /** What we can type, from your profile and (if unlocked) your card. */
  function fieldValues(profile, card) {
    profile = profile || {};
    var v = {
      email: profile.email || '', phone: profile.phone || '', firstName: profile.firstName || '', lastName: profile.lastName || '',
      fullName: [profile.firstName, profile.lastName].filter(Boolean).join(' '), address1: profile.address1 || '', address2: profile.address2 || '',
      suburb: profile.suburb || '', state: profile.state || '', postcode: profile.postcode || '', country: 'Australia',
    };
    if (card) {
      v.cardNumber = card.number;
      v.cardName = card.name;
      v.cardExpMonth = card.expMonth;
      v.cardExpYear = card.expYear;
      v.cardExpiry = card.expMonth + '/' + String(card.expYear).slice(-2);
      v.cardCvc = card.cvc || '';
    }
    return v;
  }

  function setNative(el, value) {
    var proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Type into a field like a person would (so formatters and frameworks notice). */
  function typeInto(el, value, kind) {
    el.focus();
    var ok = false;
    try { if (el.select) el.select(); ok = document.execCommand('insertText', false, value); } catch (e) { ok = false; }
    var digits = function (s) { return String(s || '').replace(/\D/g, ''); };
    var stuck = /^card(Number|Cvc|Expiry|ExpMonth|ExpYear)$/.test(kind) ? digits(el.value) === digits(value) : el.value === value;
    if (!ok || !stuck) setNative(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  }

  function chooseOption(kind, select, values) {
    var n = function (s) { return String(s == null ? '' : s).trim().toLowerCase(); };
    var opts = toArray(select.options).filter(function (o) { return o.value !== '' || o.textContent.trim(); });
    var exact = function (cands) {
      for (var i = 0; i < cands.length; i++) {
        if (!cands[i]) continue;
        var c = n(cands[i]);
        var o = opts.find(function (x) { return n(x.value) === c || n(x.textContent) === c; });
        if (o) return o.value;
      }
      return null;
    };
    if (kind === 'state') {
      var abbr = String(values.state || '').toUpperCase();
      var full = AU_STATES[abbr];
      if (!abbr) return null;
      var hit = exact([abbr, full]);
      if (hit !== null) return hit;
      var o = opts.find(function (x) { return full && n(x.textContent).indexOf(n(full)) !== -1; });
      return o ? o.value : null;
    }
    if (kind === 'country') {
      var c = exact(['AU', 'AUS', 'Australia']);
      if (c !== null) return c;
      var oc = opts.find(function (x) { return /australia/i.test(x.textContent); });
      return oc ? oc.value : null;
    }
    if (kind === 'cardExpMonth') {
      var m = parseInt(values.cardExpMonth, 10);
      var om = opts.find(function (x) { return parseInt(x.value, 10) === m || parseInt(x.textContent, 10) === m || n(x.textContent).indexOf(MONTHS[m - 1]) === 0; });
      return om ? om.value : null;
    }
    if (kind === 'cardExpYear') {
      var y = parseInt(values.cardExpYear, 10);
      var oy = opts.find(function (x) { return [x.value, x.textContent].some(function (s) { var k = parseInt(s, 10); return k === y || k === y % 100; }); });
      return oy ? oy.value : null;
    }
    return values[kind] ? exact([values[kind]]) : null;
  }

  function placeholderSelected(select) {
    if (!select.value) return true;
    var t = select.selectedIndex >= 0 ? select.options[select.selectedIndex].textContent : '';
    return /^(-+|select|choose|please|pick|state|country|month|year|mm|yy|yyyy)\b/i.test(t.trim());
  }

  function radioLabel(el) {
    return (labelText(el) || (el.parentElement ? el.parentElement.innerText : '') || el.value || '').toLowerCase();
  }

  /**
   * Fill empty, visible fields in `root`. opts.onlyCard: card fields only.
   * Returns { filled: [...kinds], kinds: {kind: true}, cardFieldsSeen, missingCard }.
   */
  function fillFields(root, values, opts) {
    opts = opts || {};
    var out = { filled: [], kinds: {}, cardFieldsSeen: 0, missingCard: false };
    var fields = toArray(root.querySelectorAll('input, select, textarea')).filter(function (el) {
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'file', 'password', 'search'].indexOf(type) !== -1) return false;
      if (el.disabled || el.readOnly || inPanel(el)) return false;
      if (type === 'checkbox' || type === 'radio') {
        var l = el.closest('label') || el.parentElement;
        return isVisible(el) || (l && isVisible(l));
      }
      return isVisible(el);
    });

    fields.forEach(function (el) {
      var kind = classifyField(el);
      if (!kind) return;
      out.kinds[kind] = true;
      var isCard = CARD_KINDS.indexOf(kind) !== -1;
      if (isCard) out.cardFieldsSeen += 1;
      if (opts.onlyCard && !isCard) return;
      if (kind === 'addressLookup') return;
      if (el.tagName === 'SELECT') {
        if (!placeholderSelected(el)) return;
        var v = chooseOption(kind, el, values);
        if (v !== null && v !== undefined) { setNative(el, v); out.filled.push(kind); }
        return;
      }
      if (el.value) return; // never overwrite what's there (e.g. details from your account)
      var val = values[kind];
      if (isCard && !val) { out.missingCard = true; return; }
      if (!val) return;
      typeInto(el, val, kind);
      out.filled.push(kind);
    });

    if (!opts.onlyCard) {
      // Radio groups: home delivery; card payment.
      var groups = {};
      fields.forEach(function (el) {
        if ((el.getAttribute('type') || '').toLowerCase() !== 'radio') return;
        var g = el.name || el.id;
        (groups[g] = groups[g] || []).push(el);
      });
      Object.keys(groups).forEach(function (g) {
        var list = groups[g];
        if (list.some(function (r) { return r.checked; })) return;
        var labels = list.map(radioLabel);
        var isPayment = labels.some(function (l) { return /paypal|afterpay|zip|klarna|apple pay|google pay|credit|debit/.test(l); });
        var isDelivery = labels.some(function (l) { return /deliver|shipping|post|courier|express|standard|collect|pick ?up/.test(l); });
        var pick = null;
        if (isPayment) pick = list.find(function (r) { return /credit|debit|card/.test(radioLabel(r)); });
        else if (isDelivery) pick = list.find(function (r) { var l = radioLabel(r); return /home delivery|standard|deliver|shipping|post/.test(l) && !/collect|pick ?up|in-?store|click/.test(l); });
        if (pick) { pick.click(); out.filled.push(isPayment ? 'payment method' : 'delivery method'); }
      });
      // "I agree to the terms" only — never marketing.
      fields.forEach(function (el) {
        if ((el.getAttribute('type') || '').toLowerCase() !== 'checkbox' || el.checked) return;
        var l = (labelText(el) + ' ' + describe(el)).toLowerCase();
        if (/agree|terms|conditions|t\s?&\s?c/.test(l) && !/newsletter|marketing|subscribe|offers|promotion|news\b|sms|email me|updates|kmail/.test(l)) {
          el.click();
          out.filled.push('terms');
        }
      });
    }
    return out;
  }

  function buttons() {
    return toArray(document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')).filter(function (el) {
      return !inPanel(el) && isVisible(el) && textOf(el) && textOf(el).length <= 80;
    }).map(function (el) {
      return { el: el, text: textOf(el), kind: classifyButton(textOf(el)), disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' };
    });
  }

  function signature() {
    var t = document.body ? document.body.innerText.length : 0;
    return location.pathname + '|' + document.querySelectorAll('input,select,button').length + '|' + t;
  }

  async function waitForChange(before, ms) {
    var end = Date.now() + ms;
    while (Date.now() < end) {
      await wait(200);
      if (signature() !== before) { await wait(300); return true; }
    }
    return false;
  }

  function highlight(el, message) {
    try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    el.style.setProperty('outline', '4px solid #22c55e', 'important');
    el.style.setProperty('outline-offset', '3px', 'important');
    var b = document.getElementById('tcgbot-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'tcgbot-banner';
      b.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483646;background:#16a34a;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:6px 14px;border-radius:0 0 8px 8px;box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none;max-width:90vw';
      document.documentElement.appendChild(b);
    }
    b.textContent = message;
  }

  /** Try a suggestion list after typing into an address-lookup box. */
  async function useAddressLookup(values) {
    var box = toArray(document.querySelectorAll('input')).find(function (el) { return isVisible(el) && !el.value && classifyField(el) === 'addressLookup'; });
    if (!box || !values.address1) return false;
    typeInto(box, values.address1 + ', ' + values.suburb + ' ' + values.state + ' ' + values.postcode, 'addressLookup');
    await wait(1500);
    var options = toArray(document.querySelectorAll('[role="option"], [role="listbox"] li, .pac-item, [class*="suggestion" i] li, [class*="suggestion" i] [class*="item" i]')).filter(isVisible);
    var want = String(values.postcode || '');
    var pick = options.find(function (o) { return want && o.innerText.indexOf(want) !== -1; }) || options[0];
    if (!pick) return false;
    pick.click();
    await wait(800);
    return true;
  }

  /**
   * Walk through the checkout. opts: { values, setStatus, report, isActive(), hasCard, cardLocked }
   * Resolves to 'ready' | 'needs_you' | 'stopped' | 'timeout' | 'done'.
   */
  async function assist(opts) {
    var setStatus = opts.setStatus || function () {};
    var report = opts.report || function () {};
    var clicked = {};
    var lookupTried = false;
    var manualTried = false;
    var idle = 0;
    var deadline = Date.now() + 4 * 60 * 1000;
    setStatus('Filling in checkout…');
    while (Date.now() < deadline) {
      if (opts.isActive && !opts.isActive()) { setStatus('Stopped.'); return 'stopped'; }
      if (/confirmation|thank-?you|order-?(complete|received|success)/i.test(location.pathname)) { setStatus('Order placed.'); return 'done'; }

      var fill = fillFields(document, opts.values);
      if (fill.filled.length) setStatus('Filled: ' + fill.filled.join(', '));
      var list = buttons();
      var finals = list.filter(function (b) { return b.kind === 'final'; });
      var manual = list.find(function (b) { return b.kind === 'manual'; });
      var steps = list.filter(function (b) { return (b.kind === 'step' || b.kind === 'guest') && !b.disabled; });
      var fresh = steps.filter(function (b) { return !clicked[norm(b.text)]; });

      if (!fill.kinds.address1 && fill.kinds.addressLookup) {
        if (manual && !manualTried) { manualTried = true; manual.el.click(); await wait(500); continue; }
        if (!manual && !lookupTried) { lookupTried = true; setStatus('Looking up your address…'); await useAddressLookup(opts.values); continue; }
      }

      var step = fresh.find(function (b) { return b.kind === 'guest'; }) || fresh[0];
      if (step) {
        clicked[norm(step.text)] = 1;
        var before = signature();
        setStatus('Clicking "' + step.text + '"…');
        report('step', 'Clicked "' + step.text + '"');
        step.el.click();
        await waitForChange(before, 10000);
        idle = 0;
        continue;
      }

      if (finals.length) {
        await wait(400); // let the last fields settle
        fillFields(document, opts.values);
        var fin = finals.find(function (b) { return !b.disabled; }) || finals[0];
        var card = opts.cardLocked ? ' Your card is locked in TCGBot — type it in yourself.' : !opts.hasCard ? '' : fill.missingCard ? ' Check the card details.' : '';
        var msg = 'Ready — review everything and press "' + fin.text + '" yourself.' + card;
        highlight(fin.el, 'TCGBot: ' + msg);
        setStatus(msg);
        report('ready', 'Checkout filled in — waiting for you to press "' + fin.text + '"');
        return 'ready';
      }

      // A step button we already pressed is still there: maybe a field needs attention.
      var again = steps.find(function (b) { return clicked[norm(b.text)] && clicked[norm(b.text)] < 3; });
      if (again && idle > 3) {
        clicked[norm(again.text)] += 1;
        again.el.click();
        await wait(1500);
        idle = 0;
        continue;
      }
      idle += 1;
      if (idle > 40) {
        var stuck = steps[0] ? 'Stuck at "' + steps[0].text + '" — something on the page needs your input.' : "Couldn't find the next step — please continue yourself.";
        setStatus(stuck);
        report('error', stuck);
        return 'needs_you';
      }
      await wait(400);
    }
    setStatus('Took too long — please continue yourself.');
    return 'timeout';
  }

  return {
    classifyButton: classifyButton,
    classifyField: classifyField,
    fieldValues: fieldValues,
    fillFields: fillFields,
    assist: assist,
    CARD_KINDS: CARD_KINDS,
  };
})();
