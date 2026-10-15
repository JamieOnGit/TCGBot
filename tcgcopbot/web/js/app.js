// The dashboard. Everything here is the signed-in user's own data.
import { $, $$, ApiError, ago, api, busy, h, money, setMsg, toast, when } from './common.js';

const STATUS = {
  in_stock: 'In stock', preorder: 'Pre-order open', out_of_stock: 'Out of stock', coming_soon: 'Coming soon', not_listed: 'Not listed yet',
  not_found: 'Page not found', blocked: 'Blocked by site', error: 'Error', unknown: 'Unknown', pending: 'Checking soon',
};

const state = { me: null, products: [], editing: null, ext: null, feedOldest: null };

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const TABS = ['quick', 'watch', 'details', 'extension', 'alerts', 'activity', 'billing', 'account'];
const loaders = {};

function showTab() {
  const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'quick';
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  $$('.side a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  if (loaders[tab]) loaders[tab]().catch(showError);
}
window.addEventListener('hashchange', showTab);

function showError(e) {
  if (e instanceof ApiError && e.status === 401) return;
  toast('Something went wrong', e.message, 'warn');
}

// ---------------------------------------------------------------------------
// Account, plan and the banner
// ---------------------------------------------------------------------------
async function loadMe() {
  state.me = await api('GET', '/api/me');
  const { user, entitlement: ent, app } = state.me;
  $('#who').textContent = user.email;
  $('#admin-link').hidden = user.role !== 'admin';
  $('#plan-pill').textContent = ent.label;
  $('#plan-pill').className = `pill ${ent.active ? (ent.warning ? 'warn' : 'ok') : 'err'}`;
  $('#w-interval').textContent = app.monitorIntervalSeconds;
  $('#acct-email').value = user.email;
  $('#acct-name').value = user.name || '';
  renderBanner();
}

function renderBanner() {
  const { entitlement: ent, app } = state.me;
  const b = $('#banner');
  b.textContent = '';
  if (new URLSearchParams(location.search).get('billing') === 'success') {
    b.append(h('div', { class: 'notice ok' }, 'Thanks for subscribing! It can take a few seconds for your plan to update.'));
  }
  if (!ent.active) {
    b.append(h('div', { class: 'notice err' }, h('b', {}, `${ent.label}. `), app.billing ? 'Subscribe to keep using ⚡ Buy, checkout autofill and restock alerts. Your lists and details are kept.' : 'Contact support to keep using ⚡ Buy and restock alerts. Your lists and details are kept.',
      ' ', app.billing ? h('a', { href: '#billing', class: 'btn small primary' }, 'Subscribe') : null));
  } else if (ent.warning) {
    b.append(h('div', { class: 'notice warn' }, ent.label, ' ', h('a', { href: '#billing' }, 'Update billing')));
  } else if (ent.plan === 'trial' && ent.trialEndsAt && ent.trialEndsAt - Date.now() < 3 * 86400000 && app.billing) {
    b.append(h('div', { class: 'notice warn' }, `${ent.label}. `, h('a', { href: '#billing' }, 'Subscribe now'), ' so ⚡ Buy keeps working on drop day.'));
  }
}

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => null);
  location.href = '/';
});

// ---------------------------------------------------------------------------
// The browser extension on this computer
// ---------------------------------------------------------------------------
function askExtension(type, extra = {}, timeout = 1500) {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const onMsg = (e) => {
      if (e.source !== window || e.origin !== location.origin || !e.data || e.data.source !== 'tcgcopbot-ext' || e.data.id !== id) return;
      window.removeEventListener('message', onMsg);
      resolve(e.data.reply);
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ source: 'tcgcopbot-app', type, id, ...extra }, location.origin);
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null); }, timeout);
  });
}

async function detectExtension() {
  const version = document.documentElement.dataset.tcgcopbotExtension || null;
  if (!version) return { installed: false };
  const hello = await askExtension('hello');
  return { installed: true, version, paired: !!(hello && hello.paired), userId: hello && hello.userId, email: hello && hello.email };
}

