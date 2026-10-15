// TCGBot Quick Checkout — background worker.
// Talks to your local TCGBot dashboard (http://127.0.0.1:<port>) for the
// product list and to report what happened. Keeps the last list so the panel
// still works when TCGBot isn't running.

const DEFAULT_PORT = 8787;

async function dashboardBase() {
  const { port } = await chrome.storage.local.get('port');
  return `http://127.0.0.1:${Number(port) || DEFAULT_PORT}`;
}

async function getProducts() {
  try {
    const res = await fetch(`${await dashboardBase()}/api/quick/products`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    await chrome.storage.local.set({ products: data.products, syncedAt: Date.now() });
    return { products: data.products, online: true };
  } catch {
    const { products, syncedAt } = await chrome.storage.local.get(['products', 'syncedAt']);
    return { products: products || [], online: false, syncedAt: syncedAt || null };
  }
}

async function sendEvent(event) {
  try {
    await fetch(`${await dashboardBase()}/api/quick/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tcgbot': '1' },
      body: JSON.stringify(event),
    });
  } catch {
    /* dashboard not running — nothing to report to */
  }
}

// A "⚡ Buy" press in the dashboard opens the product with a one-time code.
// The dashboard confirms the code (once, and only shortly after the press),
// so another website can't start an add-to-bag just by linking to a product.
async function claim(code) {
  try {
    const res = await fetch(`${await dashboardBase()}/api/quick/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tcgbot': '1' },
      body: JSON.stringify({ code }),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === 'products') sendResponse(await getProducts());
    else if (msg && msg.type === 'event') { await sendEvent(msg.event); sendResponse({ ok: true }); }
    else if (msg && msg.type === 'claim') sendResponse(await claim(msg.code));
    else if (msg && msg.type === 'setPort') { await chrome.storage.local.set({ port: Number(msg.port) || DEFAULT_PORT }); sendResponse(await getProducts()); }
    else if (msg && msg.type === 'getPort') { const { port } = await chrome.storage.local.get('port'); sendResponse({ port: Number(port) || DEFAULT_PORT }); }
    else sendResponse(null);
  })();
  return true; // reply asynchronously
});
