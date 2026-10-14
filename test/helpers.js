// Shared test setup: a fake store + a TCGBot instance pointed at it.
// (Lives in test/ but defines no tests itself.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockStore, demoRetailerSpec, demoShopifySpec } from '../devtools/mockstore.js';
import { registerRetailer } from '../src/retailers/index.js';
import { createApp } from '../src/app.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 15000, interval = 50, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

export const PROFILE = {
  firstName: 'Ash', lastName: 'Ketchum', email: 'ash@example.com', phone: '0412345678',
  address1: '1 Pallet Street', address2: 'Unit 2', suburb: 'Sydney', state: 'NSW', postcode: '2000',
};
export const CARD = { number: '4242424242424242', name: 'Ash Ketchum', expMonth: '07', expYear: '2027', cvc: '123' };

export async function setup({ storeOpts = {}, settingsOverride = {}, assistTimeouts = {} } = {}) {
  const store = await startMockStore(storeOpts);
  registerRetailer(demoRetailerSpec(store.url));
  registerRetailer(demoShopifySpec(store.url));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgbot-test-'));
  const app = await createApp({
    dataDir,
    port: 0,
    echo: !!process.env.TCGBOT_TEST_ECHO,
    allowFastPolling: true,
    settingsOverride: { minHostGapSeconds: 0, jitterPercent: 0, headless: true, ...settingsOverride },
    assistTimeouts: { total: 60000, human: 20000, ...assistTimeouts },
  });
  const alerts = [];
  app.bus.on('alert', (a) => alerts.push(a));
  const teardown = async () => {
    await app.shutdown();
    await store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, app, alerts, dataDir, teardown };
}
