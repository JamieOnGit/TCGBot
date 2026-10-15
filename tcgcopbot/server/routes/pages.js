// Web pages: the public site, sign-in pages, the dashboard and admin.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { extensionZip } from '../extension.js';
import { sendFile } from '../http.js';

export const WEB = path.join(ROOT, 'web');

const PAGES = {
  '/': { file: 'index.html' },
  '/login': { file: 'auth.html' },
  '/signup': { file: 'auth.html' },
  '/forgot': { file: 'auth.html' },
  '/reset': { file: 'auth.html' },
  '/app': { file: 'app.html', auth: 'user' },
  '/admin': { file: 'admin.html', auth: 'admin' },
  '/terms': { file: 'terms.html' },
  '/privacy': { file: 'privacy.html' },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render(cfg, file, cache) {
  if (cache.has(file) && cfg.production) return cache.get(file);
  const vars = {
    APP_NAME: cfg.appName,
    PRICE: cfg.priceDisplay,
    TRIAL_DAYS: String(cfg.trialDays),
    SUPPORT_EMAIL: cfg.supportEmail || 'support@example.com',
    BASE_URL: cfg.baseUrl,
    YEAR: String(new Date().getFullYear()),
  };
  const html = fs.readFileSync(path.join(WEB, file), 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? esc(vars[k]) : m));
  cache.set(file, html);
  return html;
}

/** Returns true if it answered the request. */
export function servePage(ctx, req, res, url) {
  const { cfg } = ctx;
  const page = PAGES[url.pathname.replace(/\/+$/, '') || '/'];
  if (page) {
    if (page.auth && !req.user) {
      res.writeHead(302, { location: `/login?next=${encodeURIComponent(url.pathname)}` });
      res.end();
      return true;
    }
    if (page.auth === 'admin' && req.user.role !== 'admin') {
      res.writeHead(302, { location: '/app' });
      res.end();
      return true;
    }
    if ((url.pathname === '/login' || url.pathname === '/signup') && req.user) {
      res.writeHead(302, { location: '/app' });
      res.end();
      return true;
    }
    const html = render(cfg, page.file, ctx.pageCache);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : html);
    return true;
  }
  if (url.pathname === '/download/extension.zip') {
    if (!req.user) {
      res.writeHead(302, { location: '/login?next=/app%23extension' });
      res.end();
      return true;
    }
    const zip = extensionZip(cfg);
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length, 'content-disposition': `attachment; filename="${cfg.appName.toLowerCase()}-extension.zip"`, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : zip);
    return true;
  }
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return true;
  }
  if (url.pathname === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('User-agent: *\nDisallow: /app\nDisallow: /admin\nDisallow: /api/\n');
    return true;
  }
  if (/^\/(css|js|img)\//.test(url.pathname)) {
    return sendFile(req, res, WEB, url.pathname, { cache: cfg.production ? 'public, max-age=3600' : 'no-cache' });
  }
  if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg') return sendFile(req, res, WEB, '/img/favicon.svg', { cache: 'public, max-age=86400' });
  return false;
}
