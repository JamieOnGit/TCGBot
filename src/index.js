#!/usr/bin/env node
// TCGBot — start the dashboard:  npm start   (or: node src/index.js --port 8787)

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { port: Number(process.env.TCGBOT_PORT) || 8787, dataDir: process.env.TCGBOT_DATA || path.join(ROOT, 'data'), open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--data') out.dataDir = path.resolve(argv[++i]);
    else if (a === '--no-open') out.open = false;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node src/index.js [--port 8787] [--data ./data] [--no-open]');
      process.exit(0);
    }
  }
  return out;
}

export function openInBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* the URL is printed anyway */
  }
}

async function main() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) {
    console.error(`TCGBot needs Node.js 20 or newer (you have ${process.versions.node}). Download it from https://nodejs.org`);
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  let app;
  try {
    app = await createApp({ dataDir: args.dataDir, port: args.port });
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`Port ${args.port} is already in use — is TCGBot already running? Open http://127.0.0.1:${args.port} or start with --port 8788`);
      process.exit(1);
    }
    throw e;
  }
  console.log('');
  console.log('  TCGBot is running.');
  console.log(`  Dashboard: ${app.url}`);
  console.log(`  Data folder: ${args.dataDir}`);
  console.log('  Press Ctrl+C to stop.');
  console.log('');
  if (args.open) openInBrowser(app.url);
  if (app.store.settings.autoStart) app.engine.start();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nShutting down…');
    await app.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
