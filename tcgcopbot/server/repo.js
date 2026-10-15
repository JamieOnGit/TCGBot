// All reads and writes of user data. Every function that touches someone's
// data takes their userId and puts it in the WHERE clause — there is no way to
// fetch a product, address, watch item, device or event without saying whose
// it is. Admin functions only see account fields, never personal details.

import { decryptJSON, encryptJSON, humanCode, newId, newUserKey, normalizeHumanCode, randomToken, sha256, unwrapUserKey } from './crypto.js';

const DAY = 24 * 60 * 60 * 1000;
const GO_CODE_TTL = 2 * 60 * 1000;
const PAIR_CODE_TTL = 10 * 60 * 1000;
const RESET_TTL = 60 * 60 * 1000;
const EVENTS_KEPT = 500;

const USER_FIELDS = ['email', 'name', 'password_hash', 'role', 'plan', 'trial_ends_at', 'current_period_end', 'cancel_at_period_end', 'stripe_customer_id', 'stripe_subscription_id', 'disabled', 'last_login_at'];

const toProduct = (r) => r && ({ id: r.id, name: r.name, sku: r.sku, url: r.url, price: r.price, quantity: r.quantity, enabled: !!r.enabled, position: r.position });
const toDevice = (r) => r && ({ id: r.id, name: r.name, version: r.version, createdAt: r.created_at, lastSeenAt: r.last_seen_at });

export class Repo {
  constructor(db, cfg, now = () => Date.now()) {
    this.db = db;
    this.cfg = cfg;
    this.now = now;
    this.keys = new Map();
  }

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------
  createUser({ email, name = '', passwordHash, role = 'user', plan = 'trial', trialEndsAt = null }) {
    const id = newId('usr');
    const t = this.now();
    this.db.run(`INSERT INTO users (id, email, name, password_hash, data_key, role, plan, trial_ends_at, created_at, updated_at)
      VALUES (:id, :email, :name, :hash, :key, :role, :plan, :trial, :t, :t)`,
    { id, email, name, hash: passwordHash, key: newUserKey(this.cfg.dataKey, id), role, plan, trial: trialEndsAt, t });
    return this.userById(id);
  }

  userById(id) {
    return this.db.get('SELECT * FROM users WHERE id = :id', { id: String(id || '') });
  }

  userByEmail(email) {
    return this.db.get('SELECT * FROM users WHERE email = :email', { email: String(email || '') });
  }

  userByStripeCustomer(customerId) {
    return customerId ? this.db.get('SELECT * FROM users WHERE stripe_customer_id = :c', { c: customerId }) : null;
  }

  updateUser(id, fields) {
    const keys = Object.keys(fields).filter((k) => USER_FIELDS.includes(k));
    if (!keys.length) return this.userById(id);
    const params = { id, t: this.now() };
    keys.forEach((k) => { params[k] = typeof fields[k] === 'boolean' ? Number(fields[k]) : fields[k]; });
    this.db.run(`UPDATE users SET ${keys.map((k) => `${k} = :${k}`).join(', ')}, updated_at = :t WHERE id = :id`, params);
    return this.userById(id);
  }

  deleteUser(id) {
    this.keys.delete(id);
    // ON DELETE CASCADE removes sessions, details, products, watchlist, devices, codes and events.
    return this.db.run('DELETE FROM users WHERE id = :id', { id }).changes > 0;
  }

  countUsers() {
    return this.db.get('SELECT COUNT(*) AS n FROM users').n;
  }

  /** Admin list: account and billing fields only — never addresses or other personal details. */
  listUsers({ q = '', limit = 50, offset = 0 } = {}) {
    const rows = this.db.all(`SELECT u.id, u.email, u.name, u.role, u.plan, u.trial_ends_at, u.current_period_end, u.cancel_at_period_end,
        u.stripe_customer_id, u.disabled, u.created_at, u.last_login_at,
        (SELECT COUNT(*) FROM products p WHERE p.user_id = u.id) AS products,
        (SELECT COUNT(*) FROM watch_items w WHERE w.user_id = u.id) AS watching,
        (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS devices
      FROM users u WHERE (:q = '' OR u.email LIKE :like OR u.name LIKE :like)
      ORDER BY u.created_at DESC LIMIT :limit OFFSET :offset`,
    { q, like: `%${q}%`, limit, offset });
    const total = this.db.get("SELECT COUNT(*) AS n FROM users u WHERE (:q = '' OR u.email LIKE :like OR u.name LIKE :like)", { q, like: `%${q}%` }).n;
    return { users: rows, total };
  }

