// TCGCopBot — runs only on your TCGCopBot dashboard (the server in config.js).
// Lets the dashboard see that the extension is installed and which account
// it's connected to, and lets you connect it with one click.

(() => {
  'use strict';
  if (window.top !== window.self) return;
  document.documentElement.setAttribute('data-tcgcopbot-extension', chrome.runtime.getManifest().version);

  const ask = (msg) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res)); } catch { resolve(null); }
  });

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== 'tcgcopbot-app' || typeof d.type !== 'string') return;
    let reply = null;
    if (d.type === 'hello') reply = await ask({ type: 'appHello' });
    else if (d.type === 'pair' && typeof d.code === 'string') reply = await ask({ type: 'pair', code: d.code });
    else return;
    window.postMessage({ source: 'tcgcopbot-ext', type: d.type, id: d.id, reply }, location.origin);
  });
})();