async function renderExtStatus() {
  state.ext = await detectExtension();
  const ext = state.ext;
  const me = state.me.user;
  const latest = state.me.app.extensionVersion;
  let level = 'warn';
  let text;
  if (!ext.installed) {
    text = [h('b', {}, "The extension isn't in this browser. "), "⚡ Buy will open the product, but nothing will be added automatically. ", h('a', { href: '#extension' }, 'Install it')];
  } else if (!ext.paired) {
    text = [h('b', {}, 'The extension is installed but not connected. '), h('button', { class: 'btn small primary', type: 'button', onclick: pairNow }, 'Connect this browser')];
  } else if (ext.userId !== me.id) {
    level = 'err';
    text = [h('b', {}, `This browser's extension is connected to another account (${ext.email}). `), 'Reconnect it to yours: ', h('button', { class: 'btn small primary', type: 'button', onclick: pairNow }, 'Connect to my account')];
  } else {
    level = 'ok';
    text = [h('b', {}, '✓ Extension connected. '), `⚡ Buy runs automatically in this browser. Version ${ext.version}.`];
    if (ext.version !== latest) {
      level = 'warn';
      text.push(' ', h('b', {}, `Version ${latest} is available — `), h('a', { href: '#extension' }, 'update it'));
    }
  }
  for (const id of ['#ext-status', '#ext-status-2']) {
    const el = $(id);
    el.className = `notice ${level}`;
    el.textContent = '';
    el.append(...text.map((t) => (t instanceof Node ? t.cloneNode(true) : t)));
    $$('button', el).forEach((b) => b.addEventListener('click', pairNow));
  }
}

async function pairNow() {
  const msg = $('#pair-msg');
  if (!document.documentElement.dataset.tcgcopbotExtension) {
    setMsg(msg, "Install the extension first, then reload this page.");
    location.hash = '#extension';
    return;
  }
  try {
    const { code } = await api('POST', '/api/devices/pair-code');
    const reply = await askExtension('pair', { code }, 10000);
    if (reply && reply.ok) {
      toast('Extension connected', `This browser is now connected to ${reply.user.email}.`, 'success');
      setMsg(msg, 'Connected!', true);
    } else {
      setMsg(msg, (reply && reply.error) || "The extension didn't answer — reload this page and try again.");
    }
  } catch (e) {
    setMsg(msg, e.message);
  }
  await renderExtStatus();
  loadDevices().catch(() => null);
}
$('#pair-now').addEventListener('click', pairNow);

