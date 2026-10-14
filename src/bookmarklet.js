// Builds the "⚡ TCGBot Checkout" bookmark button: the extension's core code
// plus your product list, packed into a javascript: link you drag to your
// bookmarks bar. Works in any browser, including Safari.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTENSION_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const CORE_FILE = path.join(EXTENSION_DIR, 'core.js');

/** Drop comment-only lines, the header comment and indentation to keep the link short. */
function compact(code) {
  return code
    .replace(/^\/\*[\s\S]*?\*\/\s*/, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .join('\n');
}

function safeJson(value) {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(value).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');
}

export function bookmarkletCode(products) {
  const list = (products || []).filter((p) => p.enabled !== false)
    .map((p) => ({ sku: p.sku, name: p.name, price: p.price, url: p.url }));
  const main = `
var products = ${safeJson(list)};
if (window.__tcgbotQuick) { window.__tcgbotQuick.go(); return; }
var store = TCGBotQuick.memoryStore();
var busy = false;
var panel;
function go() {
if (busy) return;
busy = true;
panel.startButton.disabled = true;
TCGBotQuick.run({ fresh: true, product: TCGBotQuick.productForPage(products), store: store, setStatus: panel.setStatus, followPages: false })
.catch(function () { panel.setStatus('Interrupted - please continue yourself.'); })
.then(function () { busy = false; panel.startButton.disabled = false; });
}
panel = TCGBotQuick.makePanel({ products: products, note: 'Bookmark button. If the store takes you to the bag page, click the bookmark again there.', onStart: go, onStop: function () { store.clear(); panel.setStatus('Stopped.'); } });
window.__tcgbotQuick = { go: go };
if (TCGBotQuick.productForPage(products) || TCGBotQuick.onBagPage()) go();
`;
  return `(function(){\n'use strict';\n${compact(fs.readFileSync(CORE_FILE, 'utf8'))}\n${main}})();`;
}

export function bookmarkletHref(products) {
  return `javascript:${encodeURIComponent(bookmarkletCode(products))}`;
}
