// Persists settings, shipping profile and the watchlist to data/state.json.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PROFILE, DEFAULT_SETTINGS, normalizeItem, normalizeProfile, normalizeQuickProduct, normalizeSettings, ValidationError,
} from './schema.js';
import { QUICK_DEFAULTS } from './presets.js';

function defaultQuick() {
  return { rev: 1, products: QUICK_DEFAULTS.map((p) => normalizeQuickProduct(p)) };
}

export class Store extends EventEmitter {
  /**
   * @param {string} dataDir
   * @param {{knownRetailers: () => string[], allowFastPolling?: boolean}} opts
   */
  constructor(dataDir, { knownRetailers, allowFastPolling = false } = {}) {
    super();
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    this.knownRetailers = knownRetailers;
    this.allowFastPolling = allowFastPolling;
    this.state = { version: 1, settings: { ...DEFAULT_SETTINGS }, profile: { ...DEFAULT_PROFILE }, items: [], quick: defaultQuick() };
    this.saveTimer = null;
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    let raw = null;
    if (fs.existsSync(this.file)) {
      try {
        raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {
        // Keep a copy of the unreadable file and start fresh rather than refusing to start.
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      }
    }
    if (raw) {
      this.state.settings = normalizeSettings(raw.settings || {});
      this.state.profile = normalizeProfile(raw.profile || {});
      this.state.items = [];
      for (const it of raw.items || []) {
        try {
          const item = normalizeItem(it, this.knownRetailers(), null, { allowFastPolling: this.allowFastPolling });
          item.id = it.id || item.id;
          item.resolvedUrl = it.resolvedUrl || '';
          item.resolvedName = it.resolvedName || '';
          item.createdAt = it.createdAt || item.createdAt;
          this.state.items.push(item);
        } catch {
          // Skip items that no longer validate (e.g. a removed retailer).
        }
      }
      if (raw.quick && Array.isArray(raw.quick.products)) {
        const products = [];
        for (const p of raw.quick.products) {
          try { products.push(normalizeQuickProduct(p, { id: p.id })); } catch { /* skip invalid */ }
        }
        this.state.quick = { rev: Number(raw.quick.rev) || 1, products };
      }
    } else {
      this.saveNow();
    }
    return this;
  }

  get settings() { return this.state.settings; }
  get profile() { return this.state.profile; }
  get items() { return this.state.items; }
  get quick() { return this.state.quick; }

  getItem(id) {
    return this.state.items.find((i) => i.id === id) || null;
  }

  addItem(input) {
    const item = normalizeItem(input, this.knownRetailers(), null, { allowFastPolling: this.allowFastPolling });
    while (this.getItem(item.id)) item.id = `${item.id}x`;
    this.state.items.push(item);
    this.changed('items', { added: item.id });
    return item;
  }

  updateItem(id, patch) {
    const idx = this.state.items.findIndex((i) => i.id === id);
    if (idx === -1) throw new ValidationError('Item not found');
    const prev = this.state.items[idx];
    const item = normalizeItem(patch, this.knownRetailers(), prev, { allowFastPolling: this.allowFastPolling });
    this.state.items[idx] = item;
    this.changed('items', { updated: id });
    return item;
  }

  /** Internal updates (e.g. the product a keyword search found) that bypass validation. */
  patchItem(id, fields) {
    const item = this.getItem(id);
    if (!item) return null;
    Object.assign(item, fields);
    this.changed('items', { patched: id, quiet: true });
    return item;
  }

  removeItem(id) {
    const before = this.state.items.length;
    this.state.items = this.state.items.filter((i) => i.id !== id);
    if (this.state.items.length === before) throw new ValidationError('Item not found');
    this.changed('items', { removed: id });
  }

  // --- Quick Checkout list (order = priority) -------------------------------

  getQuickProduct(id) {
    return this.state.quick.products.find((p) => p.id === id) || null;
  }

  addQuickProduct(input) {
    const p = normalizeQuickProduct(input);
    while (this.getQuickProduct(p.id)) p.id = `${p.id}x`;
    this.state.quick.products.push(p);
    this.quickChanged();
    return p;
  }

  updateQuickProduct(id, patch) {
    const idx = this.state.quick.products.findIndex((p) => p.id === id);
    if (idx === -1) throw new ValidationError('Product not found');
    const p = normalizeQuickProduct(patch, this.state.quick.products[idx]);
    this.state.quick.products[idx] = p;
    this.quickChanged();
    return p;
  }

  removeQuickProduct(id) {
    const before = this.state.quick.products.length;
    this.state.quick.products = this.state.quick.products.filter((p) => p.id !== id);
    if (this.state.quick.products.length === before) throw new ValidationError('Product not found');
    this.quickChanged();
  }

  /** Reorder by a list of ids (ids not mentioned keep their relative order at the end). */
  reorderQuick(ids) {
    const byId = new Map(this.state.quick.products.map((p) => [p.id, p]));
    const ordered = [];
    for (const id of ids || []) if (byId.has(id)) { ordered.push(byId.get(id)); byId.delete(id); }
    this.state.quick.products = [...ordered, ...byId.values()];
    this.quickChanged();
    return this.state.quick.products;
  }

  quickChanged() {
    this.state.quick.rev += 1;
    this.changed('quick');
  }

  setSettings(patch) {
    this.state.settings = normalizeSettings(patch, this.state.settings);
    this.changed('settings');
    return this.state.settings;
  }

  setProfile(patch) {
    this.state.profile = normalizeProfile(patch, this.state.profile);
    this.changed('profile');
    return this.state.profile;
  }

  changed(what, info = {}) {
    this.scheduleSave();
    this.emit('change', what, info);
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 150);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