$('#pair-code-btn').addEventListener('click', async () => {
  const r = await api('POST', '/api/devices/pair-code');
  $('#pair-code').textContent = r.code;
  $('#pair-expiry').textContent = `Works once, until ${new Date(r.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  $('#pair-code-box').hidden = false;
});

async function loadDevices() {
  const { devices } = await api('GET', '/api/devices');
  const list = $('#devices');
  list.textContent = '';
  if (!devices.length) list.append(h('li', { class: 'empty' }, 'No browsers connected yet.'));
  for (const d of devices) {
    list.append(h('li', {},
      h('div', { class: 'info' }, h('div', { class: 'name' }, d.name), h('div', { class: 'meta' }, `Connected ${when(d.createdAt)} · last used ${ago(d.lastSeenAt)}${d.version ? ` · v${d.version}` : ''}`)),
      h('div', { class: 'acts' }, h('button', {
        class: 'btn small danger', type: 'button',
        onclick: async () => {
          if (!confirm(`Disconnect ${d.name}? It will stop working until you connect it again.`)) return;
          await api('DELETE', `/api/devices/${d.id}`);
          loadDevices();
        },
      }, 'Disconnect'))));
  }
}

loaders.extension = async () => {
  const store = state.me.app.chromeStoreUrl;
  $('#store-install').hidden = !store;
  if (store) $('#store-link').href = store;
  await Promise.all([renderExtStatus(), loadDevices()]);
};

// ---------------------------------------------------------------------------
// ⚡ Quick Checkout
// ---------------------------------------------------------------------------
function productRow(p, i) {
  const qty = h('input', { class: 'qty', type: 'number', min: '1', max: '10', value: String(p.quantity || 1), 'aria-label': `Quantity for ${p.name}` });
  qty.addEventListener('change', async () => {
    const q = Math.max(1, Math.min(10, parseInt(qty.value, 10) || 1));
    qty.value = q;
    await api('PUT', `/api/products/${p.id}`, { quantity: q }).catch(showError);
  });
  const buy = h('button', { class: 'btn primary small', type: 'button', disabled: !p.enabled }, '⚡ Buy');
  buy.addEventListener('click', () => goBuy(p, qty));
  const move = async (dir) => {
    const ids = state.products.map((x) => x.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const r = await api('POST', '/api/products/reorder', { ids });
    state.products = r.products;
    renderProducts();
  };
  return h('li', { class: p.enabled ? '' : 'off', dataset: { id: p.id } },
    h('div', { class: 'info' },
      h('div', { class: 'name' }, `${i + 1}. ${p.name}`),
      h('div', { class: 'meta' }, [p.store, `SKU ${p.sku}`, money(p.price)].filter(Boolean).join(' · '))),
    h('div', { class: 'acts' },
      h('label', { class: 'small muted' }, 'Qty'), qty, buy,
      h('a', { class: 'btn small', href: p.url, target: '_blank', rel: 'noopener' }, 'Open ↗'),
      h('button', { class: 'btn small', type: 'button', title: 'Move up', 'aria-label': 'Move up', onclick: () => move(-1) }, '↑'),
      h('button', { class: 'btn small', type: 'button', title: 'Move down', 'aria-label': 'Move down', onclick: () => move(1) }, '↓'),
      h('button', { class: 'btn small', type: 'button', onclick: () => editProduct(p) }, 'Edit'),
      h('button', {
        class: 'btn small', type: 'button',
        onclick: async () => { await api('PUT', `/api/products/${p.id}`, { enabled: !p.enabled }); loadProducts(); },
      }, p.enabled ? 'Hide' : 'Show'),
      h('button', {
        class: 'btn small danger', type: 'button', 'aria-label': `Delete ${p.name}`,
        onclick: async () => { if (confirm(`Delete ${p.name}?`)) { await api('DELETE', `/api/products/${p.id}`); loadProducts(); } },
      }, '✕')));
}

function renderProducts() {
  const list = $('#q-list');
  list.textContent = '';
  if (!state.products.length) list.append(h('li', { class: 'empty' }, 'No products yet — press "+ Add product".'));
  state.products.forEach((p, i) => list.append(productRow(p, i)));
}

async function loadProducts() {
  state.products = (await api('GET', '/api/products')).products;
  renderProducts();
}

async function goBuy(p, qtyInput) {
  const quantity = Math.max(1, Math.min(10, parseInt(qtyInput.value, 10) || 1));
  // Open the tab straight away (browsers block pop-ups opened after a delay).
  const win = window.open('about:blank', '_blank');
  try {
    const r = await api('POST', `/api/products/${p.id}/go`, { quantity });
    if (win) {
      win.opener = null;
      win.location.href = r.url;
    } else {
      location.href = r.url;
    }
    if (!state.ext || !state.ext.paired) toast('Opened the product', "The extension isn't connected in this browser, so it won't add to bag automatically.", 'warn');
  } catch (e) {
    if (win) win.close();
    if (e.status === 402) {
      toast('Subscription needed', e.message, 'warn');
      location.hash = '#billing';
    } else showError(e);
  }
}

function editProduct(p) {
  state.editing = p ? p.id : null;
  const f = $('#q-form');
  f.hidden = false;
  $('#q-form-title').textContent = p ? `Edit ${p.name}` : 'Add a product';
  $('#q-save').textContent = p ? 'Save changes' : 'Add product';
  $('#q-url').value = p ? p.url : '';
  $('#q-name').value = p ? p.name : '';
  $('#q-sku').value = p ? p.sku : '';
  $('#q-price').value = p && typeof p.price === 'number' ? p.price : '';
  setMsg($('#q-msg'), '');
  $('#q-url').focus();
}

$('#q-add-toggle').addEventListener('click', () => editProduct(null));
$('#q-cancel').addEventListener('click', () => { $('#q-form').hidden = true; state.editing = null; });
$('#q-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    const body = { url: $('#q-url').value, name: $('#q-name').value, sku: $('#q-sku').value, price: $('#q-price').value };
    try {
      if (state.editing) await api('PUT', `/api/products/${state.editing}`, body);
      else await api('POST', '/api/products', body);
      $('#q-form').hidden = true;
      state.editing = null;
      await loadProducts();
    } catch (err) {
      setMsg($('#q-msg'), err.message);
    }
  });
});
$('#q-starter').addEventListener('click', async () => {
  const r = await api('POST', '/api/products/starter');
  state.products = r.products;
  renderProducts();
  toast(r.added ? `Added ${r.added} product${r.added === 1 ? '' : 's'}` : 'You already have the starter list');
});

loaders.quick = async () => {
  await Promise.all([loadProducts(), renderExtStatus()]);
};

// ---------------------------------------------------------------------------
// 🔔 Watchlist
// ---------------------------------------------------------------------------
async function loadWatch() {
  const { items, active } = await api('GET', '/api/watch');
  const list = $('#w-list');
  list.textContent = '';
  if (!active) list.append(h('li', { class: 'notice warn' }, 'Restock checks are paused while your account has no active trial or subscription.'));
  if (!items.length) list.append(h('li', { class: 'empty' }, 'Nothing on your watchlist yet. Paste a product link above.'));
  for (const w of items) {
    const st = w.enabled ? w.status : 'paused';
    list.append(h('li', { class: w.enabled ? '' : 'off', dataset: { id: w.id } },
      h('div', { class: 'info' },
        h('div', { class: 'name' }, w.name),
        h('div', { class: 'meta' },
          [w.store, w.price != null ? money(w.price) : '', w.maxPrice != null ? `alert at ≤ ${money(w.maxPrice)}` : '', w.checkedAt ? `checked ${ago(w.checkedAt)}` : ''].filter(Boolean).join(' · ')),
        w.error ? h('div', { class: 'meta' }, w.error) : null),
      h('span', { class: `pill ${st}` }, st === 'paused' ? 'Paused' : STATUS[st] || st),
      h('div', { class: 'acts' },
        h('a', { class: 'btn small', href: w.url, target: '_blank', rel: 'noopener' }, 'Open ↗'),
        h('button', {
          class: 'btn small', type: 'button', title: 'Add to Quick Checkout',
          onclick: async () => {
            try {
              await api('POST', `/api/watch/${w.id}/quick`, {});
              toast('Added to Quick Checkout', w.name, 'success');
            } catch (e) {
              const sku = e.status === 400 ? prompt(`${e.message}\n\nSKU / keycode:`) : null;
              if (sku) { await api('POST', `/api/watch/${w.id}/quick`, { sku }); toast('Added to Quick Checkout', w.name, 'success'); } else if (e.status !== 400) showError(e);
            }
          },
        }, '+ ⚡ list'),
        h('button', { class: 'btn small', type: 'button', onclick: async () => { await api('PUT', `/api/watch/${w.id}`, { enabled: !w.enabled }); loadWatch(); } }, w.enabled ? 'Pause' : 'Resume'),
        h('button', { class: 'btn small danger', type: 'button', 'aria-label': `Stop watching ${w.name}`, onclick: async () => { if (confirm(`Stop watching ${w.name}?`)) { await api('DELETE', `/api/watch/${w.id}`); loadWatch(); } } }, '✕'))));
  }
}
loaders.watch = loadWatch;

$('#w-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    try {
      await api('POST', '/api/watch', { url: $('#w-url').value, name: $('#w-name').value, maxPrice: $('#w-max').value });
      e.target.reset();
      setMsg($('#w-msg'), 'Watching — the first check runs within a minute.', true);
      loadWatch();
    } catch (err) {
      setMsg($('#w-msg'), err.message);
    }
  });
});

// ---------------------------------------------------------------------------
// 📦 Delivery details
// ---------------------------------------------------------------------------
const PROFILE_FIELDS = { firstName: 'p-first', lastName: 'p-last', email: 'p-email', phone: 'p-phone', address1: 'p-a1', address2: 'p-a2', suburb: 'p-suburb', state: 'p-state', postcode: 'p-postcode' };
loaders.details = async () => {
  const { profile } = await api('GET', '/api/profile');
  for (const [k, id] of Object.entries(PROFILE_FIELDS)) $(`#${id}`).value = profile[k] || '';
  $('#p-email').placeholder = state.me.user.email;
};
$('#p-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    const body = Object.fromEntries(Object.entries(PROFILE_FIELDS).map(([k, id]) => [k, $(`#${id}`).value]));
    try {
      await api('PUT', '/api/profile', body);
      setMsg($('#p-msg'), 'Saved.', true);
    } catch (err) {
      setMsg($('#p-msg'), err.message);
    }
  });
});