  stats() {
    const plans = Object.fromEntries(this.db.all('SELECT plan, COUNT(*) AS n FROM users GROUP BY plan').map((r) => [r.plan, r.n]));
    return {
      users: this.countUsers(),
      plans,
      signups7d: this.db.get('SELECT COUNT(*) AS n FROM users WHERE created_at > :t', { t: this.now() - 7 * DAY }).n,
      devices: this.db.get('SELECT COUNT(*) AS n FROM devices').n,
      watchedPages: this.db.get('SELECT COUNT(DISTINCT url) AS n FROM watch_items WHERE enabled = 1').n,
    };
  }

  // ---------------------------------------------------------------------------
  // This user's own encryption key, and their encrypted details
  // ---------------------------------------------------------------------------
  userKey(userId) {
    let key = this.keys.get(userId);
    if (!key) {
      const row = this.db.get('SELECT data_key FROM users WHERE id = :id', { id: userId });
      if (!row) throw new Error('No such user');
      key = unwrapUserKey(this.cfg.dataKey, row.data_key, userId);
      this.keys.set(userId, key);
    }
    return key;
  }

  getData(userId, kind, fallback = null) {
    const row = this.db.get('SELECT enc FROM user_data WHERE user_id = :u AND kind = :k', { u: userId, k: kind });
    if (!row) return fallback;
    return decryptJSON(this.userKey(userId), row.enc, `${userId}:${kind}`);
  }

  setData(userId, kind, value) {
    const enc = encryptJSON(this.userKey(userId), value, `${userId}:${kind}`);
    this.db.run(`INSERT INTO user_data (user_id, kind, enc, updated_at) VALUES (:u, :k, :enc, :t)
      ON CONFLICT (user_id, kind) DO UPDATE SET enc = excluded.enc, updated_at = excluded.updated_at`,
    { u: userId, k: kind, enc, t: this.now() });
    return value;
  }

