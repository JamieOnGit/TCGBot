// Builds the Tampermonkey userscript served at /userscript/tcgbot-quick-checkout.user.js
// from your Quick Checkout list. Tampermonkey offers to install any *.user.js
// link, and the script keeps itself in sync with the dashboard while it runs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRetailers } from './retailers/index.js';

const BODY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'userscript', 'quick-checkout.body.js');
export const USERSCRIPT_PATH = '/userscript/tcgbot-quick-checkout.user.js';

/** Match patterns: every built-in store plus any other site in your list. */
export function matchPatterns(products) {
  const set = new Set();
  for (const r of listRetailers()) {
    if (r.group !== 'major') continue;
    try {
      const u = new URL(r.base);
      if (u.protocol === 'https:') set.add(`https://${u.hostname}/*`);
    } catch { /* ignore */ }
  }
  for (const p of products || []) {
    try {
      const u = new URL(p.url);
      set.add(`${u.protocol}//${u.hostname}/*`);
    } catch { /* ignore */ }
  }
  return [...set].sort();
}

/**
 * @param {{dashboardUrl: string, products: Array, rev?: number}} opts
 * @returns {string} the complete userscript
 */
export function buildUserscript({ dashboardUrl, products, rev = 1 }) {
  const body = fs.readFileSync(BODY_FILE, 'utf8');
  const config = {
    dashboard: dashboardUrl,
    products: (products || []).map((p) => ({ sku: p.sku, name: p.name, price: p.price, url: p.url, enabled: p.enabled !== false })),
  };
  // JSON is valid JS; escape "</" and line separators so it can't break out of the script.
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const json = JSON.stringify(config, null, 2).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');
  const dash = new URL(dashboardUrl);
  const header = [
    '// ==UserScript==',
    '// @name         TCGBot Quick Checkout',
    '// @namespace    tcgbot-quick-checkout',
    `// @version      2.${rev}`,
    '// @description  One click: Add to Bag → Bag → Checkout, for the products in your TCGBot dashboard. You finish checkout yourself.',
    ...matchPatterns(products).map((m) => `// @match        ${m}`),
    '// @grant        GM_xmlhttpRequest',
    `// @connect      ${dash.hostname}`,
    '// @connect      localhost',
    '// @run-at       document-idle',
    '// @noframes',
    `// @updateURL    ${dashboardUrl}${USERSCRIPT_PATH}`,
    `// @downloadURL  ${dashboardUrl}${USERSCRIPT_PATH}`,
    '// ==/UserScript==',
    '',
  ].join('\n');
  const marker = "/*@@TCGBOT_CONFIG@@*/ { dashboard: '', products: [] }";
  if (!body.includes(marker)) throw new Error('userscript template is missing its config placeholder');
  return header + body.replace(marker, () => json);
}
