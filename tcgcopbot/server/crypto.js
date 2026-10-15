// Passwords, tokens and encryption at rest.
//
// * Passwords: scrypt with a random salt per user.
// * Session, device and one-time tokens: random 256-bit values; only their
//   SHA-256 hash is stored, so a database leak doesn't hand out logins.
// * Personal details (address, alert settings): encrypted with a key that
//   belongs to that one user. Each user key is itself encrypted ("wrapped")
//   with the server's DATA_ENCRYPTION_KEY. The ciphertext is bound to the user
//   and the field it belongs to, so it can't be copied onto another account.
//   Deleting an account deletes its key, which makes any leftover copy of
//   that user's data (e.g. in a backup) unreadable.

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password).normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64url');
  const got = await scrypt(String(password).normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// A fixed hash to compare against when the email doesn't exist, so a login
// for an unknown email takes as long as one for a real account.
let dummyHash = null;
export async function dummyVerify(password) {
  if (!dummyHash) dummyHash = await hashPassword('not-a-real-password');
  await verifyPassword(password, dummyHash);
  return false;
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** A short code people can type: XXXX-XXXX, no look-alike characters. */
export function humanCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export const normalizeHumanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');

// ---------------------------------------------------------------------------
// AES-256-GCM
// ---------------------------------------------------------------------------
function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

function open(key, sealed, aad) {
  const [v, iv, tag, ct] = String(sealed || '').split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unreadable encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
}

/** A new random key for one user, returned wrapped with the server key. */
export function newUserKey(masterKey, userId) {
  return seal(masterKey, crypto.randomBytes(32), `user-key:${userId}`);
}

export function unwrapUserKey(masterKey, wrapped, userId) {
  return open(masterKey, wrapped, `user-key:${userId}`);
}

export function encryptJSON(key, value, aad) {
  return seal(key, Buffer.from(JSON.stringify(value)), aad);
}

export function decryptJSON(key, sealed, aad) {
  return JSON.parse(open(key, sealed, aad).toString('utf8'));
}
