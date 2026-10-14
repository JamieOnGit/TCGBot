// Encrypted, optional storage for card details.
//
// The card is encrypted with AES-256-GCM using a key derived from your
// passphrase (scrypt). The passphrase is never stored; you unlock the vault
// once per session and the decrypted card lives only in memory. Leave it empty
// if you prefer to use cards saved in your retailer accounts or PayPal.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KDF = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function luhnOk(number) {
  const digits = String(number).replace(/\D/g, '');
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function normalizeCard(card) {
  const number = String(card.number || '').replace(/\D/g, '');
  if (!luhnOk(number)) throw new Error('Card number is not valid');
  const expMonth = parseInt(card.expMonth, 10);
  if (!(expMonth >= 1 && expMonth <= 12)) throw new Error('Expiry month must be 1-12');
  let expYear = parseInt(card.expYear, 10);
  if (expYear < 100) expYear += 2000;
  if (!(expYear >= 2020 && expYear <= 2100)) throw new Error('Expiry year looks wrong');
  const cvc = String(card.cvc || '').replace(/\D/g, '');
  if (cvc && (cvc.length < 3 || cvc.length > 4)) throw new Error('Security code must be 3 or 4 digits');
  const name = String(card.name || '').trim().slice(0, 100);
  if (!name) throw new Error('Name on card is required');
  return { number, name, expMonth: String(expMonth).padStart(2, '0'), expYear: String(expYear), cvc };
}

async function deriveKey(passphrase, salt) {
  return scrypt(String(passphrase), salt, 32, KDF);
}

export class Vault {
  constructor(file) {
    this.file = file;
    this.card = null;
  }

  exists() {
    return fs.existsSync(this.file);
  }

  get unlocked() {
    return !!this.card;
  }

  summary() {
    const s = { exists: this.exists(), unlocked: this.unlocked };
    if (this.card) {
      s.last4 = this.card.number.slice(-4);
      s.expiry = `${this.card.expMonth}/${this.card.expYear.slice(-2)}`;
      s.hasCvc = !!this.card.cvc;
    }
    return s;
  }

  async save(passphrase, card) {
    if (!passphrase || String(passphrase).length < 6) throw new Error('Choose a passphrase of at least 6 characters');
    const clean = normalizeCard(card);
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = await deriveKey(passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(clean), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = {
      v: 1, kdf: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p,
      salt: salt.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64'),
    };
    fs.writeFileSync(this.file, JSON.stringify(payload), { mode: 0o600 });
    this.card = clean;
    return this.summary();
  }

  async unlock(passphrase) {
    if (!this.exists()) throw new Error('No saved card');
    const payload = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const key = await scrypt(String(passphrase), Buffer.from(payload.salt, 'base64'), 32, { N: payload.N, r: payload.r, p: payload.p, maxmem: KDF.maxmem });
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      const pt = Buffer.concat([decipher.update(Buffer.from(payload.ct, 'base64')), decipher.final()]);
      this.card = JSON.parse(pt.toString('utf8'));
    } catch {
      throw new Error('Wrong passphrase');
    }
    return this.summary();
  }

  lock() {
    this.card = null;
    return this.summary();
  }

  remove() {
    this.card = null;
    if (this.exists()) fs.unlinkSync(this.file);
    return this.summary();
  }
}
