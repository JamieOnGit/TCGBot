#!/usr/bin/env node
// npm run demo — watch TCGBot work end to end against a FAKE store on your own
// computer (no real retailer is contacted and nothing is bought).
//
// What happens:
//   0s   OP-18 box is sold out; the 30th Anniversary UPC isn't listed yet
//   20s  the UPC gets listed as "Coming soon"        -> "Listing found" alert
//   35s  the OP-18 box restocks                       -> alert + checkout assist
//   55s  UPC pre-orders open                          -> alert + checkout assist
//   70s  the Shopify store restocks the OP-18 box     -> alert + add to cart
// Use --manual to skip the timeline and flip stock yourself in the store's control panel.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockStore, demoRetailerSpec, demoShopifySpec } from './mockstore.js';
import { registerRetailer } from '../src/retailers/index.js';
import { createApp } from '../src/app.js';
import { openInBrowser } from '../src/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(ROOT, 'demo-data');
const manual = process.argv.includes('--manual');

async function listen(fn, preferred) {
  try {
    return await fn(preferred);
  } catch (e) {
    if (e.code === 'EADDRINUSE') return fn(0);
    throw e;
  }
}

fs.mkdirSync(dataDir, { recursive: true });
fs.rmSync(path.join(dataDir, 'state.json'), { force: true });
fs.rmSync(path.join(dataDir, 'vault.json'), { force: true });

const store = await listen((port) => startMockStore({ port }), 8790);
registerRetailer(demoRetailerSpec(store.url));
registerRetailer(demoShopifySpec(store.url));
const app = await listen((port) => createApp({ dataDir, port, allowFastPolling: true, settingsOverride: { minHostGapSeconds: 0.5, ...(process.env.TCGBOT_HEADLESS ? { headless: true } : {}) } }), 8788);

app.store.setProfile({
  firstName: 'Ash', lastName: 'Ketchum', email: 'ash@example.com', phone: '0412 345 678',
  address1: '1 Pallet Street', address2: '', suburb: 'Sydney', state: 'NSW', postcode: '2000',
});
await app.vault.save('demo1234', { number: '4242 4242 4242 4242', name: 'Ash Ketchum', expMonth: '12', expYear: String(new Date().getFullYear() + 2), cvc: '123' });
app.store.addItem({ retailer: 'demo', name: 'Demo: OP-18 Booster Box (product link)', url: store.productUrl('311002'), mode: 'assist', pollSeconds: 3 });
app.store.addItem({ retailer: 'demo', name: 'Demo: 30th Anniversary UPC (not listed yet)', keywords: 'pokemon, ultra premium|upc, 30th|anniversary', exclude: 'sleeves, binder', mode: 'assist', pollSeconds: 3 });
app.store.addItem({ retailer: 'demoshop', name: 'Demo: OP-18 Booster Box (Shopify)', keywords: 'one piece, op-18, booster box', mode: 'cart', pollSeconds: 3 });
app.engine.start();

console.log(`
  TCGBot DEMO (fake store — nothing real is bought)
  Dashboard:            ${app.url}
  Fake store controls:  ${store.url}
  Demo card passphrase: demo1234
  ${manual ? 'Manual mode: use the fake store control panel to restock items.' : 'Timeline: listing at 20s, restock at 35s, pre-orders at 55s, Shopify restock at 70s.'}
  Press Ctrl+C to stop.
`);
if (!process.argv.includes('--no-open')) openInBrowser(app.url);

if (!manual) {
  const at = (s, fn, msg) => setTimeout(() => { console.log(`  [demo] ${msg}`); fn(); }, s * 1000);
  at(20, () => store.set('311001', { listed: true, status: 'coming_soon', jsonld: false }), 'The 30th Anniversary UPC has been listed (coming soon).');
  at(35, () => store.set('311002', { status: 'in_stock' }), 'OP-18 Booster Box restocked!');
  at(55, () => store.set('311001', { status: 'preorder', jsonld: true }), 'UPC pre-orders are open!');
  at(70, () => store.setShopify('one-piece-op-18-booster-box', true), 'Shopify store restocked the OP-18 box!');
}

const stop = async () => {
  await app.shutdown().catch(() => {});
  await store.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
