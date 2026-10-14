// Persists settings, shipping profile and the watchlist to data/state.json.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PROFILE, DEFAULT_SETTINGS, normalizeItem, normalizeProfile, normalizeSettings, ValidationError,
} from './schema.js';

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
    this.state = { version: 1, settings: { ...DEFAULT_SETTINGS }, profile: { ...DEFAULT_PROFILE }, items: [] };
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
    } else {
      this.saveNow();
    }
    return this;
  }

  get settings() { return this.state.settings; }
  get profile() { return this.state.profile; }
  get items() { return this.state.items; }

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
