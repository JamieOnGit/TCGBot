// TCGBot Quick Checkout — Tampermonkey userscript body.
// The dashboard (src/userscript.js) prepends the ==UserScript== header and
// fills in the CONFIG placeholder with your product list and dashboard address.
//
// It only acts when you click its button: Add to Bag → open the bag → Checkout.
// It never refreshes pages on its own and stops at the checkout page, where you
// finish the purchase yourself.

(() => {
  'use strict';

  const CONFIG = /*@@TCGBOT_CONFIG@@*/ { dashboard: '', products: [] };

  if (window.top !== window.self) return;
  if (document.getElementById('tcgbot-quick-checkout')) return;

  const FLOW_KEY = 'tcgbotQuickCheckoutFlow';
  const FLOW_MAX_AGE = 60000;
  const PANEL_ID = 'tcgbot-quick-checkout';
  const RECOMMENDATIONS = '[class*="recommend" i], [id*="recommend" i], [class*="carousel" i], [class*="related" i], [class*="upsell" i], [class*="product-card" i], [class*="product-tile" i], [class*="also-like" i]';
  const DRAWER = '[role="dialog"], [aria-modal="true"], [class*="drawer" i], [class*="minicart" i], [class*="mini-cart" i], [class*="mini-bag" i], [class*="minibag" i], [class*="flyout" i], [class*="modal" i], [class*="side-cart" i], [class*="added-to" i], [class*="addedto" i]';
  const EXPRESS = /paypal|afterpay|zip ?pay|\bzip\b|klarna|humm|latitude|apple ?pay|google ?pay|shop ?pay|express|continue shopping/i;

  let products = (CONFIG.products || []).filter((p) => p.enabled !== false);
  let busy = false;

  // ---------------------------------------------------------------------------
  // Talking to the TCGBot dashboard (optional — works offline with the saved list)
  // ---------------------------------------------------------------------------
  function dashboard(method, path, body) {
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== 'function' || !CONFIG.dashboard) { resolve(null); return; }
      try {
        GM_xmlhttpRequest({
          method,
          url: CONFIG.dashboard + path,
          headers: { 'content-type': 'application/json', 'x-tcgbot': '1' },
          data: body ? JSON.stringify(body) : undefined,
          timeout: 4000,
          onload: (r) => {
            try { resolve(r.status === 200 ? JSON.parse(r.responseText) : null); } catch { resolve(null); }
          },
          onerror: () => resolve(null),
          ontimeout: () => resolve(null),
        });
      } catch {
        resolve(null);
      }
    });
  }

  function report(type, message, product) {
    dashboard('POST', '/api/quick/events', {
      type, message, sku: product ? product.sku : null, name: product ? product.name : null, url: location.href,
    });
  }

  // ---------------------------------------------------------------------------
  // Page helpers
  // ---------------------------------------------------------------------------
  const panel = document.createElement('div');
  panel.id = PANEL_ID;

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
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
    return [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')]
      .filter((el) => !panel.contains(el) && isVisible(el) && !isDisabled(el));
  }

  function currentProduct() {
    const path = decodeURIComponent(location.pathname).toLowerCase();
    return products.find((p) => p.sku && path.includes(String(p.sku).toLowerCase())) || null;
  }

  function findAddToBag() {
    return controls().find((el) => /\b(add to (bag|cart|basket|trolley)|pre-?order)\b/i.test(labelOf(el))
      && !el.closest(RECOMMENDATIONS) && !el.closest('header, nav'));
  }

  function isCheckoutLabel(label) {
    return /\b((secure |proceed to )?check ?out( now)?)\b/i.test(label) && !EXPRESS.test(label) && label.length < 60;
  }

  /** inDrawerOnly: only accept a Checkout button inside the "added to bag" popup / mini-bag. */
  function findCheckout(inDrawerOnly) {
    const list = controls().filter((el) => isCheckoutLabel(labelOf(el)));
    if (inDrawerOnly) return list.find((el) => el.closest(DRAWER)) || null;
    return list.find((el) => !el.closest('header, nav')) || list[0] || null;
  }

  function findBasket() {
    const list = controls().filter((el) => {
      const label = labelOf(el).toLowerCase();
      if (/add to (bag|cart)|check ?out/.test(label) || label.length > 60) return false;
      return /\b(view|open|my|shopping|go to)?\s*(bag|basket|cart|trolley)\b/.test(label);
    });
    return list.find((el) => el.closest(DRAWER)) || list[0] || null;
  }

  function onCheckoutPage() {
    return /\/checkout/i.test(location.pathname);
  }

  function readFlow() {
    try { return JSON.parse(sessionStorage.getItem(FLOW_KEY) || 'null'); } catch { return null; }
  }
  function saveFlow(flow) { sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow)); }
  function clearFlow() { sessionStorage.removeItem(FLOW_KEY); }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------
  Object.assign(panel.style, {
    position: 'fixed', right: '18px', bottom: '18px', width: '310px', maxHeight: '85vh', overflowY: 'auto',
    padding: '14px', background: '#fff', color: '#172033', border: '1px solid #aaa', borderRadius: '12px',
    boxShadow: '0 3px 16px #0003', zIndex: '2147483647', font: '14px/1.5 sans-serif',
  });

  function makeButton(label, primary = false) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    Object.assign(b.style, {
      display: 'block', width: '100%', padding: '9px', marginTop: '7px', border: primary ? '0' : '1px solid #d4d7dd',
      borderRadius: '6px', background: primary ? '#1a2540' : '#f5f6f8', color: primary ? '#fff' : '#172033',
      cursor: 'pointer', textAlign: 'left', font: 'inherit',
    });
    return b;
  }

  const head = document.createElement('div');
  Object.assign(head.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' });
  const heading = document.createElement('strong');
  heading.textContent = '⚡ TCGBot Quick Checkout';
  const minimise = document.createElement('button');
  minimise.type = 'button';
  minimise.textContent = '–';
  minimise.title = 'Minimise';
  Object.assign(minimise.style, { border: '1px solid #d4d7dd', background: '#f5f6f8', borderRadius: '6px', cursor: 'pointer', padding: '0 8px', font: 'inherit' });
  head.append(heading, minimise);

  const body = document.createElement('div');
  const productInfo = document.createElement('p');
  productInfo.style.margin = '8px 0 0';
  const status = document.createElement('p');
  status.style.margin = '6px 0 0';
  status.textContent = 'Ready.';
  const sync = document.createElement('p');
  Object.assign(sync.style, { margin: '6px 0 0', fontSize: '12px', color: '#5b6474' });
  sync.textContent = 'Using saved product list.';

  const startButton = makeButton('Add to Bag → Checkout', true);
  const stopButton = makeButton('Stop');
  const divider = document.createElement('hr');
  divider.style.marginTop = '14px';
  const listHeading = document.createElement('strong');
  listHeading.textContent = 'Products · priority order';
  const list = document.createElement('div');

  body.append(productInfo, status, startButton, stopButton, sync, divider, listHeading, list);
  panel.append(head, body);

  function setStatus(text) {
    status.textContent = text;
  }

  function renderProducts() {
    const cur = currentProduct();
    productInfo.textContent = cur ? `${cur.name} · SKU ${cur.sku}` : 'Open one of your products below, then press the button.';
    list.textContent = '';
    products.forEach((p, i) => {
      const price = typeof p.price === 'number' ? ` — $${p.price}` : '';
      const b = makeButton(`${i + 1}. ${p.name}${price}`);
      if (cur && cur.sku === p.sku) { b.style.borderColor = '#1a2540'; b.style.fontWeight = '700'; }
      b.addEventListener('click', () => window.open(p.url, '_blank', 'noopener'));
      list.appendChild(b);
    });
  }

  let collapsed = sessionStorage.getItem('tcgbotQuickCollapsed') === '1';
  function applyCollapsed() {
    body.style.display = collapsed ? 'none' : '';
    minimise.textContent = collapsed ? '+' : '–';
    panel.style.width = collapsed ? 'auto' : '310px';
  }
  minimise.addEventListener('click', () => {
    collapsed = !collapsed;
    sessionStorage.setItem('tcgbotQuickCollapsed', collapsed ? '1' : '0');
    applyCollapsed();
  });

  // ---------------------------------------------------------------------------
  // The flow: Add to Bag → (popup / bag page) → Checkout
  // ---------------------------------------------------------------------------
  async function runFlow(startFresh) {
    if (busy) return;
    busy = true;
    startButton.disabled = true;
    try {
      if (startFresh) {
        clearFlow();
        const product = currentProduct();
        if (!product) { setStatus('Open one of your products first (list below).'); return; }
        const add = findAddToBag();
        if (!add) {
          setStatus("Add to Bag isn't available — sold out, or the page is still loading.");
          report('error', 'Add to Bag not available', product);
          return;
        }
        // Save before clicking in case the site navigates straight away.
        saveFlow({ stage: 'add-clicked', startedAt: Date.now(), clickedAt: Date.now(), sku: product.sku });
        setStatus('Adding to your bag…');
        add.click();
        report('add', 'Clicked Add to Bag', product);
      }

      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const flow = readFlow();
        if (!flow) { setStatus('Stopped.'); return; }
        const product = products.find((p) => p.sku === flow.sku) || null;
        if (Date.now() - flow.startedAt > FLOW_MAX_AGE) {
          clearFlow();
          setStatus('Timed out. Check your bag and continue yourself.');
          report('error', 'Timed out before reaching checkout', product);
          return;
        }
        if (onCheckoutPage()) {
          clearFlow();
          setStatus('At checkout — finish the purchase yourself.');
          report('checkout', 'Reached checkout', product);
          return;
        }

        if (flow.stage === 'add-clicked') {
          const since = Date.now() - (flow.clickedAt || flow.startedAt);
          // Give the bag a moment to update before trusting any Checkout button.
          if (since > 500) {
            const checkout = findCheckout(true);
            if (checkout) {
              clearFlow();
              setStatus('Opening checkout — finish the purchase yourself.');
              report('checkout', 'Opening checkout', product);
              checkout.click();
              return;
            }
          }
          if (since > 1500) {
            const basket = findBasket();
            if (basket) {
              saveFlow({ ...flow, stage: 'basket-clicked' });
              setStatus('Opening your bag…');
              report('basket', 'Opening the bag', product);
              basket.click();
            }
          }
        } else if (flow.stage === 'basket-clicked') {
          const checkout = findCheckout(true) || findCheckout(false);
          if (checkout) {
            clearFlow();
            setStatus('Opening checkout — finish the purchase yourself.');
            report('checkout', 'Opening checkout', product);
            checkout.click();
            return;
          }
        }
        await wait(250);
      }
      clearFlow();
      setStatus("Checkout button wasn't found in time. Open your bag and continue yourself.");
      report('error', 'Checkout button not found in time', currentProduct());
    } catch {
      clearFlow();
      setStatus('Interrupted — please continue yourself.');
    } finally {
      busy = false;
      startButton.disabled = false;
    }
  }

  startButton.addEventListener('click', () => runFlow(true));
  stopButton.addEventListener('click', () => {
    clearFlow();
    setStatus('Stopped. You can continue yourself.');
  });

  renderProducts();
  applyCollapsed();
  document.body.appendChild(panel);

  // Get the latest list from the dashboard (if it's running).
  dashboard('GET', '/api/quick/products').then((res) => {
    if (res && Array.isArray(res.products)) {
      products = res.products.filter((p) => p.enabled !== false);
      sync.textContent = 'Synced with your TCGBot dashboard ✓';
      renderProducts();
    } else {
      sync.textContent = 'Dashboard not running — using saved product list.';
    }
  });

  // Carry on if the site navigated (e.g. to the bag page) mid-flow.
  if (readFlow()) runFlow(false);
})();