  // ---------------------------------------------------------------------------
  // Sessions (only the token's hash is stored)
  // ---------------------------------------------------------------------------
  createSession(userId, userAgent = '') {
    const token = randomToken();
    const t = this.now();
    this.db.run(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent)
      VALUES (:h, :u, :t, :exp, :t, :ua)`, { h: sha256(token), u: userId, t, exp: t + this.cfg.sessionDays * DAY, ua: String(userAgent).slice(0, 200) });
    return token;
  }

  /** The user behind a session cookie, renewing the session as it's used. */
  sessionUser(token) {
    if (!token) return null;
    const h = sha256(token);
    const row = this.db.get('SELECT * FROM sessions WHERE token_hash = :h', { h });
    if (!row) return null;
    const t = this.now();
    if (row.expires_at < t) {
      this.db.run('DELETE FROM sessions WHERE token_hash = :h', { h });
      return null;
    }
    if (t - row.last_seen_at > 60 * 60 * 1000) {
      this.db.run('UPDATE sessions SET last_seen_at = :t, expires_at = :exp WHERE token_hash = :h', { h, t, exp: t + this.cfg.sessionDays * DAY });
    }
    const user = this.userById(row.user_id);
    if (!user || user.disabled) return null;
    return { user, sessionHash: h };
  }

  deleteSession(token) {
    if (token) this.db.run('DELETE FROM sessions WHERE token_hash = :h', { h: sha256(token) });
  }

  /** Sign out everywhere (optionally keeping the current session). */
  deleteSessions(userId, exceptHash = '') {
    this.db.run('DELETE FROM sessions WHERE user_id = :u AND token_hash != :x', { u: userId, x: exceptHash });
  }

  // ---------------------------------------------------------------------------
  // Quick Checkout products
  // ---------------------------------------------------------------------------
  listProducts(userId) {
    return this.db.all('SELECT * FROM products WHERE user_id = :u ORDER BY position, created_at', { u: userId }).map(toProduct);
  }

  getProduct(userId, id) {
    return toProduct(this.db.get('SELECT * FROM products WHERE user_id = :u AND id = :id', { u: userId, id: String(id || '') }));
  }

  countProducts(userId) {
    return this.db.get('SELECT COUNT(*) AS n FROM products WHERE user_id = :u', { u: userId }).n;
  }

  addProduct(userId, p) {
    const id = newId('prd');
    const t = this.now();
    const pos = this.db.get('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM products WHERE user_id = :u', { u: userId }).n;
    this.db.run(`INSERT INTO products (id, user_id, position, name, sku, url, price, quantity, enabled, created_at, updated_at)
      VALUES (:id, :u, :pos, :name, :sku, :url, :price, :qty, :en, :t, :t)`,
    { id, u: userId, pos, name: p.name, sku: p.sku, url: p.url, price: p.price, qty: p.quantity, en: p.enabled ? 1 : 0, t });
    return this.getProduct(userId, id);
  }

  updateProduct(userId, id, p) {
    const r = this.db.run(`UPDATE products SET name = :name, sku = :sku, url = :url, price = :price, quantity = :qty, enabled = :en, updated_at = :t
      WHERE user_id = :u AND id = :id`,
    { id: String(id || ''), u: userId, name: p.name, sku: p.sku, url: p.url, price: p.price, qty: p.quantity, en: p.enabled ? 1 : 0, t: this.now() });
    return r.changes ? this.getProduct(userId, id) : null;
  }

  deleteProduct(userId, id) {
    return this.db.run('DELETE FROM products WHERE user_id = :u AND id = :id', { u: userId, id: String(id || '') }).changes > 0;
  }

  /** Put the given ids first, in that order; the rest keep their order after them. */
  reorderProducts(userId, ids) {
    const current = this.listProducts(userId);
    const known = new Set(current.map((p) => p.id));
    const first = [...new Set(ids.map(String))].filter((id) => known.has(id));
    const order = [...first, ...current.map((p) => p.id).filter((id) => !first.includes(id))];
    this.db.tx(() => order.forEach((id, i) => this.db.run('UPDATE products SET position = :i WHERE user_id = :u AND id = :id', { i, u: userId, id })));
    return this.listProducts(userId);
  }

  // ---------------------------------------------------------------------------
  // Watchlist
  // ---------------------------------------------------------------------------
  listWatch(userId) {
    return this.db.all(`SELECT w.*, c.status AS page_status, c.title AS page_title, c.price AS page_price, c.checked_at, c.error AS page_error
      FROM watch_items w LEFT JOIN page_checks c ON c.url = w.url WHERE w.user_id = :u ORDER BY w.created_at`, { u: userId }).map((r) => this.toWatch(r));
  }

  getWatch(userId, id) {
    const r = this.db.get(`SELECT w.*, c.status AS page_status, c.title AS page_title, c.price AS page_price, c.checked_at, c.error AS page_error
      FROM watch_items w LEFT JOIN page_checks c ON c.url = w.url WHERE w.user_id = :u AND w.id = :id`, { u: userId, id: String(id || '') });
    return r ? this.toWatch(r) : null;
  }

  toWatch(r) {
    return {
      id: r.id, name: r.name, url: r.url, maxPrice: r.max_price, enabled: !!r.enabled, lastAlertAt: r.last_alert_at,
      status: r.page_status || 'pending', title: r.page_title || '', price: r.page_price, checkedAt: r.checked_at || null, error: r.page_error || '',
    };
  }

  countWatch(userId) {
    return this.db.get('SELECT COUNT(*) AS n FROM watch_items WHERE user_id = :u', { u: userId }).n;
  }

  addWatch(userId, w) {
    const id = newId('wch');
    const t = this.now();
    this.db.run(`INSERT INTO watch_items (id, user_id, name, url, max_price, enabled, created_at, updated_at)
      VALUES (:id, :u, :name, :url, :max, :en, :t, :t)`, { id, u: userId, name: w.name, url: w.url, max: w.maxPrice, en: w.enabled ? 1 : 0, t });
    this.ensurePage(w.url);
    return this.getWatch(userId, id);
  }

  updateWatch(userId, id, w) {
    const r = this.db.run(`UPDATE watch_items SET name = :name, url = :url, max_price = :max, enabled = :en, updated_at = :t WHERE user_id = :u AND id = :id`,
      { id: String(id || ''), u: userId, name: w.name, url: w.url, max: w.maxPrice, en: w.enabled ? 1 : 0, t: this.now() });
    if (!r.changes) return null;
    this.ensurePage(w.url);
    return this.getWatch(userId, id);
  }

  deleteWatch(userId, id) {
    return this.db.run('DELETE FROM watch_items WHERE user_id = :u AND id = :id', { u: userId, id: String(id || '') }).changes > 0;
  }

  ensurePage(url) {
    this.db.run('INSERT OR IGNORE INTO page_checks (url, host, next_check_at) VALUES (:url, :host, 0)', { url, host: new URL(url).host });
  }

  // ---------------------------------------------------------------------------
  // ⚡ Buy codes — single use, 2 minutes, and only for the account that made them
  // ---------------------------------------------------------------------------
  createGoCode(userId, product, quantity) {
    const code = randomToken(18);
    this.db.run(`INSERT INTO go_codes (code_hash, user_id, product_id, sku, name, quantity, host, expires_at)
      VALUES (:h, :u, :pid, :sku, :name, :qty, :host, :exp)`,
    { h: sha256(code), u: userId, pid: product.id, sku: product.sku, name: product.name, qty: quantity, host: new URL(product.url).host, exp: this.now() + GO_CODE_TTL });
    this.db.run('DELETE FROM go_codes WHERE expires_at < :t', { t: this.now() });
    return code;
  }

  claimGoCode(userId, code) {
    const h = sha256(code);
    return this.db.tx(() => {
      const row = this.db.get('SELECT * FROM go_codes WHERE code_hash = :h AND user_id = :u', { h, u: userId });
      if (!row) return null;
      this.db.run('DELETE FROM go_codes WHERE code_hash = :h', { h });
      return row.expires_at >= this.now() ? row : null;
    });
  }

  // ---------------------------------------------------------------------------
  // Browser extension: pairing codes and connected devices
  // ---------------------------------------------------------------------------
  createPairCode(userId) {
    const code = humanCode();
    this.db.run('DELETE FROM pair_codes WHERE user_id = :u OR expires_at < :t', { u: userId, t: this.now() });
    this.db.run('INSERT INTO pair_codes (code_hash, user_id, expires_at) VALUES (:h, :u, :exp)', { h: sha256(code), u: userId, exp: this.now() + PAIR_CODE_TTL });
    return { code, expiresAt: this.now() + PAIR_CODE_TTL };
  }

  redeemPairCode(code) {
    const h = sha256(normalizeHumanCode(code));
    return this.db.tx(() => {
      const row = this.db.get('SELECT * FROM pair_codes WHERE code_hash = :h', { h });
      if (!row) return null;
      this.db.run('DELETE FROM pair_codes WHERE code_hash = :h', { h });
      return row.expires_at >= this.now() ? row.user_id : null;
    });
  }

  addDevice(userId, name, version = '') {
    const token = randomToken();
    const id = newId('dev');
    const t = this.now();
    this.db.tx(() => {
      // Keep the newest few; connecting another browser retires the oldest.
      const existing = this.db.all('SELECT id FROM devices WHERE user_id = :u ORDER BY last_seen_at DESC', { u: userId });
      existing.slice(Math.max(0, this.cfg.limits.devices - 1)).forEach((d) => this.db.run('DELETE FROM devices WHERE id = :id', { id: d.id }));
      this.db.run(`INSERT INTO devices (id, user_id, token_hash, name, version, created_at, last_seen_at) VALUES (:id, :u, :h, :name, :v, :t, :t)`,
        { id, u: userId, h: sha256(token), name: String(name || 'Browser').slice(0, 60), v: String(version).slice(0, 20), t });
    });
    return { token, device: toDevice(this.db.get('SELECT * FROM devices WHERE id = :id', { id })) };
  }

  deviceByToken(token) {
    if (!token) return null;
    const row = this.db.get('SELECT * FROM devices WHERE token_hash = :h', { h: sha256(token) });
    if (!row) return null;
    const user = this.userById(row.user_id);
    if (!user || user.disabled) return null;
    if (this.now() - row.last_seen_at > 5 * 60 * 1000) this.db.run('UPDATE devices SET last_seen_at = :t WHERE id = :id', { t: this.now(), id: row.id });
    return { device: toDevice(row), user };
  }

  setDeviceVersion(userId, id, version) {
    this.db.run('UPDATE devices SET version = :v WHERE user_id = :u AND id = :id', { v: String(version || '').slice(0, 20), u: userId, id });
  }

  listDevices(userId) {
    return this.db.all('SELECT * FROM devices WHERE user_id = :u ORDER BY created_at DESC', { u: userId }).map(toDevice);
  }

  deleteDevice(userId, id) {
    return this.db.run('DELETE FROM devices WHERE user_id = :u AND id = :id', { u: userId, id: String(id || '') }).changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Activity
  // ---------------------------------------------------------------------------
  addEvent(userId, { type, level = 'info', message, name = null, sku = null, url = null }) {
    const t = this.now();
    const r = this.db.run(`INSERT INTO events (user_id, type, level, message, name, sku, url, created_at) VALUES (:u, :type, :level, :msg, :name, :sku, :url, :t)`,
      { u: userId, type, level, msg: String(message).slice(0, 500), name, sku, url: url ? String(url).slice(0, 1000) : null, t });
    const id = Number(r.lastInsertRowid);
    if (id % 50 === 0) {
      this.db.run(`DELETE FROM events WHERE user_id = :u AND id <= (SELECT id FROM events WHERE user_id = :u ORDER BY id DESC LIMIT 1 OFFSET :keep)`, { u: userId, keep: EVENTS_KEPT });
    }
    return { id, type, level, message, name, sku, url, createdAt: t };
  }

  listEvents(userId, { limit = 100, beforeId = null } = {}) {
    return this.db.all(`SELECT * FROM events WHERE user_id = :u AND (:b IS NULL OR id < :b) ORDER BY id DESC LIMIT :limit`,
      { u: userId, b: beforeId, limit: Math.min(500, limit) })
      .map((r) => ({ id: r.id, type: r.type, level: r.level, message: r.message, name: r.name, sku: r.sku, url: r.url, createdAt: r.created_at }));
  }

  // ---------------------------------------------------------------------------
  // Password reset tokens
  // ---------------------------------------------------------------------------
  createReset(userId) {
    const token = randomToken();
    this.db.run('DELETE FROM password_resets WHERE user_id = :u OR expires_at < :t', { u: userId, t: this.now() });
    this.db.run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (:h, :u, :exp)', { h: sha256(token), u: userId, exp: this.now() + RESET_TTL });
    return token;
  }

  useReset(token) {
    const h = sha256(token || '');
    return this.db.tx(() => {
      const row = this.db.get('SELECT * FROM password_resets WHERE token_hash = :h', { h });
      if (!row) return null;
      this.db.run('DELETE FROM password_resets WHERE token_hash = :h', { h });
      return row.expires_at >= this.now() ? row.user_id : null;
    });
  }

  // ---------------------------------------------------------------------------
  // Billing / admin bookkeeping
  // ---------------------------------------------------------------------------
  markStripeEvent(id, type) {
    return this.db.run('INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (:id, :type, :t)', { id, type, t: this.now() }).changes > 0;
  }

  audit(actorId, targetUserId, action, detail = '') {
    this.db.run('INSERT INTO audit_log (actor_id, target_user_id, action, detail, created_at) VALUES (:a, :t2, :action, :d, :t)',
      { a: actorId, t2: targetUserId, action, d: String(detail).slice(0, 500), t: this.now() });
  }

  listAudit(limit = 100) {
    return this.db.all('SELECT a.*, u.email AS actor_email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT :l', { l: limit });
  }

  /** Everything stored about one user (for "Download my data"). */
  exportUser(userId) {
    const u = this.userById(userId);
    return {
      account: { email: u.email, name: u.name, plan: u.plan, createdAt: new Date(u.created_at).toISOString(), trialEndsAt: u.trial_ends_at ? new Date(u.trial_ends_at).toISOString() : null },
      deliveryDetails: this.getData(userId, 'profile', null),
      alertSettings: this.getData(userId, 'alerts', null),
      quickCheckout: this.listProducts(userId),
      watchlist: this.listWatch(userId).map(({ id, name, url, maxPrice, enabled }) => ({ id, name, url, maxPrice, enabled })),
      devices: this.listDevices(userId),
      activity: this.listEvents(userId, { limit: 500 }),
      note: 'Card details are never stored by TCGCopBot — they stay in your browser extension.',
    };
  }
}
