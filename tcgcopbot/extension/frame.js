// TCGCopBot — runs inside payment frames (card number / expiry / CVV boxes
// hosted by the store's payment provider). Fills the card only while a
// checkout you started is running in this tab, on that store (checked by the
// background worker), and only if your card is unlocked.

(async () => {
  'use strict';
  if (window.top === window.self) return;
  const ask = (msg) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res)); } catch { resolve(null); }
  });
  const looksLikeCardFrame = () => [...document.querySelectorAll('input')].some((el) => /^card/.test(TCBFill.classifyField(el) || ''));
  // Payment frames often draw their boxes a moment after loading.
  for (let i = 0; i < 20 && !looksLikeCardFrame(); i++) await new Promise((r) => setTimeout(r, 500));
  if (!looksLikeCardFrame()) return;
  const res = await ask({ type: 'fillData', part: 'card' });
  if (!res || !res.card) return;
  const values = TCBFill.fieldValues(null, res.card);
  const end = Date.now() + 4 * 60 * 1000;
  const done = new Set();
  while (Date.now() < end) {
    const r = TCBFill.fillFields(document, values, { onlyCard: true });
    r.filled.forEach((k) => done.add(k));
    if (done.size && done.size >= r.cardFieldsSeen) break;
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
})();
