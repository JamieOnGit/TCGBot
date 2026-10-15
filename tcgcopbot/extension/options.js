// TCGCopBot extension settings: account connection and the card vault.
const $ = (id) => document.getElementById(id);
const ask = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)));

function say(id, text, ok) {
  $(id).textContent = text || '';
  $(id).className = `msg ${ok ? 'ok' : 'err'}`;
}

async function render() {
  $('app-name').textContent = TCB_CONFIG.appName;
  const s = await ask({ type: 'status' });
  $('foot').textContent = s ? `Version ${s.version} · account server ${s.server}` : '';
  const paired = !!(s && s.paired);
  $('acct-out').hidden = paired;
  $('acct-in').hidden = !paired;
  $('card-none-acct').hidden = paired;
  if (!paired) {
    $('card-saved').hidden = true;
    $('card-form').hidden = true;
    return;
  }
  $('who').textContent = s.user.email;
  $('plan').textContent = s.entitlement ? s.entitlement.label : 'Offline';
  const c = s.card || {};
  $('card-saved').hidden = !c.saved;
  $('card-form').hidden = false;
  $('card-form-title').innerHTML = c.saved ? '<b>Replace card</b>' : '<b>Save a card</b>';
  if (c.saved) {
    $('card-label').textContent = `${c.brand} •••• ${c.last4} · expires ${c.expMonth}/${String(c.expYear).slice(-2)}${c.hasCvc ? '' : ' · no CVV saved'}`;
    $('card-state').textContent = c.unlocked ? (c.until ? `Unlocked until ${new Date(c.until).toLocaleTimeString()}` : 'Unlocked') : 'Locked';
    $('unlock-form').hidden = !!c.unlocked;
    $('lock').hidden = !c.unlocked;
  }
}

$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await ask({ type: 'pair', code: $('pair-code').value });
  say('pair-msg', r && r.ok ? `Connected as ${r.user.email}` : (r && r.error) || "Couldn't connect", r && r.ok);
  render();
});

$('unpair').addEventListener('click', async () => {
  await ask({ type: 'unpair' });
  render();
});

$('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await ask({ type: 'vault', action: 'unlock', passphrase: $('unlock-pass').value, hours: Number($('unlock-hours').value) });
  $('unlock-pass').value = '';
  say('saved-msg', r && r.error ? r.error : 'Unlocked.', !(r && r.error));
  render();
});

$('lock').addEventListener('click', async () => {
  await ask({ type: 'vault', action: 'lock' });
  say('saved-msg', 'Locked.', true);
  render();
});

$('remove').addEventListener('click', async () => {
  if (!confirm('Remove your card from this browser?')) return;
  await ask({ type: 'vault', action: 'remove' });
  say('saved-msg', '', true);
  render();
});

$('card-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('c-pass').value !== $('c-pass2').value) return say('card-msg', "The passphrases don't match", false);
  const r = await ask({
    type: 'vault',
    action: 'save',
    card: { number: $('c-number').value, name: $('c-name').value, expiry: $('c-exp').value, cvc: $('c-cvc').value },
    passphrase: $('c-pass').value,
  });
  if (r && r.error) return say('card-msg', r.error, false);
  for (const id of ['c-number', 'c-name', 'c-exp', 'c-cvc', 'c-pass', 'c-pass2']) $(id).value = '';
  say('card-msg', 'Saved. Unlock it above when you want checkout to fill it in.', true);
  render();
});

render();
