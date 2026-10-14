/* TCGBot Quick Checkout — shared core, used by the TCGBot browser extension
   and by the bookmark button the dashboard generates.

   On a product page it does: Add to Bag → (the "added" popup or the bag page)
   → Checkout, then stops so you finish the purchase yourself. It only runs
   when you press the TCGBot button and never reloads pages on its own. */

var TCGBotQuick = (function () {
  'use strict';

  var PANEL_ID = 'tcgbot-quick-checkout';
  var FLOW_MAX_AGE = 60000;
  var RECOMMENDATIONS = '[class*="recommend" i], [id*="recommend" i], [class*="carousel" i], [class*="related" i], [class*="upsell" i], [class*="product-card" i], [class*="product-tile" i], [class*="also-like" i]';
  var DRAWER = '[role="dialog"], [aria-modal="true"], [class*="drawer" i], [class*="minicart" i], [class*="mini-cart" i], [class*="mini-bag" i], [class*="minibag" i], [class*="flyout" i], [class*="modal" i], [class*="side-cart" i], [class*="added-to" i], [class*="addedto" i]';
  var EXPRESS = /paypal|afterpay|zip ?pay|\bzip\b|klarna|humm|latitude|apple ?pay|google ?pay|shop ?pay|express|continue shopping/i;

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

  function controls() {
    var panel = document.getElementById(PANEL_ID);
    return Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'))
      .filter(function (el) { return !(panel && panel.contains(el)) && isVisible(el) && !isDisabled(el); });
  }

  function findAddToBag() {
    return controls().find(function (el) {
      return /\b(add to (bag|cart|basket|trolley)|pre-?order)\b/i.test(labelOf(el))
        && !el.closest(RECOMMENDATIONS) && !el.closest('header, nav');
    }) || null;
  }

  function isCheckoutLabel(label) {
    return /\b((secure |proceed to )?check ?out( now)?)\b/i.test(label) && !EXPRESS.test(label) && label.length < 60;
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

  function onCheckoutPage() {
    return /\/checkout/i.test(location.pathname);
  }

  function onBagPage() {
    return /\/(cart|bag|basket|trolley)(\/|$)/i.test(location.pathname);
  }

  /** The product in your list that this page is for (matched by SKU in the link). */
  function productForPage(products) {
    var path = decodeURIComponent(location.pathname).toLowerCase();
    return (products || []).find(function (p) {
      return p.enabled !== false && p.sku && path.indexOf(String(p.sku).toLowerCase()) !== -1;
    }) || null;
  }

  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // --------------------------------------------------------------------------
  // The flow
  // --------------------------------------------------------------------------
  /**
   * opts: {
   *   fresh: true when the button was just pressed (false = resuming after the page changed),
   *   product: the matching product (or null),
   *   store: {read(), save(flow), clear()} — where progress is kept between pages,
   *   setStatus(text), report(type, message, product),
   *   followPages: true if this code runs again on the next page (extension);
   *                false for the bookmark button, which asks you to press it again.
   * }
   * Resolves to 'checkout' | 'bag' | 'error' | 'stopped' | 'timeout'.
   */
  async function run(opts) {
    var store = opts.store;
    var setStatus = opts.setStatus || function () {};
    var report = opts.report || function () {};
    var product = opts.product || null;

    if (opts.fresh) {
      store.clear();
      if (onCheckoutPage()) { setStatus('You are already at checkout.'); return 'checkout'; }
      if (onBagPage()) {
        var bagCheckout = findCheckout(false);
        if (bagCheckout) {
          setStatus('Opening checkout — finish the purchase yourself.');
          report('checkout', 'Opening checkout from the bag', product);
          bagCheckout.click();
          return 'checkout';
        }
        setStatus("Couldn't find the Checkout button on this page.");
        return 'error';
      }
      if (!product) { setStatus('Open one of your products first (list below).'); return 'error'; }
      var add = findAddToBag();
      if (!add) {
        setStatus("Add to Bag isn't available — sold out, or the page is still loading.");
        report('error', 'Add to Bag not available', product);
        return 'error';
      }
      // Save before clicking in case the site changes page straight away.
      store.save({ stage: 'add-clicked', startedAt: Date.now(), clickedAt: Date.now(), sku: product.sku });
      setStatus('Adding to your bag…');
      add.click();
      report('add', 'Clicked Add to Bag', product);
    }

    var deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      var flow = store.read();
      if (!flow) { setStatus('Stopped.'); return 'stopped'; }
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
        if (since > 500) {
          var popupCheckout = findCheckout(true);
          if (popupCheckout) {
            store.clear();
            setStatus('Opening checkout — finish the purchase yourself.');
            report('checkout', 'Opening checkout', product);
            popupCheckout.click();
            return 'checkout';
          }
        }
        if (since > 1500) {
          var bag = findBag();
          if (bag) {
            if (opts.followPages) {
              store.save(Object.assign({}, flow, { stage: 'bag-clicked' }));
              setStatus('Opening your bag…');
              report('basket', 'Opening the bag', product);
            } else {
              store.clear();
              setStatus('Opening your bag — press the TCGBot button again there to go to checkout.');
              report('basket', 'Opening the bag', product);
            }
            bag.click();
            if (!opts.followPages) return 'bag';
          }
        }
      } else if (flow.stage === 'bag-clicked') {
        var checkout = findCheckout(true) || findCheckout(false);
        if (checkout) {
          store.clear();
          setStatus('Opening checkout — finish the purchase yourself.');
          report('checkout', 'Opening checkout', product);
          checkout.click();
          return 'checkout';
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
  // The panel (bottom-right of the page)
  // --------------------------------------------------------------------------
  function button(label, primary) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    Object.assign(b.style, {
      display: 'block', width: '100%', padding: '9px', marginTop: '7px', border: primary ? '0' : '1px solid #d4d7dd',
      borderRadius: '6px', background: primary ? '#1a2540' : '#f5f6f8', color: primary ? '#fff' : '#172033',
      cursor: 'pointer', textAlign: 'left', font: 'inherit',
    });
    return b;
  }

  /**
   * opts: { products, current, startLabel, onStart(), onStop(), note }
   * Returns { setStatus, setNote, setProducts, startButton, el }.
   */
  function makePanel(opts) {
    var old = document.getElementById(PANEL_ID);
    if (old) old.remove();
    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed', right: '18px', bottom: '18px', width: '310px', maxHeight: '85vh', overflowY: 'auto',
      padding: '14px', background: '#fff', color: '#172033', border: '1px solid #aaa', borderRadius: '12px',
      boxShadow: '0 3px 16px #0003', zIndex: '2147483647', font: '14px/1.5 sans-serif', textAlign: 'left',
    });
    var head = document.createElement('div');
    Object.assign(head.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' });
    var heading = document.createElement('strong');
    heading.textContent = '⚡ TCGBot Quick Checkout';
    var min = document.createElement('button');
    min.type = 'button';
    min.title = 'Minimise';
    Object.assign(min.style, { border: '1px solid #d4d7dd', background: '#f5f6f8', borderRadius: '6px', cursor: 'pointer', padding: '0 8px', font: 'inherit', color: '#172033' });
    head.append(heading, min);

    var body = document.createElement('div');
    var info = document.createElement('p');
    info.style.margin = '8px 0 0';
    var status = document.createElement('p');
    status.style.margin = '6px 0 0';
    status.textContent = 'Ready.';
    var start = button(opts.startLabel || 'Add to Bag → Checkout', true);
    var stop = button('Stop');
    var note = document.createElement('p');
    Object.assign(note.style, { margin: '6px 0 0', fontSize: '12px', color: '#5b6474' });
    note.textContent = opts.note || '';
    var hr = document.createElement('hr');
    hr.style.marginTop = '14px';
    var listHead = document.createElement('strong');
    listHead.textContent = 'Products · priority order';
    var list = document.createElement('div');
    body.append(info, status, start, stop, note, hr, listHead, list);
    panel.append(head, body);

    var products = opts.products || [];
    function renderProducts() {
      var cur = productForPage(products);
      info.textContent = cur ? cur.name + ' · SKU ' + cur.sku
        : onBagPage() ? 'Your bag — press the button to go to checkout.'
          : 'Open one of your products below, then press the button.';
      list.textContent = '';
      products.filter(function (p) { return p.enabled !== false; }).forEach(function (p, i) {
        var price = typeof p.price === 'number' ? ' — $' + p.price : '';
        var b = button((i + 1) + '. ' + p.name + price);
        if (cur && cur.sku === p.sku) { b.style.borderColor = '#1a2540'; b.style.fontWeight = '700'; }
        b.addEventListener('click', function () { window.open(p.url, '_blank', 'noopener'); });
        list.appendChild(b);
      });
    }

    var collapsed = false;
    try { collapsed = sessionStorage.getItem('tcgbotQuickCollapsed') === '1'; } catch (e) { /* ignore */ }
    function applyCollapsed() {
      body.style.display = collapsed ? 'none' : '';
      min.textContent = collapsed ? '+' : '–';
      panel.style.width = collapsed ? 'auto' : '310px';
    }
    min.addEventListener('click', function () {
      collapsed = !collapsed;
      try { sessionStorage.setItem('tcgbotQuickCollapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
      applyCollapsed();
    });
    start.addEventListener('click', function () { if (opts.onStart) opts.onStart(); });
    stop.addEventListener('click', function () { if (opts.onStop) opts.onStop(); });

    renderProducts();
    applyCollapsed();
    document.body.appendChild(panel);
    return {
      el: panel,
      startButton: start,
      setStatus: function (t) { status.textContent = t; },
      setNote: function (t) { note.textContent = t; },
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
    run: run,
    makePanel: makePanel,
    sessionStore: sessionStore,
    memoryStore: memoryStore,
  };
})();
