// TCGCopBot — runs the moment a store page starts loading, before the store's
// own code. Grabs the one-time "⚡ Buy" code from the address
// (…#tcb-go=<code>) before the site can tidy the address up.

(() => {
  'use strict';
  if (window.top !== window.self) return;
  const m = location.hash.match(/tcb-go=([A-Za-z0-9_-]{8,64})/);
  if (!m) return;
  try {
    sessionStorage.setItem('tcbGoCode', JSON.stringify({ code: m[1], at: Date.now() }));
  } catch {
    /* storage blocked — content.js falls back to the address */
  }
  const rest = location.hash.replace(/&?tcb-go=[A-Za-z0-9_-]+/, '').replace(/^#&?/, '#');
  history.replaceState(history.state, '', location.pathname + location.search + (rest === '#' ? '' : rest));
})();
