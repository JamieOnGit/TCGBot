// TCGBot dashboard. Plain JS, no build step.

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
const money = (p) => (typeof p === 'number' ? `$${p.toFixed(2)}` : '');

const MODE_LABEL = { notify: 'Alert only', cart: 'Add to cart', assist: 'Checkout assist' };
const ASSIST_LABEL = { running: 'Working…', ready: 'READY — click Place order', in_cart: 'In cart', needs_you: 'Needs you', failed: 'Failed', purchased: 'Order placed', busy: 'Busy' };

let S = null;
let editingId = null;
const expanded = new Set();
let renderQueued = false;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-tcgbot': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function refreshState() {
  S = await api('GET', '/api/state');
  renderTop();
  renderWatchlist();
  renderVault();
  renderSetupBanner();
  renderQuick();
}

// ---------------------------------------------------------------------------
// Alerts: toast + sound + desktop notification
// ---------------------------------------------------------------------------
let audioCtx = null;
document.addEventListener('pointerdown', () => {
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no audio */ }
}, { capture: true });

function beep(kind) {
  if (localStorage.getItem('tcg-sound') === 'off' || !audioCtx) return;
  const pattern = kind === 'urgent'
    ? [[880, 0, 0.15], [1175, 0.18, 0.15], [1568, 0.36, 0.3], [880, 0.8, 0.15], [1175, 0.98, 0.15], [1568, 1.16, 0.3]]
    : [[660, 0, 0.18], [520, 0.22, 0.25]];
  const t0 = audioCtx.currentTime;
  for (const [f, start, dur] of pattern) {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'square';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.07, t0 + start);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + start);
    o.stop(t0 + start + dur + 0.05);
  }
}

function toast({ level = 'info', title, message = '', url = '' }, ttl = 9000) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  const link = safeUrl(url);
  el.innerHTML = `<b>${esc(title)}</b>${message ? `<div class="t-msg">${esc(message)}</div>` : ''}<div class="t-actions">${link ? `<a class="btn sm" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open page</a>` : ''}<button class="btn sm ghost">Dismiss</button></div>`;
  $('button', el).addEventListener('click', () => el.remove());
  $('#toasts').prepend(el);
  if (ttl) setTimeout(() => el.remove(), level === 'urgent' ? ttl * 4 : ttl);
}

let titleTimer = null;
function onAlert(a) {
  toast(a);
  if (a.level === 'urgent' || a.level === 'warning') beep(a.level === 'urgent' ? 'urgent' : 'warn');
  if ('Notification' in window && Notification.permission === 'granted' && (a.level === 'urgent' || a.level === 'warning' || document.hidden)) {
    try { new Notification(a.title, { body: a.message || '', tag: a.itemId || undefined, requireInteraction: a.level === 'urgent' }); } catch { /* ignore */ }
  }
  if (a.level === 'urgent') {
    clearInterval(titleTimer);
    let on = true;
    let n = 0;
    titleTimer = setInterval(() => {
      document.title = on ? `🔔 ${a.title}` : 'TCGBot';
      on = !on;
      if (++n > 20) { clearInterval(titleTimer); document.title = 'TCGBot'; }
    }, 700);
  }
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------
function renderTop() {
  const e = S.engine;
  const pill = $('#engine-pill');
  pill.classList.toggle('on', e.running);
  pill.textContent = e.running ? `Running · ${e.enabled} armed` : 'Stopped';
  const btn = $('#btn-start');
  btn.textContent = e.running ? '■ Stop monitoring' : '▶ Start monitoring';
  btn.classList.toggle('start', !e.running);
  btn.classList.toggle('stop', e.running);
  const v = S.vault;
  $('#vault-pill').textContent = !v.exists ? 'No saved card' : v.unlocked ? `Card ••${v.last4} unlocked` : 'Card locked';
  $('#count').textContent = S.items.length || '';
}

function renderSetupBanner() {
  const p = S.profile;
  const missing = !p.email || !p.address1 || !p.postcode;
  const banner = $('#setup-banner');
  if (missing && S.items.some((i) => i.mode !== 'notify')) {
    banner.innerHTML = 'Checkout assist needs your shipping details — add them under <b>Profile &amp; payment</b>.';
    banner.classList.remove('hidden');
  } else banner.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------
function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderWatchlist();
    renderTop();
  });
}

function lookingFor(item) {
  if (item.url) return 'Product link';
  const parts = [];
  if (item.sku) parts.push(`SKU ${item.sku}`);
  if (item.keywords) parts.push(`keywords: ${item.keywords}`);
  return parts.join(' · ');
}

