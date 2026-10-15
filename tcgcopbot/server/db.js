// SQLite database (built into Node 22+: node:sqlite). One file, easy to back up.
//
// Every table that holds someone's data has a user_id column that references
// users(id) ON DELETE CASCADE, and every query in repo.js filters by it, so
// one account can never see or change another's data. Deleting an account
// removes everything that belongs to it.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  // 1 — initial schema
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    data_key TEXT NOT NULL,                 -- this user's own encryption key, wrapped with the server key
    role TEXT NOT NULL DEFAULT 'user',      -- 'user' | 'admin'
    plan TEXT NOT NULL DEFAULT 'trial',     -- 'trial' | 'active' | 'past_due' | 'canceled' | 'comped'
    trial_ends_at INTEGER,
    current_period_end INTEGER,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- Encrypted personal details, one row per kind ('profile' = delivery details, 'alerts' = alert settings).
  CREATE TABLE user_data (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    enc TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind)
  );

  -- Quick Checkout list.
  CREATE TABLE products (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    sku TEXT NOT NULL,
    url TEXT NOT NULL,
    price REAL,
    quantity INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX products_user ON products(user_id, position);

  -- Restock watchlist.
  CREATE TABLE watch_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    max_price REAL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_status TEXT,
    last_alert_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX watch_user ON watch_items(user_id);
  CREATE INDEX watch_url ON watch_items(url);

  -- The public stock status of a product page. Shared so a page is checked
  -- once however many people watch it; holds nothing about who watches it.
  CREATE TABLE page_checks (
    url TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    status TEXT,
    title TEXT,
    price REAL,
    signals TEXT,
    checked_at INTEGER,
    next_check_at INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );

  -- One-time ⚡ Buy codes (2 minutes, single use, only for the account that made them).
  CREATE TABLE go_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    host TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- Codes for connecting the browser extension to an account.
  CREATE TABLE pair_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  -- Connected browser extensions.
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX devices_user ON devices(user_id);

  -- Activity feed and alerts.
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    name TEXT,
    sku TEXT,
    url TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX events_user ON events(user_id, id);

  CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  -- Stripe webhook events already handled (Stripe can send one twice).
  CREATE TABLE stripe_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );

  -- What admins changed, and on whose account.
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT,
    target_user_id TEXT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  `,
];

export class Db {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    this.cache = new Map();
    this.migrate();
  }

  migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version').get();
    let version = row ? row.version : 0;
    if (!row) this.db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    while (version < MIGRATIONS.length) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[version]);
        version += 1;
        this.db.prepare('UPDATE schema_version SET version = ?').run(version);
      });
    }
  }

  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      s.setAllowUnknownNamedParameters?.(true);
      this.cache.set(sql, s);
    }
    return s;
  }

  get(sql, params = {}) {
    const row = this.stmt(sql).get(params);
    return row ? { ...row } : null;
  }

  all(sql, params = {}) {
    return this.stmt(sql).all(params).map((r) => ({ ...r }));
  }

  run(sql, params = {}) {
    return this.stmt(sql).run(params);
  }

  tx(fn) {
    if (this.inTx) return fn();
    this.inTx = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  close() {
    this.db.close();
  }
}
