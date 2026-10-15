// TCGCopBot toolbar popup: connect your account, unlock your card, open products.
const $ = (id) => document.getElementById(id);
const ask = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)));
const dash = `${TCB_CONFIG.server}/app`;

function cardText(c) {
  if (!c || !c.saved) return 'Not saved in this browser';
  return `${c.brand} •••• ${c.last4} — ${c.unlocked ? 'unlocked' : 'locked'}`;
}

async function render() {
  $('app-name').textContent = TCB_CONFIG.appName;
  $('open-dash').href = `${dash}#extension`;
  $('open-dash2').href = dash;
  const s = await ask({ type: 'status' });
  $('foot').textContent = s ? `v${s.version} · ${new URL(s.server).host}` : '';
  if (!s || !s.paired) {
    $('signed-out').hidden = false;
    $('signed-in').hidden = true;
    if (s && s.disconnected) $('pair-msg').textContent = 'This browser was disconnected from your account.';
    return;
  }
  $('signed-out').hidden = true;
  $('signed-in').hidden = false;
  $('who').textContent = s.user.email;
  $('plan').textContent = s.online ? (s.entitlement ? s.entitlement.label : '') : 'Offline';
  $('plan').className = `pill ${s.entitlement && !s.entitlement.active ? 'warn' : ''}`;
  $('card-status').textContent = cardText(s.card);
  $('unlock-form').hidden = !(s.card && s.card.saved && !s.card.unlocked);
  $('lock').hidden = !(s.card && s.card.unlocked);
  const res = await ask({ type: 'products' });
  const list = $('products');
  list.textContent = '';
  const shown = ((res && res.products) || []).filter((p) => p.enabled !== false);
  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No products yet — add them in your dashboard.';
    list.appendChild(li);
  }
  for (const p of shown) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = p.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = p.name;
    a.title = `${p.name} · SKU ${p.sku}`;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `${typeof p.price === 'number' ? `$${p.price}` : ''}${p.quantity > 1 ? ` ×${p.quantity}` : ''}`;
    li.append(a, meta);
    list.appendChild(li);
  }
}

$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('pair-msg').textContent = 'Connecting…';
  const r = await ask({ type: 'pair', code: $('pair-code').value });
  $('pair-msg').textContent = r && r.ok ? `Connected as ${r.user.email}` : (r && r.error) || 'Couldn\'t connect';
  $('pair-msg').className = `msg ${r && r.ok ? 'ok' : 'err'}`;
  if (r && r.ok) render();
});

$('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await ask({ type: 'vault', action: 'unlock', passphrase: $('unlock-pass').value, hours: 0 });
  $('unlock-pass').value = '';
  $('card-msg').textContent = r && r.error ? r.error : 'Unlocked until you close the browser.';
  $('card-msg').className = `msg ${r && r.error ? 'err' : 'ok'}`;
  render();
});

$('lock').addEventListener('click', async () => {
  await ask({ type: 'vault', action: 'lock' });
  $('card-msg').textContent = 'Locked.';
  render();
});

render();
