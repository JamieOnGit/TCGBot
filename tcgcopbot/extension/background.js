// TCGCopBot — background worker.
//
// Talks to your TCGCopBot account (the server in config.js) with this
// browser's device token: your product list, ⚡ Buy codes, your delivery
// details for checkout, and what happened on the store page. Your card comes
// from the vault in this browser (vault.js) and is never sent to the server.
// Details are handed to a store page only while a checkout you started is
// running in that tab, on that store.

importScripts('config.js', 'vault.js');

const SERVER = TCB_CONFIG.server.replace(/\/+$/, '');
const SERVER_ORIGIN = new URL(SERVER).origin;
const VERSION = chrome.runtime.getManifest().version;
const PASS_TTL = 15 * 60 * 1000;

async function getAuth() {
  const { auth } = await chrome.storage.local.get('auth');
  return auth && auth.token && auth.server === SERVER ? auth : null;
}

async function api(method, path, body, { token } = {}) {
  const auth = token ? { token } : await getAuth();
  if (!auth) return { status: 401, body: { error: 'Not connected' } };
  let res;
  try {
    res = await fetch(SERVER + path, {
      method,
      headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return { status: 0, body: { error: `Can't reach ${TCB_CONFIG.appName}` } };
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !token) await forget(); // device was disconnected from the dashboard
  return { status: res.status, body: data };
}

async function forget() {
  const auth = await getAuth();
  if (auth) await TCBVault.lock(auth.user.id);
  await chrome.storage.local.remove('auth');
  const all = await chrome.storage.session.get(null);
  await chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith('fill:')));
}

function browserName() {
  const ua = navigator.userAgent;
  const name = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Brave/.test(ua) ? 'Brave' : 'Chrome';
  const os = /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${name}${os ? ` on ${os}` : ''}`;
}

async function pair(code) {
  let res;
  try {
    res = await fetch(`${SERVER}/api/ext/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: browserName(), version: VERSION }),
    });
  } catch {
    return { ok: false, error: `Can't reach ${TCB_CONFIG.appName} — check your internet connection` };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || `Couldn't connect (HTTP ${res.status})` };
  const previous = await getAuth();
  if (previous && previous.user.id !== data.user.id) await TCBVault.lock(previous.user.id);
  await chrome.storage.local.set({ auth: { token: data.token, user: data.user, device: data.device, server: SERVER, pairedAt: Date.now() } });
  return { ok: true, user: data.user };
}

async function getProducts() {
  const auth = await getAuth();
  if (!auth) return { products: [], online: false, paired: false };
  const cacheKey = `products:${auth.user.id}`;
  const res = await api('GET', '/api/ext/products');
  if (res.status === 200 && res.body) {
    await chrome.storage.local.set({ [cacheKey]: { products: res.body.products, at: Date.now() } });
    return { products: res.body.products, online: true, paired: true, active: res.body.active, user: auth.user };
  }
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  const still = await getAuth();
  return { products: (still && cached && cached.products) || [], online: false, paired: !!still, user: still ? still.user : null };
}

// --- checkout passes: which tab may receive your details, for how long -----
const passKey = (tabId) => `fill:${tabId}`;

async function savePass(tabId, host, userId) {
  if (tabId == null || !host) return;
  await chrome.storage.session.set({ [passKey(tabId)]: { host, userId, expires: Date.now() + PASS_TTL } });
}

/** The host of the page in the tab (the top page, even for a message from a payment frame). */
function tabHost(sender) {
  try { return new URL(sender.tab.url || (sender.frameId === 0 ? sender.url : '')).host; } catch { return ''; }
}

async function fillData(sender, part) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return null;
  const auth = await getAuth();
  if (!auth) return null;
  const pass = (await chrome.storage.session.get(passKey(tabId)))[passKey(tabId)];
  if (!pass || Date.now() > pass.expires || pass.userId !== auth.user.id) return null;
  // Only for the store the checkout was started on.
  if (tabHost(sender) !== pass.host) return null;
  const card = await TCBVault.card(auth.user.id);
  const vault = await TCBVault.status(auth.user.id);
  if (part === 'card') return { card, cardLocked: vault.saved && !vault.unlocked };
  const res = await api('GET', '/api/ext/profile');
  if (res.status !== 200 || !res.body) return null;
  return { profile: res.body.profile, card, cardLocked: vault.saved && !vault.unlocked };
}

