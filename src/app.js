// Wires every component together. Used by the CLI, the demo and the tests.

import path from 'node:path';
import { Bus } from './log.js';
import { Store } from './store.js';
import { Vault } from './vault.js';
import { Notifier } from './notify.js';
import { BrowserManager } from './browser.js';
import { Fetcher } from './http.js';
import { Assist } from './assist.js';
import { Engine } from './engine.js';
import { createServer } from './server.js';
import { listRetailers } from './retailers/index.js';

/**
 * @param {{dataDir: string, port?: number, echo?: boolean, allowFastPolling?: boolean,
 *          settingsOverride?: object, launcher?: object, assistTimeouts?: object, fetchImpl?: Function}} opts
 */
export async function createApp({
  dataDir, port = 8787, echo = true, allowFastPolling = false, settingsOverride = null, launcher = null, assistTimeouts = {}, fetchImpl,
}) {
  const bus = new Bus({ echo });
  const store = new Store(dataDir, { knownRetailers: () => listRetailers().map((r) => r.id), allowFastPolling }).load();
  const getSettings = () => (settingsOverride ? { ...store.settings, ...settingsOverride } : store.settings);
  const vault = new Vault(path.join(dataDir, 'vault.json'));
  const notifier = new Notifier({ bus, getSettings, ...(fetchImpl ? { fetchImpl } : {}) });
  const browser = new BrowserManager({ dataDir, getSettings, bus, launcher });
  const fetcher = new Fetcher({ getSettings, browser, log: (lvl, msg) => bus.log(lvl, msg), ...(fetchImpl ? { fetchImpl } : {}) });
  const assist = new Assist({ browser, store, vault, notifier, bus, dataDir, timeouts: assistTimeouts });
  const engine = new Engine({ store, bus, notifier, fetcher, assist });
  const app = { dataDir, bus, store, vault, notifier, browser, fetcher, assist, engine };
  const web = await createServer({ app, port });
  app.web = web;
  app.url = web.url;
  app.shutdown = async () => {
    engine.stop();
    await web.close();
    await browser.close();
    store.saveNow();
  };
  return app;
}
