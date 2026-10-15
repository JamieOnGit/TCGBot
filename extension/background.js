// TCGBot Quick Checkout — background worker.
// Talks to your local TCGBot dashboard (http://127.0.0.1:<port>) for the
// product list, to redeem ⚡ Buy codes, to fetch your details for checkout
// autofill, and to report what happened. Keeps the last product list so the
// panel still works when TCGBot isn't running. Your profile and card are never
// stored by the extension: they're fetched from the dashboard when a checkout
// form needs them, using a short-lived pass tied to one tab and one store.

const DEFAULT_PORT = 8787;

async function dashboardBase() {
  const { port } = await chrome.storage.local.get('port');
  return `http://127.0.0.1:${Number(port) || DEFAULT_PORT}`;
}

async function post(path, body) {
  const res = await fetch(`${await dashboardBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tcgbot': '1' },
    body: JSON.stringify(body || {}),
  });
  return res.ok ? res.json() : null;
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

// --- checkout autofill passes (kept in memory-only session storage) ---------
const passKey = (tabId) => `fill:${tabId}`;

async function savePass(tabId, pass) {
  if (!pass || !pass.fillToken || tabId == null) return;
  await chrome.storage.session.set({ [passKey(tabId)]: { token: pass.fillToken, host: pass.host, expires: Date.now() + 15 * 60 * 1000 } });
}

async function fillData(sender, part) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return null;
  const key = passKey(tabId);
  const pass = (await chrome.storage.session.get(key))[key];
  if (!pass || Date.now() > pass.expires) return null;
  // Only for the store the checkout was started on.
  let topHost = '';
  try { topHost = new URL(sender.tab.url).host; } catch { return null; }
  if (pass.host && topHost !== pass.host) return null;
  try {
    const data = await post('/api/quick/fill', { token: pass.token });
    if (!data) return null;
    return part === 'card' ? { card: data.card, cardLocked: data.cardLocked } : data;
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || typeof msg !== 'object') return sendResponse(null);
      switch (msg.type) {
        case 'products':
          return sendResponse(await getProducts());
        case 'event':
          await post('/api/quick/events', msg.event).catch(() => null);
          return sendResponse({ ok: true });
        case 'claim': {
          // A "⚡ Buy" code from the dashboard: confirm it once, then keep its autofill pass for this tab.
          const res = await post('/api/quick/claim', { code: msg.code }).catch(() => null);
          if (res && res.ok) await savePass(sender.tab && sender.tab.id, res);
          return sendResponse(res);
        }
        case 'startFill': {
          // You pressed the panel's button: get an autofill pass for this tab's store.
          let host = '';
          try { host = new URL(sender.tab.url).host; } catch { return sendResponse(null); }
          const res = await post('/api/quick/fill-token', { host }).catch(() => null);
          if (res && res.fillToken) await savePass(sender.tab.id, { fillToken: res.fillToken, host });
          return sendResponse(res ? { ok: true } : null);
        }
        case 'fillData':
          return sendResponse(await fillData(sender, msg.part));
        case 'endFill':
          if (sender.tab) await chrome.storage.session.remove(passKey(sender.tab.id));
          return sendResponse({ ok: true });
        case 'setPort':
          await chrome.storage.local.set({ port: Number(msg.port) || DEFAULT_PORT });
          return sendResponse(await getProducts());
        case 'getPort': {
          const { port } = await chrome.storage.local.get('port');
          return sendResponse({ port: Number(port) || DEFAULT_PORT });
        }
        default:
          return sendResponse(null);
      }
    } catch {
      return sendResponse(null);
    }
  })();
  return true; // reply asynchronously
});

chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove(passKey(tabId)); });