// ---------------------------------------------------------------------------
// 📣 Alerts
// ---------------------------------------------------------------------------
loaders.alerts = async () => {
  const { alerts } = await api('GET', '/api/alerts');
  $('#a-hook').value = alerts.discordWebhook;
  $('#a-mention').value = alerts.discordMention;
  $('#a-email-restock').checked = alerts.emailOnRestock;
  $('#a-email-checkout').checked = alerts.emailOnCheckout;
  $('#a-email-note').textContent = state.me.app.email ? `Emails go to ${state.me.user.email}.` : 'Email alerts are not available yet on this server.';
};
$('#a-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    try {
      await api('PUT', '/api/alerts', {
        discordWebhook: $('#a-hook').value, discordMention: $('#a-mention').value,
        emailOnRestock: $('#a-email-restock').checked, emailOnCheckout: $('#a-email-checkout').checked,
      });
      setMsg($('#a-msg'), 'Saved.', true);
    } catch (err) {
      setMsg($('#a-msg'), err.message);
    }
  });
});
$('#a-test').addEventListener('click', async () => {
  try {
    await api('POST', '/api/alerts/test');
    setMsg($('#a-msg'), 'Test alert sent.', true);
  } catch (err) {
    setMsg($('#a-msg'), err.message);
  }
});

