// Start the TCGCopBot server:  npm start
import { createApp } from './app.js';
import { loadConfig, loadEnvFile } from './config.js';

loadEnvFile();
const cfg = loadConfig();
const app = await createApp({ cfg });
const url = await app.listen(cfg.port, cfg.host);
cfg.log(`${cfg.appName} is running on ${url} (public address: ${cfg.baseUrl})`);
if (!app.billing.configured) cfg.log('Payments are not set up (STRIPE_SECRET_KEY / STRIPE_PRICE_ID). Everyone stays on the free trial until you add them.');
if (!app.ctx.mailer.configured) cfg.log('Email is not set up (RESEND_API_KEY / EMAIL_FROM). Password reset links will only appear in this log.');
if (!cfg.adminEmails.length) cfg.log('No ADMIN_EMAILS set — nobody can open /admin. Set ADMIN_EMAILS=you@example.com and log in again.');

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    cfg.log('Shutting down…');
    await app.close();
    process.exit(0);
  });
}
