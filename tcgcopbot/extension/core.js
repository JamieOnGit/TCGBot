/* TCGCopBot Quick Checkout — shared core, used by the TCGCopBot browser extension
   (adapted from TCGBot).

   On a product page it does: set quantity → Add to Bag → (the "added" popup
   or the bag page, where it sets the quantity if the product page couldn't)
   → Checkout, then stops so you finish the purchase yourself. It only runs
   when you press a TCGCopBot button and never reloads pages on its own. */

var TCBQuick = (function () {
  'use strict';

  var PANEL_ID = 'tcgcopbot-qc';
  // Panels from other scripts (TCGBot, Tampermonkey) — ignored, and flagged if present.
  var OTHER_PANELS = ['tcgbot-qc', 'tcgbot-quick-checkout', 'kmart-upc-quick-checkout'];
  var FLOW_MAX_AGE = 90000;
  var RECOMMENDATIONS = '[class*="recommend" i], [id*="recommend" i], [class*="carousel" i], [class*="related" i], [class*="upsell" i], [class*="product-card" i], [class*="product-tile" i], [class*="also-like" i]';
  var DRAWER = '[role="dialog"], [aria-modal="true"], [class*="drawer" i], [class*="minicart" i], [class*="mini-cart" i], [class*="mini-bag" i], [class*="minibag" i], [class*="flyout" i], [class*="modal" i], [class*="side-cart" i], [class*="added-to" i], [class*="addedto" i]';
  var EXPRESS = /paypal|afterpay|zip ?pay|\bzip\b|klarna|humm|latitude|apple ?pay|google ?pay|shop ?pay|express|continue shopping/i;
  var ADD_RE = /\b(add to (bag|cart|basket|trolley)|pre-?order)\b/i;
  var QTY_BOX = 'input[type="number"], input[name*="qty" i], input[name*="quantity" i], input[id*="quantity" i], input[aria-label*="quantity" i], '
    + 'select[name*="qty" i], select[name*="quantity" i], select[id*="quantity" i], select[aria-label*="quantity" i]';

  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var toArray = function (list) { return Array.prototype.slice.call(list); };

  // --------------------------------------------------------------------------
  // Finding things on the page
  // --------------------------------------------------------------------------
  function isVisible(el) {
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }

  function isDisabled(el) {
    return el.disabled || el.getAttribute('aria-disabled') === 'true';
  }

  function labelOf(el) {
    return [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title'), el.value]
      .filter(Boolean).join(' ').trim().replace(/\s+/g, ' ');
  }

  function inAnyPanel(el) {
    var ids = [PANEL_ID].concat(OTHER_PANELS);
    for (var i = 0; i < ids.length; i++) {
      var p = document.getElementById(ids[i]);
      if (p && p.contains(el)) return true;
    }
    return false;
  }

  function controls() {
    return toArray(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'))
      .filter(function (el) { return !inAnyPanel(el) && isVisible(el) && !isDisabled(el); });
  }

  function otherPanelPresent() {
    return OTHER_PANELS.some(function (id) { return !!document.getElementById(id); });
  }

  /** Does this element sit in a tile that links to a different product? (e.g. "You may also like") */
  function inOtherProductTile(el) {
    var root = el;
    for (var i = 0; i < 4 && root.parentElement && root.parentElement !== document.body; i++) root = root.parentElement;
    var here = location.pathname.replace(/\/+$/, '');
    return toArray(root.querySelectorAll('a[href]')).some(function (a) {
      try {
        var u = new URL(a.getAttribute('href'), location.href);
        var path = u.pathname.replace(/\/+$/, '');
        return u.host === location.host && path !== here && /\/(product|products|p)\//i.test(path);
      } catch (e) { return false; }
    });
  }

  function findAddToBag() {
    var all = controls().filter(function (el) { return ADD_RE.test(labelOf(el)) && !el.closest('header, nav'); });
    // Prefer the main buy box; fall back to any Add to Bag that isn't on another product's tile.
    return all.find(function (el) { return !el.closest(RECOMMENDATIONS); })
      || all.find(function (el) { return !inOtherProductTile(el); })
      || null;
  }

  // The final "buy" buttons are never pressed by TCGCopBot.
  var FINAL = /check ?out securely|place (my |your )?order|pay now|pay securely|complete (my |your )?(order|purchase|payment)|submit (my )?(order|payment)|confirm (and|&) pay|pay \$/i;

  function isCheckoutLabel(label) {
    return (/\b((secure |proceed to )?check ?out( now)?)\b/i.test(label) || /^continue to (details|checkout)$/i.test(label.trim()))
      && !EXPRESS.test(label) && !FINAL.test(label) && label.length < 60;
  }

  /** inPopupOnly: only accept a Checkout button inside the "added to bag" popup / mini-bag. */
  function findCheckout(inPopupOnly) {
    var list = controls().filter(function (el) { return isCheckoutLabel(labelOf(el)); });
    if (inPopupOnly) return list.find(function (el) { return el.closest(DRAWER); }) || null;
    return list.find(function (el) { return !el.closest('header, nav'); }) || list[0] || null;
  }

  function findBag() {
    var list = controls().filter(function (el) {
      var label = labelOf(el).toLowerCase();
      if (/add to (bag|cart)|check ?out/.test(label) || label.length > 60) return false;
      return /\b(view|open|my|shopping|go to)?\s*(bag|basket|cart|trolley)\b/.test(label);
    });
    return list.find(function (el) { return el.closest(DRAWER); }) || list[0] || null;
  }

  function onBagPage() {
    return /\/(cart|bag|basket|trolley)(\/|$)/i.test(location.pathname);
  }

  function onCheckoutPage() {
    return /\/checkout/i.test(location.pathname) && !onBagPage();
  }

  /** The product in your list that this page is for (matched by SKU in the link). */
  function productForPage(products) {
    var path = decodeURIComponent(location.pathname).toLowerCase();
    return (products || []).find(function (p) {
      return p.enabled !== false && p.sku && path.indexOf(String(p.sku).toLowerCase()) !== -1;
    }) || null;
  }

  async function waitForEl(find, ms) {
    var end = Date.now() + (ms || 0);
    for (;;) {
      var el = find();
      if (el || Date.now() >= end) return el;
      await wait(200);
    }
  }

  // --------------------------------------------------------------------------
  // Quantity — on the product page, or else on the bag page
  // --------------------------------------------------------------------------
  function usable(el) {
    return isVisible(el) && !isDisabled(el) && !inAnyPanel(el) && !el.closest('header, nav');
  }

  /** The product's buy box: a few levels up from the Add to Bag button. */
  function buyBox(add) {
    var root = add;
    for (var i = 0; i < 5 && root.parentElement && root.parentElement !== document.body; i++) root = root.parentElement;
    return root;
  }

  function isIncrease(el) {
    var label = labelOf(el);
    return label.length <= 40 && /\b(increase|increment)\b|add one|^\+$|^plus$/i.test(label) && !/add to/i.test(label);
  }

  /** A quantity box/dropdown or a + button inside `root`. */
  function quantityControlIn(root, excludeRecs) {
    var ok = function (el) { return usable(el) && !(excludeRecs && el.closest(RECOMMENDATIONS)); };
    var box = toArray(root.querySelectorAll(QTY_BOX)).find(ok);
    if (box) return { box: box };
    var plus = toArray(root.querySelectorAll('button, [role="button"]')).find(function (el) { return ok(el) && isIncrease(el); });
    return plus ? { plus: plus } : null;
  }

  /** Set a form field the way typing would, so the site's own code notices. */
  function setFieldValue(el, value) {
    var proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /** The number shown next to a + button (stepper). */
  function stepperValue(plus) {
    var root = plus.parentElement;
    for (var i = 0; i < 2 && root; i++, root = root.parentElement) {
      var input = root.querySelector('input');
      if (input && /^\d+$/.test(input.value)) return parseInt(input.value, 10);
      var texts = toArray(root.querySelectorAll('span, output, div, p')).map(function (e) { return (e.textContent || '').trim(); })
        .filter(function (t) { return /^\d{1,2}$/.test(t); });
      if (texts.length) return parseInt(texts[0], 10);
    }
    return null;
  }

  /**
   * Set quantity using a control. Resolves to {ok, got, max, capped}.
   * `capped` = the store won't allow that many (it offers fewer).
   */
  async function applyQuantity(ctl, qty) {
    if (ctl.box) {
      var box = ctl.box;
      var max = null;
      if (box.tagName === 'SELECT') {
        var nums = toArray(box.options).map(function (o) { return parseInt(o.value, 10) || parseInt(o.textContent, 10); }).filter(function (n) { return n > 0; });
        max = nums.length ? Math.max.apply(null, nums) : null;
        var target = max ? Math.min(qty, max) : qty;
        var opt = toArray(box.options).find(function (o) { return parseInt(o.value, 10) === target || parseInt(o.textContent, 10) === target; });
        if (!opt) return { ok: false, got: parseInt(box.value, 10) || 1, max: max, capped: false };
        setFieldValue(box, opt.value);
      } else {
        var m = parseInt(box.getAttribute('max'), 10);
        max = m > 0 ? m : null;
        setFieldValue(box, String(max ? Math.min(qty, max) : qty));
      }
      await wait(250);
      var got = parseInt(box.value, 10) || (box.tagName === 'SELECT' ? parseInt(box.options[box.selectedIndex].textContent, 10) : 1);
      return { ok: got === qty, got: got, max: max, capped: got < qty && max !== null && got === max };
    }
    if (ctl.plus) {
      var current = stepperValue(ctl.plus) || 1;
      for (var i = 0; i < 12 && current < qty; i++) {
        ctl.plus.click();
        await wait(250);
        var next = stepperValue(ctl.plus);
        if (next === null) { current += 1; continue; } // can't read it — trust the click
        if (next <= current || isDisabled(ctl.plus)) { current = next; break; } // reached the store's limit
        current = next;
      }
      return { ok: current === qty, got: current, max: current < qty ? current : null, capped: current < qty };
    }
    return { ok: false, got: 1, max: null, capped: false };
  }

  /** Quantity on the product page. method 'none' = the page has no quantity control. */
  async function setQuantity(add, qty) {
    if (!qty || qty <= 1) return { ok: true, method: 'default', got: 1 };
    var ctl = quantityControlIn(buyBox(add), true) || quantityControlIn(document, true);
    if (!ctl) return { ok: false, method: 'none', got: 1 };
    var r = await applyQuantity(ctl, qty);
    r.method = ctl.box ? 'box' : 'plus';
    return r;
  }

  /** The bag row for a product: up from a link to its page until a quantity control appears. */
  function bagRowFor(product) {
    var sku = String(product.sku || '').toLowerCase();
    var links = toArray(document.querySelectorAll('a[href]')).filter(function (a) {
      var href = '';
      try { href = decodeURIComponent(a.getAttribute('href')).toLowerCase(); } catch (e) { href = String(a.getAttribute('href')).toLowerCase(); }
      return sku && href.indexOf(sku) !== -1 && !a.closest('header, nav') && !inAnyPanel(a);
    });
    for (var i = 0; i < links.length; i++) {
      var row = links[i];
      for (var j = 0; j < 8 && row.parentElement; j++) {
        row = row.parentElement;
        if (quantityControlIn(row, false)) return row;
      }
    }
    return null;
  }

  /** Quantity on the bag page. */
  async function setBagQuantity(product, qty) {
    var row = bagRowFor(product);
    if (!row) {
      // A bag with a single line: use the only quantity control on the page.
      var all = toArray(document.querySelectorAll(QTY_BOX)).filter(usable);
      if (all.length === 1) row = all[0].parentElement || document.body;
    }
    var ctl = row ? quantityControlIn(row, false) : null;
    if (!ctl) return { ok: false, method: 'none', got: null };
    var r = await applyQuantity(ctl, qty);
    r.method = 'bag';
    await wait(1200); // let the bag save the change
    return r;
  }

  function qtyMessage(r, qty) {
    if (r.ok) return '';
    if (r.capped) return 'the store only allows ' + r.got + ' — added ' + r.got;
    return "couldn't set quantity " + qty + ' — check your bag';
  }

  // --------------------------------------------------------------------------
  // The flow
  // --------------------------------------------------------------------------
  /**
   * opts: {
   *   fresh: true when a button was just pressed (false = resuming after the page changed),
   *   product: the matching product (or null) — {sku, name, quantity},
   *   products: your whole list (used on the bag page),
   *   store: {read(), save(flow), clear()} — where progress is kept between pages,
   *   setStatus(text), report(type, message, product),
   *   followPages: true if this code runs again on the next page (extension);
   *                false for the bookmark button, which asks you to press it again.
   *   quantity: how many (default: the product's quantity, else 1),
   *   waitForButtonMs: how long to wait for Add to Bag to appear (slow-loading pages).
   * }
   * Resolves to 'checkout' | 'bag' | 'error' | 'stopped' | 'timeout'.
   */
  async function run(opts) {
    var store = opts.store;
    var setStatus = opts.setStatus || function () {};
    var report = opts.report || function () {};
    var product = opts.product || null;

    async function checkoutFromBag(flow) {
      // Set quantities still owed (product page had no quantity control).
      var owed = [];
      if (flow && flow.needBagQty && product) owed.push({ product: product, qty: flow.qty });
      if (!flow) {
        (opts.products || []).forEach(function (p) {
          if ((p.quantity || 1) > 1 && bagRowFor(p)) owed.push({ product: p, qty: p.quantity });
        });
      }
      for (var i = 0; i < owed.length; i++) {
        setStatus('Setting quantity ' + owed[i].qty + ' in your bag…');
        var r = await setBagQuantity(owed[i].product, owed[i].qty);
        var msg = qtyMessage(r, owed[i].qty);
        report(r.ok ? 'basket' : 'error', r.ok ? 'Set quantity ' + owed[i].qty + ' in the bag' : 'Bag: ' + msg, owed[i].product);
        if (msg) setStatus(msg.charAt(0).toUpperCase() + msg.slice(1) + '.');
      }
      var checkout = await waitForEl(function () { return findCheckout(true) || findCheckout(false); }, 3000);
      if (!checkout) { setStatus("Couldn't find the Checkout button on this page."); return 'error'; }
      store.clear();
      setStatus('Opening checkout — finish the purchase yourself.');
      report('checkout', 'Opening checkout', product);
      checkout.click();
      return 'checkout';
    }

    if (opts.fresh) {
      store.clear();
      if (onBagPage()) return checkoutFromBag(null);
      if (onCheckoutPage()) { setStatus('You are already at checkout.'); return 'checkout'; }
      if (!product) { setStatus('Open one of your products first (list below).'); return 'error'; }
      var qty = Math.max(1, Math.min(10, parseInt(opts.quantity || product.quantity || 1, 10) || 1));
      setStatus('Looking for Add to Bag…');
      var add = await waitForEl(findAddToBag, opts.waitForButtonMs == null ? 1500 : opts.waitForButtonMs);
      if (!add) {
        setStatus("Add to Bag isn't available — sold out, or the page is still loading.");
        report('error', 'Add to Bag not available', product);
        return 'error';
      }
      var needBagQty = false;
      var note = '';
      if (qty > 1) {
        setStatus('Setting quantity to ' + qty + '…');
        var q = await setQuantity(add, qty);
        if (q.method === 'none' || (!q.ok && !q.capped)) needBagQty = true; // try again in the bag
        else if (q.capped) {
          note = ' — the store only allows ' + q.got;
          report('error', 'The store only allows ' + q.got + ' per order (you asked for ' + qty + ')', product);
        }
        add = findAddToBag() || add; // the site may have re-drawn the button
      }
      // Save before clicking in case the site changes page straight away.
      store.save({ stage: 'add-clicked', startedAt: Date.now(), clickedAt: Date.now(), sku: product.sku, name: product.name, qty: qty, needBagQty: needBagQty });
      setStatus('Adding to your bag' + (needBagQty ? ' (quantity set in the bag next)' : '') + '…' + note);
      add.click();
      report('add', 'Clicked Add to Bag' + (qty > 1 ? ' (quantity ' + qty + (needBagQty ? ', setting it in the bag' : '') + ')' : ''), product);
    }

    var deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      var flow = store.read();
      if (!flow) { setStatus('Stopped.'); return 'stopped'; }
      if (!product) product = (opts.products || []).find(function (p) { return p.sku === flow.sku; }) || { sku: flow.sku, name: flow.name, quantity: flow.qty };
      if (Date.now() - flow.startedAt > FLOW_MAX_AGE) {
        store.clear();
        setStatus('Timed out. Check your bag and continue yourself.');
        report('error', 'Timed out before reaching checkout', product);
        return 'timeout';
      }
      if (onCheckoutPage()) {
        store.clear();
        setStatus('At checkout — finish the purchase yourself.');
        report('checkout', 'Reached checkout', product);
        return 'checkout';
      }
      if (flow.stage === 'add-clicked') {
        var since = Date.now() - (flow.clickedAt || flow.startedAt);
        // Give the bag a moment to update before trusting any Checkout button.
        if (since > 500 && !flow.needBagQty) {
          var popupCheckout = findCheckout(true);
          if (popupCheckout) {
            store.clear();
            setStatus('Opening checkout — finish the purchase yourself.');
            report('checkout', 'Opening checkout', product);
            popupCheckout.click();
            return 'checkout';
          }
        }
        if (since > (flow.needBagQty ? 700 : 1500)) {
          var bag = findBag();
          if (bag) {
            if (opts.followPages) {
              store.save(Object.assign({}, flow, { stage: 'bag-clicked', bagAt: Date.now() }));
              setStatus(flow.needBagQty ? 'Opening your bag to set the quantity…' : 'Opening your bag…');
              report('basket', 'Opening the bag', product);
            } else {
              store.clear();
              setStatus('Opening your bag — press the TCGCopBot button again there' + (flow.needBagQty ? ' to set the quantity and' : ' to') + ' go to checkout.');
              report('basket', 'Opening the bag', product);
            }
            bag.click();
            if (!opts.followPages) return 'bag';
          }
        }
      } else if (flow.stage === 'bag-clicked') {
        if (flow.needBagQty) {
          // Wait for the bag (page or popup) to show this product's row.
          if (onBagPage() || bagRowFor(product)) {
            await waitForEl(function () { return bagRowFor(product); }, 4000);
            return checkoutFromBag(flow);
          }
        } else {
          var checkout = findCheckout(true) || findCheckout(false);
          if (checkout) {
            store.clear();
            setStatus('Opening checkout — finish the purchase yourself.');
            report('checkout', 'Opening checkout', product);
            checkout.click();
            return 'checkout';
          }
        }
      }
      await wait(250);
    }
    store.clear();
    setStatus("Checkout button wasn't found in time. Open your bag and continue yourself.");
    report('error', 'Checkout button not found in time', product);
    return 'timeout';
  }

  // --------------------------------------------------------------------------
  // The panel — small, top-left, draggable
  // --------------------------------------------------------------------------
  var POS_KEY = 'tcbPanelPos';
  var COLLAPSED_KEY = 'tcbPanelCollapsed';

  function smallButton(label, primary) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    Object.assign(b.style, {
      padding: primary ? '6px 8px' : '4px 7px', border: primary ? '0' : '1px solid #d4d7dd', borderRadius: '6px',
      background: primary ? '#1a2540' : '#f5f6f8', color: primary ? '#fff' : '#172033', cursor: 'pointer',
      font: 'inherit', fontWeight: primary ? '700' : '500', lineHeight: '1.2', margin: '0',
    });
    return b;
  }

  function readPos() {
    try {
      var p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (p && typeof p.left === 'number' && typeof p.top === 'number') return p;
    } catch (e) { /* ignore */ }
    return { left: 12, top: 12 };
  }

  /**
   * opts: { products, startLabel, onStart(), onStop(), note }
   * Returns { setStatus, setNote, setProducts, startButton, el }.
   */
  function makePanel(opts) {
    var old = document.getElementById(PANEL_ID);
    if (old) old.remove();
    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    var pos = readPos();
    Object.assign(panel.style, {
      position: 'fixed', left: pos.left + 'px', top: pos.top + 'px', width: '228px', maxHeight: '70vh', overflowY: 'auto',
      padding: '8px 10px', background: '#fff', color: '#172033', border: '1px solid #c9ccd3', borderRadius: '10px',
      boxShadow: '0 2px 12px rgba(0,0,0,.18)', zIndex: '2147483647', font: '12.5px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif',
      textAlign: 'left', boxSizing: 'border-box',
    });

    var head = document.createElement('div');
    Object.assign(head.style, { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'move', userSelect: 'none' });
    var title = document.createElement('strong');
    title.textContent = '⚡ TCGCopBot';
    title.style.flex = '1';
    var min = smallButton('–');
    min.title = 'Minimise';
    head.append(title, min);

    var body = document.createElement('div');
    var info = document.createElement('div');
    Object.assign(info.style, { marginTop: '5px', fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
    var status = document.createElement('div');
    Object.assign(status.style, { marginTop: '3px', color: '#3d4655' });
    status.textContent = 'Ready.';
    var row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '6px', marginTop: '6px' });
    var start = smallButton(opts.startLabel || 'Add to Bag → Checkout', true);
    start.style.flex = '1';
    start.style.whiteSpace = 'nowrap';
    var stop = smallButton('✕');
    stop.title = 'Stop';
    stop.setAttribute('aria-label', 'Stop');
    row.append(start, stop);
    var note = document.createElement('div');
    Object.assign(note.style, { marginTop: '5px', fontSize: '11px', color: '#6b7380' });
    var warn = document.createElement('div');
    Object.assign(warn.style, { marginTop: '5px', fontSize: '11px', color: '#b45309' });
    var toggle = document.createElement('a');
    toggle.href = '#';
    Object.assign(toggle.style, { display: 'inline-block', marginTop: '5px', fontSize: '11px', color: '#2a5bd7', textDecoration: 'none' });
    var list = document.createElement('div');
    list.style.display = 'none';
    body.append(info, status, row, note, warn, toggle, list);
    panel.append(head, body);

    var products = opts.products || [];
    function renderProducts() {
      var cur = productForPage(products);
      var q = cur && (cur.quantity || 1) > 1 ? ' · Qty ' + cur.quantity : '';
      info.textContent = cur ? cur.name + ' · SKU ' + cur.sku + q
        : onBagPage() ? 'Your bag' : onCheckoutPage() ? 'Checkout' : 'Open one of your products';
      info.title = info.textContent;
      var shown = products.filter(function (p) { return p.enabled !== false; });
      toggle.textContent = (list.style.display === 'none' ? '▸ ' : '▾ ') + 'Products (' + shown.length + ')';
      toggle.style.display = shown.length ? '' : 'none';
      list.textContent = '';
      shown.forEach(function (p, i) {
        var price = typeof p.price === 'number' ? ' — $' + p.price : '';
        var qq = (p.quantity || 1) > 1 ? ' ×' + p.quantity : '';
        var b = smallButton((i + 1) + '. ' + p.name + price + qq);
        Object.assign(b.style, { display: 'block', width: '100%', marginTop: '4px', textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
        if (cur && cur.sku === p.sku) b.style.borderColor = '#1a2540';
        b.addEventListener('click', function () { window.open(p.url, '_blank', 'noopener'); });
        list.appendChild(b);
      });
    }
    toggle.addEventListener('click', function (e) {
      e.preventDefault();
      list.style.display = list.style.display === 'none' ? '' : 'none';
      renderProducts();
    });

    function setNote(t) {
      note.textContent = t || '';
      note.style.display = t ? '' : 'none';
    }
    setNote(opts.note || '');
    function checkOthers() {
      var other = otherPanelPresent();
      warn.textContent = other ? 'Another quick-checkout tool (TCGBot or Tampermonkey?) is also on this page — turn it off so items aren\'t added twice.' : '';
      warn.style.display = other ? '' : 'none';
    }
    checkOthers();
    setTimeout(checkOthers, 2500); // other scripts may add their panel a little later

    var collapsed = false;
    try { collapsed = localStorage.getItem(COLLAPSED_KEY) === '1'; } catch (e) { /* ignore */ }
    function applyCollapsed() {
      body.style.display = collapsed ? 'none' : '';
      min.textContent = collapsed ? '+' : '–';
      panel.style.width = collapsed ? 'auto' : '228px';
    }
    min.addEventListener('click', function () {
      collapsed = !collapsed;
      try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
      applyCollapsed();
    });

    // Drag by the title bar; remembered per site.
    head.addEventListener('mousedown', function (e) {
      if (e.target === min) return;
      e.preventDefault();
      var startX = e.clientX;
      var startY = e.clientY;
      var r = panel.getBoundingClientRect();
      function move(ev) {
        var left = Math.max(0, Math.min(window.innerWidth - 60, r.left + ev.clientX - startX));
        var top = Math.max(0, Math.min(window.innerHeight - 30, r.top + ev.clientY - startY));
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
      }
      function up() {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        try { localStorage.setItem(POS_KEY, JSON.stringify({ left: parseInt(panel.style.left, 10), top: parseInt(panel.style.top, 10) })); } catch (e2) { /* ignore */ }
      }
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    });

    // Only real clicks count — a web page can't press these buttons for you.
    start.addEventListener('click', function (e) { if (e.isTrusted && opts.onStart) opts.onStart(); });
    stop.addEventListener('click', function (e) { if (e.isTrusted && opts.onStop) opts.onStop(); });

    renderProducts();
    applyCollapsed();
    document.body.appendChild(panel);
    return {
      el: panel,
      startButton: start,
      setStatus: function (t) { status.textContent = t; },
      setNote: setNote,
      setProducts: function (p) { products = p || []; renderProducts(); },
    };
  }

  /** Progress kept in the tab's sessionStorage, so it survives page changes. */
  function sessionStore(key) {
    return {
      read: function () { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (e) { return null; } },
      save: function (flow) { try { sessionStorage.setItem(key, JSON.stringify(flow)); } catch (e) { /* ignore */ } },
      clear: function () { try { sessionStorage.removeItem(key); } catch (e) { /* ignore */ } },
    };
  }

  /** Progress kept in memory only (the bookmark button). */
  function memoryStore() {
    var flow = null;
    return {
      read: function () { return flow; },
      save: function (f) { flow = f; },
      clear: function () { flow = null; },
    };
  }

  return {
    PANEL_ID: PANEL_ID,
    findAddToBag: findAddToBag,
    findCheckout: findCheckout,
    findBag: findBag,
    onCheckoutPage: onCheckoutPage,
    onBagPage: onBagPage,
    productForPage: productForPage,
    setQuantity: setQuantity,
    setBagQuantity: setBagQuantity,
    run: run,
    makePanel: makePanel,
    sessionStore: sessionStore,
    memoryStore: memoryStore,
  };
})();
