// Builds the TCGCopBot browser extension for this server: fills in the
// server address and the sites the extension may run on. Used by the
// dashboard's "Download extension" button and by `npm run build:extension`
// (for the Chrome Web Store).

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { PAYMENT_HOSTS, STORES } from './stores.js';
import { makeZip } from './zip.js';

export const EXTENSION_SRC = path.join(ROOT, 'extension');
const TEMPLATE = JSON.parse(fs.readFileSync(path.join(EXTENSION_SRC, 'manifest.json'), 'utf8'));
export const EXTENSION_VERSION = TEMPLATE.version;

const isLocal = (u) => ['localhost', '127.0.0.1'].includes(new URL(u).hostname);

export function extensionManifest(cfg) {
  const app = new URL(cfg.baseUrl);
  // Match patterns can't include a port; without one they match every port.
  const appPattern = `${app.protocol}//${app.hostname}/*`;
  const stores = STORES.map((s) => `https://${s.host}/*`);
  // A server on your own computer also lets the extension work on the test store there.
  const dev = isLocal(cfg.baseUrl) ? ['http://127.0.0.1/*', 'http://localhost/*'] : [];
  const m = structuredClone(TEMPLATE);
  m.name = cfg.appName === 'TCGCopBot' ? m.name : `${cfg.appName} Quick Checkout`;
  m.host_permissions = [appPattern];
  m.content_scripts = [
    { matches: [appPattern], js: ['bridge.js'], run_at: 'document_start' },
    { matches: [...stores, ...dev], js: ['capture.js'], run_at: 'document_start' },
    { matches: [...stores, ...dev], js: ['core.js', 'fill.js', 'content.js'], run_at: 'document_idle' },
    { matches: [...PAYMENT_HOSTS, ...stores, ...dev], js: ['fill.js', 'frame.js'], run_at: 'document_idle', all_frames: true },
  ];
  // The app's own pages aren't stores: keep the store scripts off them.
  if (dev.length) for (const cs of m.content_scripts.slice(1)) cs.exclude_matches = [`${app.protocol}//${app.hostname}:${app.port || (app.protocol === 'https:' ? 443 : 80)}/*`];
  return m;
}

export function extensionConfigJs(cfg) {
  return `// Written by the ${cfg.appName} server — the account server this extension talks to.\nvar TCB_CONFIG = ${JSON.stringify({ server: cfg.baseUrl, appName: cfg.appName })};\n`;
}

/** All files of the extension built for this server: [{name, data}]. */
export function extensionFiles(cfg) {
  const files = [];
  for (const name of fs.readdirSync(EXTENSION_SRC).sort()) {
    const full = path.join(EXTENSION_SRC, name);
    if (!fs.statSync(full).isFile() || name === 'manifest.json' || name === 'config.js') continue;
    files.push({ name, data: fs.readFileSync(full) });
  }
  files.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(extensionManifest(cfg), null, 2)) });
  files.push({ name: 'config.js', data: Buffer.from(extensionConfigJs(cfg)) });
  return files;
}

export function writeExtension(cfg, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of extensionFiles(cfg)) fs.writeFileSync(path.join(outDir, f.name), f.data);
  return outDir;
}

let cached = null;
export function extensionZip(cfg) {
  if (!cached || cached.base !== cfg.baseUrl) {
    const folder = `${cfg.appName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-extension`;
    cached = { base: cfg.baseUrl, zip: makeZip(extensionFiles(cfg).map((f) => ({ name: `${folder}/${f.name}`, data: f.data }))) };
  }
  return cached.zip;
}