async function status() {
  const auth = await getAuth();
  if (!auth) return { paired: false, server: SERVER, appName: TCB_CONFIG.appName, version: VERSION };
  const me = await api('GET', `/api/ext/me?v=${encodeURIComponent(VERSION)}`);
  const still = await getAuth();
  if (!still) return { paired: false, server: SERVER, appName: TCB_CONFIG.appName, version: VERSION, disconnected: true };
  return {
    paired: true, server: SERVER, appName: TCB_CONFIG.appName, version: VERSION, user: still.user,
    online: me.status === 200, entitlement: me.body && me.body.entitlement, card: await TCBVault.status(still.user.id),
  };
}

const fromApp = (sender) => {
  try { return !!sender.tab && sender.frameId === 0 && new URL(sender.url).origin === SERVER_ORIGIN; } catch { return false; }
};
// The popup and Settings page (Settings opens in a tab, so check the page's address, not the tab).
const fromExtensionPage = (sender) => sender.id === chrome.runtime.id && String(sender.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/`);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg !== 'object' || sender.id !== chrome.runtime.id) return null;
    switch (msg.type) {
      // From store pages
      case 'products': return getProducts();
      case 'event': {
        await api('POST', '/api/ext/events', msg.event);
        return { ok: true };
      }
      case 'claim': {
        // A ⚡ Buy code from the dashboard: confirm it once, then allow checkout autofill in this tab.
        const auth = await getAuth();
        if (!auth || !sender.tab) return null;
        const res = await api('POST', '/api/ext/claim', { code: msg.code });
        if (res.status === 200 && res.body && res.body.ok) {
          await savePass(sender.tab.id, res.body.host === tabHost(sender) ? res.body.host : tabHost(sender), auth.user.id);
          return res.body;
        }
        return { ok: false, status: res.status, error: res.body && res.body.error };
      }
      case 'startFill': {
        // You pressed the panel's button (a real click): allow autofill for this tab's store.
        const auth = await getAuth();
        if (!auth || !sender.tab) return null;
        await savePass(sender.tab.id, tabHost(sender), auth.user.id);
        return { ok: true };
      }
      case 'fillData': return fillData(sender, msg.part);
      case 'endFill':
        if (sender.tab) await chrome.storage.session.remove(passKey(sender.tab.id));
        return { ok: true };

      // From your TCGCopBot dashboard (bridge.js) or the extension's own pages
      case 'appHello': {
        if (!fromApp(sender) && !fromExtensionPage(sender)) return null;
        const auth = await getAuth();
        return { version: VERSION, paired: !!auth, userId: auth ? auth.user.id : null, email: auth ? auth.user.email : null };
      }
      case 'pair':
        if (!fromApp(sender) && !fromExtensionPage(sender)) return null;
        return pair(String(msg.code || ''));

      // From the popup / settings page only
      case 'status':
        return fromExtensionPage(sender) ? status() : null;
      case 'unpair': {
        if (!fromExtensionPage(sender)) return null;
        await api('POST', '/api/ext/unpair', {});
        await forget();
        return { ok: true };
      }
      case 'vault': {
        if (!fromExtensionPage(sender)) return null;
        const auth = await getAuth();
        if (!auth) return { error: 'Connect the extension to your account first' };
        try {
          if (msg.action === 'save') return { status: await TCBVault.save(auth.user.id, msg.card, msg.passphrase) };
          if (msg.action === 'unlock') return { status: await TCBVault.unlock(auth.user.id, msg.passphrase, Number(msg.hours) || 0) };
          if (msg.action === 'lock') { await TCBVault.lock(auth.user.id); return { status: await TCBVault.status(auth.user.id) }; }
          if (msg.action === 'remove') { await TCBVault.remove(auth.user.id); return { status: await TCBVault.status(auth.user.id) }; }
          return { status: await TCBVault.status(auth.user.id) };
        } catch (e) {
          return { error: e.message };
        }
      }
      default:
        return null;
    }
  })().then(sendResponse, () => sendResponse(null));
  return true; // reply asynchronously
});

chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove(passKey(tabId)); });
