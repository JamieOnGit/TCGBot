// Build the browser extension for your server, e.g. to publish it on the
// Chrome Web Store:
//
//   BASE_URL=https://tcgcopbot.example.com npm run build:extension
//
// Writes dist/extension/ (load it with "Load unpacked" to try it) and
// dist/tcgcopbot-extension.zip (upload this to the Chrome Web Store).

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, loadEnvFile } from '../server/config.js';
import { extensionFiles, writeExtension } from '../server/extension.js';
import { makeZip } from '../server/zip.js';

loadEnvFile();
const cfg = loadConfig();
const out = path.join(ROOT, 'dist');
const dir = writeExtension(cfg, path.join(out, 'extension'));
const zipPath = path.join(out, `${cfg.appName.toLowerCase()}-extension.zip`);
fs.writeFileSync(zipPath, makeZip(extensionFiles(cfg)));
console.log(`Extension for ${cfg.baseUrl}:\n  folder: ${dir}\n  zip:    ${zipPath}`);
if (/localhost|127\.0\.0\.1/.test(cfg.baseUrl)) console.log('Note: BASE_URL is your own computer. Set BASE_URL to your live address before publishing.');
