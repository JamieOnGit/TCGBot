// Settings come from environment variables (see .env.example). Nothing secret
// is hard-coded: in production the server refuses to start without its keys.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Load KEY=value lines from a .env file without overriding real env vars. */
export function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function parseKey(value, name) {
  if (!value) return null;
  const buf = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (buf.length !== 32) throw new Error(`${name} must be 32 bytes (64 hex characters or base64). Generate one with: openssl rand -hex 32`);
  return buf;
}

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

/**
 * Build the config. `overrides` is used by tests; everything else comes from env.
 */
export function loadConfig(overrides = {}, env = process.env) {
  const production = (overrides.env ?? env.NODE_ENV) === 'production';
  const port = overrides.port ?? int(env.PORT, 8080);
  const baseUrl = String(overrides.baseUrl ?? env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  let dataKey = overrides.dataKey ?? parseKey(env.DATA_ENCRYPTION_KEY, 'DATA_ENCRYPTION_KEY');
  if (!dataKey) {
    if (production) throw new Error('DATA_ENCRYPTION_KEY is required in production. Generate one with: openssl rand -hex 32');
    // Development only: a fixed throwaway key so data survives restarts on your machine.
    dataKey = crypto.createHash('sha256').update('tcgcopbot-development-key-do-not-use-in-production').digest();
  }
  const cfg = {
    production,
    port,
    host: overrides.host ?? env.HOST ?? '0.0.0.0',
    baseUrl,
    // No BASE_URL given: use whatever address the server ends up listening on.
    baseUrlAuto: !(overrides.baseUrl ?? env.BASE_URL),
    extraOrigins: String(overrides.extraOrigins ?? env.EXTRA_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
    secureCookies: baseUrl.startsWith('https://'),
    trustProxy: overrides.trustProxy ?? env.TRUST_PROXY === '1',
    databasePath: overrides.databasePath ?? env.DATABASE_PATH ?? path.join(ROOT, 'data', 'tcgcopbot.db'),
    dataKey,
    appName: overrides.appName ?? env.APP_NAME ?? 'TCGCopBot',
    supportEmail: overrides.supportEmail ?? env.SUPPORT_EMAIL ?? '',
    // Once the extension is published: its Chrome Web Store page.
    chromeStoreUrl: overrides.chromeStoreUrl ?? env.CHROME_STORE_URL ?? '',
    adminEmails: String(overrides.adminEmails ?? env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    trialDays: overrides.trialDays ?? int(env.TRIAL_DAYS, 7),
    priceDisplay: overrides.priceDisplay ?? env.PRICE_DISPLAY ?? 'A$19 / month',
    signupsOpen: (overrides.signupsOpen ?? env.SIGNUPS_OPEN ?? '1') !== '0' && overrides.signupsOpen !== false,
    stripe: {
      secretKey: overrides.stripeSecretKey ?? env.STRIPE_SECRET_KEY ?? '',
      webhookSecret: overrides.stripeWebhookSecret ?? env.STRIPE_WEBHOOK_SECRET ?? '',
      priceId: overrides.stripePriceId ?? env.STRIPE_PRICE_ID ?? '',
      apiBase: (overrides.stripeApiBase ?? env.STRIPE_API_BASE ?? 'https://api.stripe.com').replace(/\/+$/, ''),
    },
    email: {
      resendApiKey: overrides.resendApiKey ?? env.RESEND_API_KEY ?? '',
      from: overrides.emailFrom ?? env.EMAIL_FROM ?? '',
      apiBase: (overrides.resendApiBase ?? env.RESEND_API_BASE ?? 'https://api.resend.com').replace(/\/+$/, ''),
      // Tests (and local dev without an email provider) capture messages here.
      outbox: overrides.outbox ?? null,
    },
    limits: {
      products: overrides.maxProducts ?? int(env.MAX_PRODUCTS, 50),
      watchItems: overrides.maxWatchItems ?? int(env.MAX_WATCH_ITEMS, 25),
      devices: overrides.maxDevices ?? int(env.MAX_DEVICES, 5),
      // New accounts per hour from one IP address.
      signupsPerHour: overrides.signupsPerHour ?? int(env.SIGNUPS_PER_HOUR, 10),
    },
    monitor: {
      enabled: overrides.monitorEnabled ?? env.MONITOR_ENABLED !== '0',
      // How often one product page is checked, however many people watch it.
      urlIntervalSeconds: overrides.urlIntervalSeconds ?? int(env.MONITOR_URL_INTERVAL, 60),
      // Gap between any two requests to the same store.
      hostGapSeconds: overrides.hostGapSeconds ?? int(env.MONITOR_HOST_GAP, 5),
      tickMs: overrides.monitorTickMs ?? 1000,
      timeoutMs: overrides.monitorTimeoutMs ?? 15000,
      userAgent: overrides.userAgent ?? `TCGCopBot/1.0 (restock alerts; +${baseUrl})`,
      // Only for testing with a store on your own computer: lets the monitor fetch private addresses.
      allowPrivateHosts: overrides.allowPrivateHosts ?? env.MONITOR_ALLOW_PRIVATE === '1',
    },
    sessionDays: overrides.sessionDays ?? int(env.SESSION_DAYS, 30),
    log: overrides.log ?? ((...a) => console.log(new Date().toISOString(), ...a)),
  };
  return cfg;
}

export function billingConfigured(cfg) {
  return !!(cfg.stripe.secretKey && cfg.stripe.priceId);
}