function entryHtml(item) {
  const rt = item.rt || {};
  const status = rt.checking && rt.status === 'unknown' ? 'unknown' : rt.status;
  const label = rt.checking && rt.status === 'unknown' ? 'Checking…' : (S.statusLabels[status] || status);
  const hot = rt.orderable && !rt.overPrice;
  const url = safeUrl(rt.url || item.url || item.resolvedUrl);
  const title = rt.title || item.resolvedName || '';
  const titleHtml = title
    ? (url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>` : esc(title))
    : `<span class="muted">${item.url ? 'Waiting for first check' : `Searching for ${esc(lookingFor(item))}`}</span>`;
  const meta = [];
  if (typeof rt.price === 'number') meta.push(`${money(rt.price)}${rt.overPrice ? ' (over max)' : ''}`);
  meta.push(`checked <span class="ago" data-ts="${rt.lastChecked || ''}">${ago(rt.lastChecked)}</span>`);
  if (rt.via === 'browser') meta.push('browser');
  if (rt.ms) meta.push(`${rt.ms}ms`);
  if (rt.error) meta.push(`<span class="error">${esc(rt.error)}</span>`);
  if (!item.enabled) meta.push('paused');
  const assist = rt.assist
    ? `<div class="assist ${esc(rt.assist.state)}">${esc(ASSIST_LABEL[rt.assist.state] || rt.assist.state)}: ${esc(rt.assist.message || '')}</div>`
    : '';
  const extra = [item.quantity > 1 ? `×${item.quantity}` : '', item.maxPrice != null ? `max ${money(item.maxPrice)}` : ''].filter(Boolean).join(' · ');
  return `
  <div class="entry ${hot ? 'hot' : ''} ${item.enabled ? '' : 'paused'}" data-id="${esc(item.id)}">
    <div>
      <div class="retailer">${esc(item.retailerName)}</div>
      <div class="mode-tag">${esc(MODE_LABEL[item.mode])}${extra ? ` · ${esc(extra)}` : ''}</div>
    </div>
    <div><button class="chip-btn" data-act="why" title="Why? Show what the bot read"><span class="chip ${esc(status)} ${rt.checking ? 'checking' : ''}">${esc(label)}</span></button></div>
    <div class="info">
      <div class="title">${titleHtml}</div>
      <div class="meta">${meta.join(' · ')}</div>
      ${assist}
    </div>
    <div class="actions">
      <button class="btn sm go" data-act="go" title="${item.mode === 'cart' ? 'Add to cart now' : 'Add to cart and fill in checkout now'}">⚡ Go</button>
      <button class="btn sm" data-act="check" title="Check stock now">Check</button>
      <button class="btn sm" data-act="open" title="Open in the bot browser">Open</button>
      <button class="btn sm" data-act="toggle">${item.enabled ? 'Pause' : 'Resume'}</button>
      <button class="btn sm" data-act="edit">Edit</button>
      <button class="btn sm danger" data-act="delete" title="Delete">✕</button>
    </div>
    ${expanded.has(item.id) ? whyHtml(item) : ''}
  </div>`;
}

function whyHtml(item) {
  const rt = item.rt || {};
  const sig = (rt.signals || []).map((s) => `<li><b>${esc(s.source)}</b>: ${esc(S.statusLabels[s.status] || s.status || '')} <span class="muted">${esc(s.detail || '')}</span></li>`).join('');
  const hist = (rt.history || []).map((h) => `<li>${new Date(h.ts).toLocaleTimeString()} — ${esc(S.statusLabels[h.from] || h.from)} → ${esc(S.statusLabels[h.to] || h.to)}</li>`).join('');
  const matches = (rt.matches || []).map((m) => `<li><a href="${esc(safeUrl(m.url))}" target="_blank" rel="noopener noreferrer">${esc(m.name)}</a></li>`).join('');
  return `<div class="why">
    <div><b>Looking for:</b> ${esc(lookingFor(item))}${item.exclude ? ` · <b>excluding</b> ${esc(item.exclude)}` : ''}</div>
    ${rt.decidedBy ? `<div><b>Decided by:</b> ${esc(rt.decidedBy)}</div>` : ''}
    ${sig ? `<div><b>Signals read from the page:</b><ul>${sig}</ul></div>` : '<div class="muted">No signals yet.</div>'}
    ${matches ? `<div><b>Matching listings:</b><ul>${matches}</ul></div>` : ''}
    ${hist ? `<div><b>History:</b><ul>${hist}</ul></div>` : ''}
    <div class="row">
      ${!item.url ? '<button class="btn sm" data-act="research">Forget listing &amp; search again</button>' : ''}
      <button class="btn sm" data-act="reset" title="Allow alerts/assist to fire again for the current stock">Reset triggers</button>
    </div>
  </div>`;
}

function renderWatchlist() {
  const root = $('#watchlist');
  if (!S.items.length) {
    root.innerHTML = `<div class="card empty">
      <h2>Nothing on your watchlist yet</h2>
      <p class="muted">Start from a popular release, or add any product link, SKU or keywords.</p>
      <div class="presets">${S.presets.slice(0, 2).map((p) => `<button class="btn" data-preset="${esc(p.id)}">+ ${esc(p.name)}</button>`).join('')}
      <button class="btn primary" data-goto="add">+ Add item</button></div>
    </div>`;
    return;
  }
  const groups = new Map();
  for (const it of S.items) {
    const key = it.group || it.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  root.innerHTML = [...groups.values()].map((list) => {
    const first = list[0];
    const hot = list.some((i) => i.rt?.orderable && !i.rt?.overPrice);
    return `<div class="card group">
      <div class="group-head">
        <div><div class="group-title">${hot ? '🟢 ' : ''}${esc(first.name)}</div><div class="group-sub">${esc(lookingFor(first))}</div></div>
      </div>
      ${list.map(entryHtml).join('')}
    </div>`;
  }).join('');
}

setInterval(() => {
  for (const el of $$('.ago')) el.textContent = ago(Number(el.dataset.ts) || null);
}, 1000);

$('#watchlist').addEventListener('click', async (ev) => {
  const presetBtn = ev.target.closest('[data-preset]');
  if (presetBtn) { openAddForm(); applyPreset(presetBtn.dataset.preset); return; }
  if (ev.target.closest('[data-goto="add"]')) { openAddForm(); return; }
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]')?.dataset.id;
  const item = S.items.find((i) => i.id === id);
  if (!item) return;
  const act = btn.dataset.act;
  try {
    if (act === 'why') { expanded.has(id) ? expanded.delete(id) : expanded.add(id); renderWatchlist(); return; }
    if (act === 'edit') { openEditForm(item); return; }
    if (act === 'delete') {
      if (!confirm(`Delete "${item.name}" at ${item.retailerName}?`)) return;
      await api('DELETE', `/api/items/${id}`);
      await refreshState();
      return;
    }
    btn.disabled = true;
    if (act === 'check') {
      const r = await api('POST', `/api/items/${id}/check`);
      upsertItem(r.item);
    } else if (act === 'go') {
      if (!S.profile.email) toast({ level: 'warning', title: 'Add your shipping details first', message: 'Profile & payment tab' });
      await api('POST', `/api/items/${id}/go`);
      toast({ level: 'info', title: `Going: ${item.name}`, message: `Opening ${item.retailerName} in the bot browser…` }, 4000);
    } else if (act === 'open') {
      await api('POST', `/api/items/${id}/open`);
    } else if (act === 'toggle') {
      upsertItem(await api('PUT', `/api/items/${id}`, { enabled: !item.enabled }));
    } else if (act === 'reset' || act === 'research') {
      upsertItem(await api('POST', `/api/items/${id}/reset`, { forgetListing: act === 'research' }));
    }
  } catch (e) {
    toast({ level: 'error', title: 'Something went wrong', message: e.message });
  } finally {
    btn.disabled = false;
  }
});

function upsertItem(it) {
  const idx = S.items.findIndex((x) => x.id === it.id);
  if (idx === -1) S.items.push(it); else S.items[idx] = it;
  queueRender();
}

// ---------------------------------------------------------------------------
// Quick Checkout (extension + bookmark button)
// ---------------------------------------------------------------------------
let quickEditingId = null;

let bookmarkletRev = null;
async function refreshBookmarklet() {
  if (bookmarkletRev === S.quick.rev) return;
  bookmarkletRev = S.quick.rev;
  try {
    const b = await api('GET', '/api/quick/bookmarklet');
    $('#bookmarklet').setAttribute('href', b.href);
  } catch { bookmarkletRev = null; }
}

function renderQuick() {
  const q = S.quick;
  if (!q) return;
  $('#ext-path').textContent = q.extensionPath || '';
  refreshBookmarklet();
  $('#quick-count').textContent = `${q.products.filter((p) => p.enabled).length} active`;
  $('#quick-list').innerHTML = q.products.map((p, i) => `
    <li class="${p.enabled ? '' : 'off'}" data-qid="${esc(p.id)}">
      <span class="rank">${i + 1}</span>
      <div>
        <div class="q-name">${esc(p.name)}${typeof p.price === 'number' ? ` — ${money(p.price)}` : ''}</div>
        <div class="q-meta">${esc(p.store || '')} · SKU ${esc(p.sku)}${p.enabled ? '' : ' · hidden from the panel'}</div>
      </div>
      <div class="actions">
        <a class="btn sm go" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener" title="Open in this browser (the panel appears on the page)">Open ↗</a>
        <button class="btn sm" data-q="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn sm" data-q="down" title="Move down" ${i === q.products.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn sm" data-q="toggle">${p.enabled ? 'Hide' : 'Show'}</button>
        <button class="btn sm" data-q="edit">Edit</button>
        <button class="btn sm danger" data-q="delete" title="Delete">✕</button>
      </div>
    </li>`).join('') || '<li class="muted">No products yet — add one below.</li>';
  renderQuickLog();
}

function renderQuickLog() {
  const lines = (S.log || []).filter((e) => /Quick Checkout/.test(e.message)).slice(-30).reverse();
  $('#quick-log').innerHTML = lines.map(logLine).join('') || '<li class="muted">Nothing yet. Events from the panel (added to bag, reached checkout) show up here.</li>';
}

function resetQuickForm() {
  quickEditingId = null;
  $('#quick-form').reset();
  $('#quick-form-title').textContent = 'Add a product';
  $('#q-save').textContent = 'Add product';
  $('#q-cancel').classList.add('hidden');
  $('#q-error').textContent = '';
}

$('#quick-list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-q]');
  if (!btn) return;
  const id = btn.closest('[data-qid]').dataset.qid;
  const p = S.quick.products.find((x) => x.id === id);
  if (!p) return;
  const act = btn.dataset.q;
  try {
    if (act === 'edit') {
      quickEditingId = id;
      $('#q-url').value = p.url;
      $('#q-name').value = p.name;
      $('#q-sku').value = p.sku;
      $('#q-price').value = p.price ?? '';
      $('#quick-form-title').textContent = `Edit: ${p.name}`;
      $('#q-save').textContent = 'Save changes';
      $('#q-cancel').classList.remove('hidden');
      $('#q-url').focus();
      return;
    }
    if (act === 'delete') {
      if (!confirm(`Remove "${p.name}" from Quick Checkout?`)) return;
      await api('DELETE', `/api/quick/products/${id}`);
    } else if (act === 'toggle') {
      await api('PUT', `/api/quick/products/${id}`, { enabled: !p.enabled });
    } else if (act === 'up' || act === 'down') {
      const ids = S.quick.products.map((x) => x.id);
      const i = ids.indexOf(id);
      const j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      S.quick = await api('POST', '/api/quick/reorder', { ids });
      renderQuick();
      return;
    }
    S.quick = await api('GET', '/api/quick');
    renderQuick();
  } catch (e) {
    toast({ level: 'error', title: 'Something went wrong', message: e.message });
  }
});

$('#quick-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = {
    url: $('#q-url').value.trim(),
    name: $('#q-name').value.trim(),
    sku: $('#q-sku').value.trim(),
    price: $('#q-price').value === '' ? null : Number($('#q-price').value),
  };
  try {
    if (quickEditingId) await api('PUT', `/api/quick/products/${quickEditingId}`, body);
    else await api('POST', '/api/quick/products', body);
    resetQuickForm();
    S.quick = await api('GET', '/api/quick');
    renderQuick();
    toast({ level: 'success', title: 'Saved', message: 'Open product pages pick up the change automatically.' }, 3000);
  } catch (e) {
    $('#q-error').textContent = e.message;
  }
});
$('#q-cancel').addEventListener('click', resetQuickForm);
$('#bookmarklet').addEventListener('click', (ev) => {
  ev.preventDefault();
  toast({ level: 'info', title: 'Drag it, don\'t click it', message: 'Drag the ⚡ TCGBot Checkout button onto your bookmarks bar, then use it on a product page.' }, 6000);
});
$('#copy-ext-path').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(S.quick.extensionPath);
    toast({ level: 'success', title: 'Folder path copied' }, 2500);
  } catch {
    toast({ level: 'info', title: 'Select the path and copy it', message: S.quick.extensionPath });
  }
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function showTab(name) {
  for (const b of $$('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const t of $$('.tab')) t.classList.toggle('active', t.id === `tab-${name}`);
  if (name === 'activity') renderLog();
}
for (const b of $$('.tabs button')) {
  b.addEventListener('click', () => {
    if (b.dataset.tab === 'add' && editingId) resetForm();
    showTab(b.dataset.tab);
  });
}

// ---------------------------------------------------------------------------
// Add / edit form
// ---------------------------------------------------------------------------
function renderRetailerChips() {
  const all = [...S.retailers.filter((r) => r.group === 'major'), { id: 'shopify', name: 'Other Shopify store' }, { id: 'generic', name: 'Other website (link only)' }];
  $('#f-retailers').innerHTML = all.map((r) => `<label class="chip-check" title="${esc(r.notes || '')}"><input type="checkbox" value="${esc(r.id)}"> ${esc(r.name)}</label>`).join('');
}

function checkedRetailers() {
  return $$('#f-retailers input:checked').map((i) => i.value);
}

function setRetailers(ids) {
  for (const i of $$('#f-retailers input')) i.checked = ids.includes(i.value);
  onRetailersChanged();
}

function onRetailersChanged() {
  const ids = checkedRetailers();
  $('#f-domain-row').classList.toggle('hidden', !ids.includes('shopify'));
  const notes = ids.map((id) => S.retailers.find((r) => r.id === id)).filter((r) => r && r.notes).map((r) => `${r.name}: ${r.notes}`);
  $('#f-retailer-hint').textContent = editingId ? 'Editing one store. To add more stores, create a new item.' : (notes.length === 1 ? notes[0] : 'Pick one or more stores. A separate watch is created for each.');
}

$('#f-retailers').addEventListener('change', (ev) => {
  if (editingId && ev.target.checked) for (const i of $$('#f-retailers input')) if (i !== ev.target) i.checked = false;
  onRetailersChanged();
});

function renderPresets() {
  const sel = $('#f-preset');
  sel.innerHTML = '<option value="">— Choose a preset (optional) —</option>' + S.presets.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
}

function applyPreset(id) {
  const p = S.presets.find((x) => x.id === id);
  if (!p) return;
  $('#f-preset').value = id;
  $('#f-name').value = p.name.replace(/ \((edit|e\.g\.)[^)]*\)/, '');
  $('#f-keywords').value = p.keywords;
  $('#f-exclude').value = p.exclude || '';
  $('#f-searchQuery').value = p.searchQuery || '';
  $('#f-url').value = '';
  $('#f-sku').value = '';
  if (!checkedRetailers().length) setRetailers(S.retailers.filter((r) => r.group === 'major' && r.id !== 'amazon').map((r) => r.id));
  if (/SET NAME|OP-XX|ST-XX/.test(p.keywords)) {
    toast({ level: 'warning', title: 'Edit the keywords', message: 'Replace SET NAME / OP-XX / ST-XX with the actual set.' });
    $('#f-keywords').focus();
  }
}
$('#f-preset').addEventListener('change', (e) => applyPreset(e.target.value));

let detectTimer = null;
$('#f-url').addEventListener('input', () => {
  clearTimeout(detectTimer);
  detectTimer = setTimeout(async () => {
    const url = $('#f-url').value.trim();
    if (!/^https?:\/\//i.test(url)) return;
    try {
      const d = await api('GET', `/api/detect?url=${encodeURIComponent(url)}`);
      if (!d.retailer) return;
      setRetailers([d.retailer]);
      if (d.domain) $('#f-domain').value = d.domain;
      if (d.sku && !$('#f-sku').value) $('#f-sku').placeholder = `detected: ${d.sku}`;
      $('#f-retailer-hint').textContent = `Detected ${d.name}${d.sku ? ` (product code ${d.sku})` : ''}${d.guess ? ' — looks like a Shopify store' : ''}.`;
    } catch { /* ignore */ }
  }, 350);
});

function formBody() {
  const val = (id) => $(id).value.trim();
  return {
    name: val('#f-name'),
    retailers: checkedRetailers(),
    domain: val('#f-domain'),
    url: val('#f-url'),
    sku: val('#f-sku'),
    keywords: val('#f-keywords'),
    exclude: val('#f-exclude'),
    searchQuery: val('#f-searchQuery'),
    maxPrice: val('#f-maxPrice') === '' ? null : Number(val('#f-maxPrice')),
    quantity: Number(val('#f-quantity') || 1),
    mode: $('input[name="mode"]:checked')?.value || 'notify',
    method: $('#f-method').value,
    pollSeconds: val('#f-pollSeconds') === '' ? null : Number(val('#f-pollSeconds')),
  };
}

function resetForm() {
  editingId = null;
  $('#item-form').reset();
  $('#f-quantity').value = 1;
  $('#form-title').textContent = 'Add something to watch';
  $('#btn-save-item').textContent = 'Add to watchlist';
  $('#btn-cancel-edit').classList.add('hidden');
  $('#form-error').textContent = '';
  $('#probe-out').classList.add('hidden');
  $('#search-out').classList.add('hidden');
  $('#f-sku').placeholder = 'e.g. 321456 or B0XXXXXXXX';
  setRetailers([]);
}

function openAddForm() {
  resetForm();
  showTab('add');
}

function openEditForm(item) {
  resetForm();
  editingId = item.id;
  $('#form-title').textContent = `Edit: ${item.name}`;
  $('#btn-save-item').textContent = 'Save changes';
  $('#btn-cancel-edit').classList.remove('hidden');
  $('#f-name').value = item.name;
  setRetailers([item.retailer]);
  $('#f-domain').value = item.domain || '';
  $('#f-url').value = item.url || '';
  $('#f-sku').value = item.sku || '';
  $('#f-keywords').value = item.keywords || '';
  $('#f-exclude').value = item.exclude || '';
  $('#f-searchQuery').value = item.searchQuery || '';
  $('#f-maxPrice').value = item.maxPrice ?? '';
  $('#f-quantity').value = item.quantity || 1;
  $('#f-method').value = item.method || 'auto';
  $('#f-pollSeconds').value = item.pollSeconds ?? '';
  for (const r of $$('input[name="mode"]')) r.checked = r.value === item.mode;
  onRetailersChanged();
  showTab('add');
}
$('#btn-cancel-edit').addEventListener('click', () => { resetForm(); showTab('watch'); });

$('#item-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = formBody();
  const err = $('#form-error');
  err.textContent = '';
  if (!body.retailers.length) { err.textContent = 'Pick at least one store.'; return; }
  if (body.url && body.retailers.length > 1) { err.textContent = 'A product link belongs to one store — select only that store, or clear the link and use keywords for several stores.'; return; }
  if (!body.url && !body.sku && !body.keywords) { err.textContent = 'Enter a product link, a SKU, or keywords.'; return; }
  if (body.retailers.includes('generic') && !body.url) { err.textContent = '"Other website" needs a product link.'; return; }
  const btn = $('#btn-save-item');
  btn.disabled = true;
  try {
    if (editingId) {
      await api('PUT', `/api/items/${editingId}`, { ...body, retailer: body.retailers[0], retailers: undefined });
      toast({ level: 'success', title: 'Saved' }, 3000);
    } else {
      const r = await api('POST', '/api/items', body);
      toast({ level: 'success', title: `Added ${r.items.length} watch${r.items.length > 1 ? 'es' : ''}`, message: S.engine.running ? 'Checking now…' : 'Press "Start monitoring" to arm it.' }, 5000);
    }
    resetForm();
    await refreshState();
    showTab('watch');
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

function signalsList(signals) {
  return (signals || []).map((s) => `<li><b>${esc(s.source)}</b>: ${esc(S.statusLabels[s.status] || s.status || '')} <span class="muted">${esc(s.detail || '')}</span></li>`).join('');
}

$('#btn-probe').addEventListener('click', async () => {
  const out = $('#probe-out');
  const url = $('#f-url').value.trim();
  if (!url) { out.classList.remove('hidden'); out.textContent = 'Paste a product link first.'; return; }
  out.classList.remove('hidden');
  out.textContent = 'Checking…';
  try {
    const ids = checkedRetailers();
    const r = await api('POST', '/api/probe', { url, sku: $('#f-sku').value.trim(), retailer: ids.length === 1 ? ids[0] : undefined, domain: $('#f-domain').value.trim(), method: $('#f-method').value });
    out.innerHTML = `<div><span class="chip ${esc(r.status)}">${esc(r.statusLabel || r.status)}</span> <b>${esc(r.title || '(no title)')}</b> ${money(r.price)} <span class="muted">· ${esc(r.retailer)} · ${r.ms}ms${r.via === 'browser' ? ' · via browser' : ''}</span></div>
      ${r.decidedBy ? `<div class="muted">Decided by: ${esc(r.decidedBy)}</div>` : ''}
      <ul>${signalsList(r.signals)}</ul>
      ${r.status === 'unknown' ? '<div class="muted">The bot could not find stock information on this page. Try the Browser monitor method (Advanced).</div>' : ''}`;
    if (!$('#f-name').value && r.title) $('#f-name').value = r.title;
  } catch (e) {
    out.innerHTML = `<span class="error">${esc(e.message)}</span>`;
  }
});

$('#btn-search-test').addEventListener('click', async () => {
  const out = $('#search-out');
  const body = formBody();
  const ids = body.retailers.filter((r) => r !== 'generic');
  out.classList.remove('hidden');
  if (!ids.length) { out.textContent = 'Pick at least one store (other than "Other website").'; return; }
  if (!body.keywords && !body.searchQuery) { out.textContent = 'Enter keywords first.'; return; }
  out.innerHTML = '';
  for (const id of ids) {
    const block = document.createElement('div');
    const rname = S.retailers.find((r) => r.id === id)?.name || id;
    block.innerHTML = `<b>${esc(rname)}</b>: searching…`;
    out.append(block);
    try {
      const r = await api('POST', '/api/search-test', { retailer: id, domain: body.domain, keywords: body.keywords, exclude: body.exclude, searchQuery: body.searchQuery, method: body.method });
      block.innerHTML = `<b>${esc(r.retailer)}</b> — searched "${esc(r.query)}": ${r.total} result(s), <b>${r.matches.length} match${r.matches.length === 1 ? '' : 'es'}</b> <span class="muted">(${r.ms}ms)</span>
        <ul>${r.matches.map((m) => `<li><a href="${esc(safeUrl(m.url))}" target="_blank" rel="noopener noreferrer">${esc(m.name)}</a></li>`).join('') || '<li class="muted">No listing matches yet — the bot will keep searching for it.</li>'}</ul>`;
    } catch (e) {
      block.innerHTML = `<b>${esc(rname)}</b>: <span class="error">${esc(e.message)}</span>`;
    }
  }
});

// ---------------------------------------------------------------------------
// Profile & vault
// ---------------------------------------------------------------------------
function renderProfile() {
  const f = $('#profile-form');
  for (const [k, v] of Object.entries(S.profile)) if (f.elements[k]) f.elements[k].value = v || '';
}
$('#profile-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = Object.fromEntries([...new FormData(f).entries()]);
  try {
    S.profile = await api('PUT', '/api/profile', body);
    $('#profile-msg').textContent = 'Saved ✓';
    renderSetupBanner();
  } catch (e) {
    $('#profile-msg').innerHTML = `<span class="error">${esc(e.message)}</span>`;
  }
});

function renderVault() {
  const v = S.vault;
  const body = $('#vault-body');
  if (body.dataset.state === JSON.stringify(v)) return;
  body.dataset.state = JSON.stringify(v);
  const year = new Date().getFullYear();
  if (!v.exists) {
    body.innerHTML = `<form id="vault-save">
      <div class="row">
        <label class="grow">Card number<input name="number" inputmode="numeric" autocomplete="off" placeholder="•••• •••• •••• ••••"></label>
        <label class="grow">Name on card<input name="name" autocomplete="off"></label>
      </div>
      <div class="row">
        <label>Expiry month<select name="expMonth">${Array.from({ length: 12 }, (_, i) => `<option>${String(i + 1).padStart(2, '0')}</option>`).join('')}</select></label>
        <label>Expiry year<select name="expYear">${Array.from({ length: 12 }, (_, i) => `<option>${year + i}</option>`).join('')}</select></label>
        <label>Security code (optional)<input name="cvc" inputmode="numeric" maxlength="4" autocomplete="off"></label>
      </div>
      <div class="row">
        <label class="grow">Passphrase (to encrypt it)<input name="passphrase" type="password" autocomplete="new-password"></label>
        <label class="grow">Repeat passphrase<input name="passphrase2" type="password" autocomplete="new-password"></label>
      </div>
      <div class="form-actions"><button class="btn primary" type="submit">Encrypt &amp; save card</button><span class="vault-msg"></span></div>
    </form>`;
    $('#vault-save').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = Object.fromEntries(new FormData(ev.target).entries());
      const msg = $('.vault-msg', ev.target);
      if (fd.passphrase !== fd.passphrase2) { msg.innerHTML = '<span class="error">Passphrases don\'t match</span>'; return; }
      try {
        S.vault = await api('POST', '/api/vault', { passphrase: fd.passphrase, card: { number: fd.number, name: fd.name, expMonth: fd.expMonth, expYear: fd.expYear, cvc: fd.cvc } });
        renderVault();
        renderTop();
        toast({ level: 'success', title: 'Card encrypted and saved' }, 3000);
      } catch (e) {
        msg.innerHTML = `<span class="error">${esc(e.message)}</span>`;
      }
    });
  } else if (!v.unlocked) {
    body.innerHTML = `<form id="vault-unlock" class="vault-status">
      <span>🔒 A card is saved (encrypted). Unlock it for this session so checkout assist can type it in.</span>
      <input name="passphrase" type="password" placeholder="Passphrase" style="max-width:240px" autocomplete="current-password">
      <button class="btn primary" type="submit">Unlock</button>
      <button class="btn ghost danger" type="button" id="vault-delete">Delete saved card</button>
      <span class="vault-msg"></span>
    </form>`;
    $('#vault-unlock').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        S.vault = await api('POST', '/api/vault/unlock', { passphrase: ev.target.elements.passphrase.value });
        renderVault();
        renderTop();
      } catch (e) {
        $('.vault-msg', ev.target).innerHTML = `<span class="error">${esc(e.message)}</span>`;
      }
    });
    $('#vault-delete').addEventListener('click', deleteVault);
  } else {
    body.innerHTML = `<div class="vault-status">
      <span>🔓 Card ending <b>${esc(v.last4)}</b> (exp ${esc(v.expiry)}) is unlocked for this session${v.hasCvc ? '' : ' — no security code saved, you\'ll type it at checkout'}.</span>
      <button class="btn" id="vault-lock">Lock</button>
      <button class="btn ghost danger" id="vault-delete">Delete saved card</button>
    </div>`;
    $('#vault-lock').addEventListener('click', async () => { S.vault = await api('POST', '/api/vault/lock'); renderVault(); renderTop(); });
    $('#vault-delete').addEventListener('click', deleteVault);
  }
}
async function deleteVault() {
  if (!confirm('Delete the saved card?')) return;
  S.vault = await api('DELETE', '/api/vault');
  renderVault();
  renderTop();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function renderSettings() {
  const f = $('#settings-form');
  for (const [k, v] of Object.entries(S.settings)) {
    const el = f.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
  }
  $('#sound-toggle').checked = localStorage.getItem('tcg-sound') !== 'off';
  updateNotifButton();
}
$('#settings-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = {};
  for (const el of f.elements) {
    if (!el.name) continue;
    body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  try {
    S.settings = await api('PUT', '/api/settings', body);
    $('#settings-msg').textContent = 'Saved ✓ (browser changes apply next time it opens)';
  } catch (e) {
    $('#settings-msg').innerHTML = `<span class="error">${esc(e.message)}</span>`;
  }
});
$('#sound-toggle').addEventListener('change', (e) => localStorage.setItem('tcg-sound', e.target.checked ? 'on' : 'off'));
$('#btn-test-alert').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/test-alert');
    if (S.settings.discordWebhook) toast({ level: r.discord.ok ? 'success' : 'error', title: r.discord.ok ? 'Discord test sent' : 'Discord test failed', message: r.discord.reason || (r.discord.status ? `HTTP ${r.discord.status}` : '') }, 5000);
  } catch (e) {
    toast({ level: 'error', title: 'Test failed', message: e.message });
  }
});
function updateNotifButton() {
  const b = $('#btn-notif');
  if (!('Notification' in window)) { b.disabled = true; b.textContent = 'Desktop notifications unsupported'; return; }
  b.textContent = Notification.permission === 'granted' ? 'Desktop notifications on ✓' : 'Enable desktop notifications';
}
$('#btn-notif').addEventListener('click', async () => {
  if ('Notification' in window) await Notification.requestPermission();
  updateNotifButton();
});

function renderLogins() {
  $('#logins').innerHTML = S.retailers.filter((r) => r.group === 'major').map((r) => `<button class="btn" data-login="${esc(r.id)}">Open ${esc(r.name)}</button>`).join('');
}
$('#logins').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-login]');
  if (!b) return;
  b.disabled = true;
  try {
    await api('POST', '/api/browser/open', { retailer: b.dataset.login });
  } catch (e) {
    toast({ level: 'error', title: 'Could not open the browser', message: e.message });
  } finally {
    b.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------
function logLine(e) {
  return `<li class="${esc(e.level)}"><time>${new Date(e.ts).toLocaleTimeString()}</time><span>${esc(e.message)}</span></li>`;
}
function renderLog() {
  const important = $('#log-important').checked;
  const list = S.log.filter((e) => !important || e.level !== 'info').slice(-300).reverse();
  $('#log').innerHTML = list.map(logLine).join('') || '<li class="muted">Nothing yet.</li>';
}
$('#log-important').addEventListener('change', renderLog);

// ---------------------------------------------------------------------------
// Top bar actions
// ---------------------------------------------------------------------------
$('#btn-start').addEventListener('click', async () => {
  const btn = $('#btn-start');
  btn.disabled = true;
  try {
    S.engine = await api('POST', S.engine.running ? '/api/stop' : '/api/start');
    renderTop();
    if (S.engine.running && !S.items.some((i) => i.enabled)) toast({ level: 'warning', title: 'No items to watch', message: 'Add an item first.' });
  } catch (e) {
    toast({ level: 'error', title: 'Error', message: e.message });
  } finally {
    btn.disabled = false;
  }
});
$('#btn-browser').addEventListener('click', async () => {
  try {
    await api('POST', '/api/browser/open', {});
  } catch (e) {
    toast({ level: 'error', title: 'Could not open the browser', message: e.message });
  }
});

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------
function connect() {
  const es = new EventSource('/api/events');
  let wasDown = false;
  es.addEventListener('hello', () => {
    if (wasDown) { refreshState(); toast({ level: 'success', title: 'Reconnected to TCGBot' }, 3000); }
    wasDown = false;
  });
  es.addEventListener('item', (e) => upsertItem(JSON.parse(e.data)));
  es.addEventListener('engine', (e) => { S.engine = JSON.parse(e.data); renderTop(); });
  es.addEventListener('log', (e) => {
    const entry = JSON.parse(e.data);
    S.log.push(entry);
    if (S.log.length > 500) S.log.shift();
    if ($('#tab-activity').classList.contains('active')) renderLog();
    if (/Quick Checkout/.test(entry.message)) renderQuickLog();
  });
  es.addEventListener('alert', (e) => onAlert(JSON.parse(e.data)));
  es.addEventListener('refresh', () => refreshState());
  es.onerror = () => {
    if (!wasDown) {
      wasDown = true;
      $('#engine-pill').textContent = 'Disconnected — is TCGBot still running?';
      $('#engine-pill').classList.remove('on');
    }
  };
}

(async function init() {
  try {
    S = await api('GET', '/api/state');
  } catch (e) {
    document.body.innerHTML = `<div class="card" style="margin:40px auto;max-width:600px"><h2>Can't reach TCGBot</h2><p>${esc(e.message)}</p><p>Start it with <code>npm start</code>.</p></div>`;
    return;
  }
  renderRetailerChips();
  renderPresets();
  renderProfile();
  renderSettings();
  renderLogins();
  renderTop();
  renderWatchlist();
  renderVault();
  renderSetupBanner();
  renderQuick();
  connect();
})();
