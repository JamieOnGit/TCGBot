// TCGBot Quick Checkout — runs the moment a page starts loading, before the
// site's own code. Grabs the one-time "⚡ Buy" code from the address
// (…#tcgbot-go=<code>) before the site can tidy the address up, and tells the
// TCGBot dashboard that this browser has the extension.

(() => {
  'use strict';
  if (window.top !== window.self) return;
  const host = location.hostname;
  if (host === '127.0.0.1' || host === 'localhost') {
    document.documentElement.setAttribute('data-tcgbot-extension', chrome.runtime.getManifest().version);
  }
  const m = location.hash.match(/tcgbot-go=([A-Za-z0-9_-]{8,64})/);
  if (!m) return;
  try {
    sessionStorage.setItem('tcgbotGoCode', JSON.stringify({ code: m[1], at: Date.now() }));
  } catch {
    /* storage blocked — content.js falls back to the address */
  }
  const rest = location.hash.replace(/&?tcgbot-go=[A-Za-z0-9_-]+/, '').replace(/^#&?/, '#');
  history.replaceState(history.state, '', location.pathname + location.search + (rest === '#' ? '' : rest));
})();