// ---------------------------------------------------------------------------
// 📋 Activity
// ---------------------------------------------------------------------------
function feedItem(ev) {
  return h('li', { dataset: { id: ev.id } },
    h('span', { class: `lvl ${ev.level}` }),
    h('time', { datetime: new Date(ev.createdAt).toISOString() }, when(ev.createdAt)),
    h('span', {}, ev.message, /^https?:\/\//i.test(ev.url || '') ? [' ', h('a', { href: ev.url, target: '_blank', rel: 'noopener' }, '↗')] : null));
}
async function loadFeed(more = false) {
  const before = more && state.feedOldest ? `&before=${state.feedOldest}` : '';
  const { events } = await api('GET', `/api/events?limit=50${before}`);
  const list = $('#feed');
  if (!more) list.textContent = '';
  if (!events.length && !more) list.append(h('li', { class: 'empty' }, 'Nothing yet.'));
  events.forEach((ev) => list.append(feedItem(ev)));
  if (events.length) state.feedOldest = events[events.length - 1].id;
  $('#feed-more').hidden = events.length < 50;
}
loaders.activity = () => loadFeed(false);
$('#feed-more').addEventListener('click', () => loadFeed(true).catch(showError));

// ---------------------------------------------------------------------------
// 💳 Billing
// ---------------------------------------------------------------------------
loaders.billing = async () => {
  const b = await api('GET', '/api/billing');
  const e = b.entitlement;
  const info = $('#b-info');
  info.textContent = '';
  const row = (k, v) => info.append(h('dt', {}, k), h('dd', {}, v));
  row('Plan', e.label);
  row('Price', b.price);
  if (e.plan === 'trial' && e.trialEndsAt) row('Trial ends', new Date(e.trialEndsAt).toLocaleString());
  if (e.currentPeriodEnd) row(e.cancelAtPeriodEnd ? 'Access until' : 'Renews', new Date(e.currentPeriodEnd).toLocaleDateString());
  const subscribed = ['active', 'past_due'].includes(e.plan);
  $('#b-subscribe').hidden = !b.configured || subscribed || e.plan === 'comped' || e.label === 'Admin';
  $('#b-portal').hidden = !b.configured || !b.hasCustomer;
  $('#b-note').textContent = b.configured ? 'Payments are handled securely by Stripe. Cancel any time from "Manage billing".' : 'Online payments are not set up on this server yet.';
};
async function goStripe(path, btn) {
  btn.disabled = true;
  try {
    const { url } = await api('POST', path);
    location.href = url;
  } catch (err) {
    setMsg($('#b-msg'), err.message);
    btn.disabled = false;
  }
}
$('#b-subscribe').addEventListener('click', (e) => goStripe('/api/billing/checkout', e.target));
$('#b-portal').addEventListener('click', (e) => goStripe('/api/billing/portal', e.target));

// ---------------------------------------------------------------------------
// 👤 Account
// ---------------------------------------------------------------------------
$('#acct-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    try {
      await api('PUT', '/api/me', { name: $('#acct-name').value });
      setMsg($('#acct-msg'), 'Saved.', true);
    } catch (err) {
      setMsg($('#acct-msg'), err.message);
    }
  });
});
$('#pw-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    try {
      await api('POST', '/api/me/password', { current: $('#pw-current').value, next: $('#pw-next').value });
      e.target.reset();
      setMsg($('#pw-msg'), 'Password changed.', true);
    } catch (err) {
      setMsg($('#pw-msg'), err.message);
    }
  });
});
$('#del-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!confirm('Delete your account and everything in it? This can\'t be undone.')) return;
  busy(e.target, async () => {
    try {
      await api('POST', '/api/me/delete', { password: $('#del-pw').value });
      location.href = '/?deleted=1';
    } catch (err) {
      setMsg($('#del-msg'), err.message);
    }
  });
});

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------
function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('event', (e) => {
    const ev = JSON.parse(e.data);
    if (ev.level === 'urgent' || ev.level === 'success' || ev.level === 'warn') toast(ev.title || ev.message, ev.title ? ev.message : '', ev.level, ev.level === 'urgent' ? 15000 : 6000);
    const list = $('#feed');
    if (!$('[data-panel="activity"]').hidden) {
      $('.empty', list)?.remove();
      list.prepend(feedItem(ev));
    }
    if (ev.type === 'billing') loadMe().catch(() => null);
  });
  es.addEventListener('watch', () => { if (!$('[data-panel="watch"]').hidden) loadWatch().catch(() => null); });
  es.addEventListener('devices', () => {
    if (!$('[data-panel="extension"]').hidden) loadDevices().catch(() => null);
    renderExtStatus().catch(() => null);
  });
}

// ---------------------------------------------------------------------------
await loadMe();
showTab();
connectStream();
if (new URLSearchParams(location.search).get('welcome')) toast('Welcome!', 'Start with the Extension tab to set up one-click checkout.', 'success', 10000);
