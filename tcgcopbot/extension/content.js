// TCGCopBot — runs on store pages. Shows the small panel, runs
// Add to Bag → Checkout when you press a TCGCopBot button (the panel, or
// ⚡ Buy in your dashboard), carries it across page changes, then fills in
// checkout up to the final button — which you press yourself.

(async () => {
  'use strict';
  if (window.top !== window.self) return;

  const STORE_HOSTS = ['www.kmart.com.au', 'www.ebgames.com.au', 'www.zingpopculture.com.au', 'www.jbhifi.com.au', 'www.target.com.au', 'www.bigw.com.au', 'www.toysrus.com.au', 'www.amazon.com.au'];
  const ASSIST_KEY = 'tcbAssist';
  const ASSIST_TTL = 15 * 60 * 1000;

  const ask = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res));
    } catch {
      resolve(null); // the extension was updated; refresh the page
    }
  });

  const res = await ask({ type: 'products' });
  const products = (res && res.products) || [];
  const productHosts = new Set(products.map((p) => { try { return new URL(p.url).host; } catch { return ''; } }));
  if (!STORE_HOSTS.includes(location.hostname) && !productHosts.has(location.host)) return;

  // The ⚡ Buy code: grabbed by capture.js as the page started loading (or still in the address).
  let goCode = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem('tcbGoCode') || 'null');
    sessionStorage.removeItem('tcbGoCode');
    if (saved && Date.now() - saved.at < 2 * 60 * 1000) goCode = saved.code;
  } catch { /* ignore */ }
  if (!goCode) {
    const m = location.hash.match(/tcb-go=([A-Za-z0-9_-]{8,64})/);
    if (m) goCode = m[1];
  }

  const store = TCBQuick.sessionStore('tcbFlow');
  const assistFlag = {
    on: () => { try { sessionStorage.setItem(ASSIST_KEY, JSON.stringify({ until: Date.now() + ASSIST_TTL })); } catch { /* ignore */ } },
    off: () => { try { sessionStorage.removeItem(ASSIST_KEY); } catch { /* ignore */ } },
    active: () => { try { const a = JSON.parse(sessionStorage.getItem(ASSIST_KEY) || 'null'); return !!a && Date.now() < a.until; } catch { return false; } },
  };
  let busy = false;
  let assisting = false;
  const report = (type, message, product) => ask({
    type: 'event',
    event: { type, message, sku: product ? product.sku : null, name: product ? product.name : null, url: location.href },
  });

  async function fillCheckout() {
    if (assisting || !assistFlag.active()) return;
    assisting = true;
    try {
      const data = await ask({ type: 'fillData', part: 'all' });
      if (!data) {
        panel.setStatus('Couldn\'t get your delivery details from your account — fill in checkout yourself.');
        return;
      }
      const result = await TCBFill.assist({
        values: TCBFill.fieldValues(data.profile, data.card),
        hasCard: !!data.card,
        cardLocked: !!data.cardLocked,
        setStatus: panel.setStatus,
        report: (type, message) => report(type === 'ready' ? 'ready' : type === 'error' ? 'error' : 'step', message, null),
        isActive: assistFlag.active,
      });
      if (result !== 'ready' && result !== 'stopped') assistFlag.off();
      if (result === 'done') ask({ type: 'endFill' });
    } finally {
      assisting = false;
    }
  }

  async function go(fresh, extra = {}) {
    if (busy) return;
    busy = true;
    panel.startButton.disabled = true;
    try {
      const flow = store.read();
      const product = extra.product || TCBQuick.productForPage(products) || (flow ? products.find((p) => p.sku === flow.sku) : null) || null;
      const result = await TCBQuick.run({ fresh, product, products, store, setStatus: panel.setStatus, report, followPages: true, ...extra });
      // Same-page checkouts (no reload): carry straight on with the form.
      if (result === 'checkout') setTimeout(fillCheckout, 800);
    } catch {
      store.clear();
      panel.setStatus('Interrupted — please continue yourself.');
    } finally {
      busy = false;
      panel.startButton.disabled = false;
    }
  }

  const note = !res || !res.paired ? 'Not connected — click the TCGCopBot icon in your toolbar to connect your account.'
    : !res.online ? (products.length ? 'Offline — using your last saved list.' : 'Can\'t reach your account right now.')
      : res.active === false ? 'Your trial has ended — subscribe in your dashboard to use ⚡ Buy and autofill.' : '';

  const panel = TCBQuick.makePanel({
    products,
    note,
    onStart: async () => {
      // Your click on the panel: fill in checkout afterwards too.
      const ok = await ask({ type: 'startFill' });
      if (ok) assistFlag.on();
      go(true);
    },
    onStop: () => { store.clear(); assistFlag.off(); panel.setStatus('Stopped. You can continue yourself.'); },
  });

  if (goCode) {
    const claim = await ask({ type: 'claim', code: goCode });
    if (claim && claim.ok) {
      const listed = products.find((p) => p.sku === claim.sku);
      const product = { ...(listed || {}), sku: claim.sku, name: claim.name || (listed && listed.name) || claim.sku, quantity: claim.quantity };
      assistFlag.on();
      panel.setNote(`Started from ⚡ Buy · Qty ${claim.quantity}`);
      // The buy box can take a few seconds to appear on a fresh page load.
      go(true, { product, quantity: claim.quantity, waitForButtonMs: 12000 });
      return;
    }
    panel.setNote(!res || !res.paired ? 'This browser isn\'t connected to your account — click the TCGCopBot icon to connect, then press ⚡ Buy again.'
      : claim && claim.status === 402 ? (claim.error || 'Your trial has ended — subscribe to use ⚡ Buy.')
        : claim === null || (claim && claim.status === 0) ? 'Couldn\'t reach your account to confirm the ⚡ Buy — check your connection.'
          : 'That ⚡ Buy link has expired or belongs to another account — press ⚡ Buy again.');
  }

  // Carry on where we left off after the store changed page.
  if (store.read()) go(false);
  else if (assistFlag.active()) fillCheckout();
})();
