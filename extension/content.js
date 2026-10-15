// TCGBot Quick Checkout — runs on store pages (see manifest.json "matches").
// Shows the panel on stores you shop at, and carries an in-progress checkout
// across page changes (product → bag → checkout).

(async () => {
  'use strict';
  if (window.top !== window.self) return;
  if (document.getElementById(TCGBotQuick.PANEL_ID)) return;

  const STORE_HOSTS = ['www.kmart.com.au', 'www.ebgames.com.au', 'www.zingpopculture.com.au', 'www.jbhifi.com.au', 'www.target.com.au', 'www.bigw.com.au', 'www.toysrus.com.au', 'www.amazon.com.au'];

  const ask = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res));
    } catch {
      resolve(null); // extension was reloaded; refresh the page
    }
  });

  const res = await ask({ type: 'products' });
  const products = (res && res.products) || [];
  const productHosts = new Set(products.map((p) => { try { return new URL(p.url).host; } catch { return ''; } }));
  // Only show up on the big stores, or on a site you have a product from.
  if (!STORE_HOSTS.includes(location.hostname) && !productHosts.has(location.host)) return;

  // Opened from the dashboard's ⚡ Buy button? (…#tcgbot-go=<one-time code>)
  const goMatch = location.hash.match(/tcgbot-go=([A-Za-z0-9_-]{8,64})/);
  if (goMatch) {
    const rest = location.hash.replace(/&?tcgbot-go=[A-Za-z0-9_-]+/, '').replace(/^#&?/, '#');
    history.replaceState(history.state, '', location.pathname + location.search + (rest === '#' ? '' : rest));
  }

  const store = TCGBotQuick.sessionStore('tcgbotQuickFlow');
  let busy = false;
  const report = (type, message, product) => ask({
    type: 'event',
    event: { type, message, sku: product ? product.sku : null, name: product ? product.name : null, url: location.href },
  });

  async function go(fresh, extra = {}) {
    if (busy) return;
    busy = true;
    panel.startButton.disabled = true;
    try {
      const flow = store.read();
      const product = extra.product || TCGBotQuick.productForPage(products) || (flow ? products.find((p) => p.sku === flow.sku) : null) || null;
      await TCGBotQuick.run({ fresh, product, store, setStatus: panel.setStatus, report, followPages: true, ...extra });
    } catch {
      store.clear();
      panel.setStatus('Interrupted — please continue yourself.');
    } finally {
      busy = false;
      panel.startButton.disabled = false;
    }
  }

  const panel = TCGBotQuick.makePanel({
    products,
    note: res && res.online ? 'Synced with your TCGBot dashboard ✓'
      : products.length ? 'TCGBot isn\'t running — using your last saved list.' : 'Start TCGBot to load your product list.',
    onStart: () => go(true),
    onStop: () => { store.clear(); panel.setStatus('Stopped. You can continue yourself.'); },
  });

  if (goMatch) {
    const ok = await ask({ type: 'claim', code: goMatch[1] });
    if (ok && ok.ok) {
      const listed = products.find((p) => p.sku === ok.sku);
      const product = { ...(listed || {}), sku: ok.sku, name: ok.name || (listed && listed.name) || ok.sku, quantity: ok.quantity };
      panel.setNote(`Started from your TCGBot dashboard · Qty ${ok.quantity}`);
      // The buy box can take a few seconds to appear on a fresh page load.
      go(true, { product, quantity: ok.quantity, waitForButtonMs: 12000 });
      return;
    }
    panel.setNote('That ⚡ Buy link has expired — press the button below, or ⚡ Buy again in the dashboard.');
  }

  // Carry on if the store changed page mid-checkout.
  if (store.read()) go(false);
})();
