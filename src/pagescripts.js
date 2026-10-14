// Functions that run INSIDE the retailer's web page (and its iframes) via
// Playwright's evaluate(). They are serialized, so each one must be fully
// self-contained: no imports and no references to outer variables.

/** List visible form fields and tag each with data-tcgbot-f so Node can fill it. */
export function pageScanFields() {
  for (const e of document.querySelectorAll('[data-tcgbot-f]')) e.removeAttribute('data-tcgbot-f');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const labelText = (el) => {
    const parts = [];
    if (el.id) {
      try {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) parts.push(l.innerText);
      } catch { /* ignore */ }
    }
    const wrap = el.closest('label');
    if (wrap) parts.push(wrap.innerText);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) for (const id of lb.split(/\s+/)) { const x = document.getElementById(id); if (x) parts.push(x.innerText); }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const tag = el.tagName.toLowerCase();
    const type = (tag === 'input' ? (el.getAttribute('type') || 'text') : tag).toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'file', 'password', 'search', 'range', 'color'].includes(type)) continue;
    if (el.disabled || el.readOnly) continue;
    const isChoice = type === 'checkbox' || type === 'radio';
    let shown = visible(el);
    if (!shown && isChoice) {
      // Custom-styled checkboxes hide the real input; the label is what's visible.
      const l = el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.parentElement;
      shown = !!l && visible(l);
    }
    if (!shown) continue;
    const key = `f${n++}`;
    el.setAttribute('data-tcgbot-f', key);
    const label = labelText(el);
    const desc = [el.getAttribute('autocomplete'), el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'),
      el.getAttribute('data-fieldtype'), el.getAttribute('data-testid'), el.getAttribute('data-qa'), label]
      .filter(Boolean).join(' | ').toLowerCase().slice(0, 300);
    const rec = {
      key, tag, type, desc,
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      name: el.getAttribute('name') || '',
      required: !!el.required || el.getAttribute('aria-required') === 'true',
      value: isChoice ? '' : (el.value || ''),
      checked: !!el.checked,
      maxLength: el.maxLength > 0 ? el.maxLength : null,
      placeholder: el.getAttribute('placeholder') || '',
    };
    if (tag === 'select') {
      rec.options = [...el.options].slice(0, 300).map((o) => ({ value: o.value, text: (o.textContent || '').trim() }));
      rec.selectedText = el.selectedIndex >= 0 && el.options[el.selectedIndex] ? el.options[el.selectedIndex].textContent.trim() : '';
    }
    if (isChoice) {
      let lt = label;
      if (!lt && el.parentElement) lt = (el.parentElement.innerText || '').replace(/\s+/g, ' ').trim();
      rec.label = lt.slice(0, 160) || el.value || '';
    }
    out.push(rec);
  }
  return out;
}

/** List visible clickable things with their text and tag each with data-tcgbot-b. */
export function pageScanButtons() {
  for (const e of document.querySelectorAll('[data-tcgbot-b]')) e.removeAttribute('data-tcgbot-b');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const chromeSel = 'header, nav, [class*="recommend" i], [id*="recommend" i], [class*="carousel" i], [class*="related" i], [class*="upsell" i], [class*="cross-sell" i], [class*="product-card" i], [class*="product-tile" i], [class*="also-like" i], [class*="recently-viewed" i]';
  const out = [];
  let n = 0;
  const els = document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"], [role="link"], [role="radio"]');
  for (const el of els) {
    if (!visible(el)) continue;
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 80) continue;
    const key = `b${n++}`;
    el.setAttribute('data-tcgbot-b', key);
    const cls = typeof el.className === 'string' ? el.className : '';
    out.push({
      key,
      text,
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') || '').toLowerCase(),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' || /(^|\s)(disabled|is-disabled)(\s|$)/.test(cls),
      chrome: !!el.closest(chromeSel),
      footer: !!el.closest('footer'),
      href: el.getAttribute('href') || '',
    });
  }
  return out;
}

/** What kind of page are we on? Detect CAPTCHAs/queues and login walls. */
export function pageState() {
  const visibleArea = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return 0;
    return Math.max(0, r.width) * Math.max(0, r.height);
  };
  const text = document.body ? document.body.innerText || '' : '';
  let challenge = null;
  const captchaRe = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|captcha-delivery|perimeterx|px-cloud|geetest|kasada/i;
  for (const f of document.querySelectorAll('iframe')) {
    if (captchaRe.test(f.src || '') && visibleArea(f) > 20000) { challenge = 'captcha'; break; }
  }
  if (!challenge && /queue-it|queue\.|waitingroom|waiting-room/i.test(location.host + location.pathname)) challenge = 'queue';
  if (!challenge && text.length < 4000 && /you are now in (the )?(queue|line)|virtual (queue|waiting room)|verify (that )?(you are|you're) (a )?human|are you a robot|press (&|and) hold|checking your browser|access denied|unusual traffic/i.test(text)) {
    challenge = /queue|line|waiting room/i.test(text) ? 'queue' : 'captcha';
  }
  let hasPassword = false;
  for (const p of document.querySelectorAll('input[type="password"]')) if (visibleArea(p) > 0) { hasPassword = true; break; }
  return {
    url: location.href,
    title: document.title,
    text: text.slice(0, 6000),
    challenge,
    hasPassword,
    sig: `${location.href}|${document.querySelectorAll('input,select,button,a').length}|${text.length}`,
  };
}

export function pageSignature() {
  const text = document.body ? document.body.innerText || '' : '';
  return `${location.href}|${document.querySelectorAll('input,select,button,a').length}|${text.length}`;
}

/** Highlight the final "Place order" button and show a banner. Never clicks it. */
export function pageHighlightFinal(key) {
  const el = document.querySelector(`[data-tcgbot-b="${key}"]`);
  if (el) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.style.setProperty('outline', '4px solid #22c55e', 'important');
    el.style.setProperty('outline-offset', '4px', 'important');
    el.style.setProperty('box-shadow', '0 0 0 10px rgba(34,197,94,.35)', 'important');
  }
  if (!document.getElementById('tcgbot-banner')) {
    const b = document.createElement('div');
    b.id = 'tcgbot-banner';
    b.textContent = 'TCGBot: details filled in. Review your order, then click the highlighted button to buy.';
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#16a34a;color:#fff;font:600 16px/1.4 system-ui,sans-serif;padding:12px 16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3);pointer-events:none';
    document.documentElement.appendChild(b);
  }
  return !!el;
}

export function pageBanner(message) {
  let b = document.getElementById('tcgbot-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'tcgbot-banner';
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#d97706;color:#fff;font:600 16px/1.4 system-ui,sans-serif;padding:12px 16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3);pointer-events:none';
    document.documentElement.appendChild(b);
  }
  b.textContent = message;
  return true;
}
