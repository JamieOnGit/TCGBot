// Building blocks: passwords, encryption, codes, product links, input
// checks, the zip writer and the extension builder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { decryptJSON, encryptJSON, hashPassword, humanCode, newUserKey, normalizeHumanCode, unwrapUserKey, verifyPassword } from '../server/crypto.js';
import { extensionFiles, extensionManifest } from '../server/extension.js';
import { RateLimiter, parseCookies } from '../server/http.js';
import { alerts, product, profile, watchItem } from '../server/schema.js';
import { skuFromUrl, storeName } from '../server/stores.js';
import { makeZip } from '../server/zip.js';
import { loadConfig } from '../server/config.js';

test('passwords: scrypt hashes, salted, verified', async () => {
  const h1 = await hashPassword('hunter2 hunter2');
  const h2 = await hashPassword('hunter2 hunter2');
  assert.match(h1, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(h1, h2, 'random salt');
  assert.equal(await verifyPassword('hunter2 hunter2', h1), true);
  assert.equal(await verifyPassword('hunter2 hunter3', h1), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('per-user keys: wrapped by the server key, bound to the user', () => {
  const master = crypto.randomBytes(32);
  const wrapped = newUserKey(master, 'usr_a');
  const key = unwrapUserKey(master, wrapped, 'usr_a');
  assert.equal(key.length, 32);
  assert.throws(() => unwrapUserKey(master, wrapped, 'usr_b'), 'another user id');
  assert.throws(() => unwrapUserKey(crypto.randomBytes(32), wrapped, 'usr_a'), 'another server key');
  const sealed = encryptJSON(key, { address1: '1 Pallet Rd' }, 'usr_a:profile');
  assert.doesNotMatch(sealed, /Pallet/);
  assert.deepEqual(decryptJSON(key, sealed, 'usr_a:profile'), { address1: '1 Pallet Rd' });
  assert.throws(() => decryptJSON(key, sealed, 'usr_a:alerts'), 'another field');
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => decryptJSON(key, tampered, 'usr_a:profile'));
});

test('connection codes are easy to type', () => {
  for (let i = 0; i < 50; i++) assert.match(humanCode(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(normalizeHumanCode(' abcd 2345 '), 'ABCD-2345');
  assert.equal(normalizeHumanCode('abcd-2345'), 'ABCD-2345');
});

test('product codes from store links', () => {
  assert.equal(skuFromUrl('https://www.kmart.com.au/product/pokemon-tcg%3A-30th-celebration-ultra-premium-collection-day-43818648/'), '43818648');
  assert.equal(skuFromUrl('https://www.ebgames.com.au/product/toys-and-collectibles/312345-one-piece-op18'), '312345');
  assert.equal(skuFromUrl('https://www.jbhifi.com.au/products/pokemon-tcg-etb'), 'pokemon-tcg-etb');
  assert.equal(skuFromUrl('https://www.target.com.au/p/pokemon-tcg-booster/71234567'), '71234567');
  assert.equal(skuFromUrl('https://www.bigw.com.au/product/pokemon-tcg/p/6012345'), '6012345');
  assert.equal(skuFromUrl('https://www.amazon.com.au/dp/B0ABCDEF12'), 'B0ABCDEF12');
  assert.equal(skuFromUrl('https://shop.example.com/item/9876543'), '9876543');
  assert.equal(skuFromUrl('not a url'), '');
  assert.equal(storeName('https://www.bigw.com.au/x'), 'BIG W');
  assert.equal(storeName('https://www.cardshop.example/x'), 'cardshop.example');
});

test('input checks', () => {
  const p = product({ url: 'https://www.kmart.com.au/product/x-43000001/#frag', quantity: 99, price: '12.5' });
  assert.equal(p.sku, '43000001');
  assert.equal(p.quantity, 10, 'max 10');
  assert.equal(p.price, 12.5);
  assert.equal(p.url, 'https://www.kmart.com.au/product/x-43000001/', 'fragment dropped');
  assert.throws(() => product({ url: 'javascript:alert(1)', sku: '1' }));
  assert.throws(() => product({ url: 'https://user:pw@example.com/p/1' }));
  assert.throws(() => product({ url: 'https://example.com/no-code-here' }), /product code/);
  assert.equal(profile({ state: 'new south wales', postcode: '2000' }).state, 'NSW');
  assert.throws(() => profile({ postcode: '20000' }));
  assert.throws(() => profile({ state: 'XX' }));
  assert.throws(() => alerts({ discordWebhook: 'https://discord.com.evil.example/api/webhooks/1/x' }));
  assert.equal(alerts({ discordMention: '@everyone hi' }).discordMention, 'everyone hi', 'no mass mentions');
  assert.equal(watchItem({ url: 'https://shop.example.com/products/op-18-box' }).name, 'op-18-box');
});

test('rate limiter and cookies', () => {
  let t = 0;
  const rl = new RateLimiter(() => t);
  assert.equal(rl.hit('k', 2, 1000), true);
  assert.equal(rl.hit('k', 2, 1000), true);
  assert.equal(rl.hit('k', 2, 1000), false);
  t = 1001;
  assert.equal(rl.hit('k', 2, 1000), true, 'new window');
  assert.deepEqual(parseCookies('a=1; b=x%20y; a=2'), { a: '1', b: 'x y' });
});

function unzip(buf) {
  const files = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const crc = buf.readUInt32LE(i + 14);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString();
    const data = buf.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    const out = method === 8 ? zlib.inflateRawSync(data) : data;
    assert.equal(zlib.crc32(out), crc, `crc of ${name}`);
    files[name] = out;
    i += 30 + nameLen + extra + size;
  }
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'end record');
  return files;
}

test('zip writer round-trips', () => {
  const zip = makeZip([{ name: 'a/hello.txt', data: 'hello world' }, { name: 'a/b.bin', data: crypto.randomBytes(5000) }]);
  const files = unzip(zip);
  assert.equal(files['a/hello.txt'].toString(), 'hello world');
  assert.equal(files['a/b.bin'].length, 5000);
});

test('extension built for a live server: only that server and the stores', () => {
  const cfg = loadConfig({ baseUrl: 'https://app.tcgcopbot.example', dataKey: crypto.randomBytes(32) });
  const m = extensionManifest(cfg);
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.host_permissions, ['https://app.tcgcopbot.example/*']);
  assert.deepEqual(m.permissions, ['storage'], 'no tabs/history/cookies permissions');
  const by = (f) => m.content_scripts.find((c) => c.js.includes(f));
  assert.deepEqual(by('bridge.js').matches, ['https://app.tcgcopbot.example/*']);
  assert.equal(by('capture.js').run_at, 'document_start');
  assert.ok(by('content.js').matches.includes('https://www.kmart.com.au/*'));
  assert.ok(!JSON.stringify(m).includes('127.0.0.1'), 'no local addresses in a live build');
  assert.equal(by('frame.js').all_frames, true);

  const files = extensionFiles(cfg);
  const names = files.map((f) => f.name);
  const needed = new Set([m.background.service_worker, m.action.default_popup, m.options_page, ...Object.values(m.icons), ...m.content_scripts.flatMap((c) => c.js), 'config.js', 'vault.js']);
  for (const n of needed) assert.ok(names.includes(n), `${n} is in the package`);
  const config = files.find((f) => f.name === 'config.js').data.toString();
  const ctx = {};
  vm.runInNewContext(config, ctx);
  assert.equal(ctx.TCB_CONFIG.server, 'https://app.tcgcopbot.example');
  for (const f of files.filter((x) => x.name.endsWith('.js'))) {
    assert.doesNotThrow(() => new vm.Script(f.data.toString(), { filename: f.name }), `${f.name} parses`);
  }
});

test('extension built for a server on your computer also runs on the local test store', () => {
  const cfg = loadConfig({ baseUrl: 'http://127.0.0.1:8080', dataKey: crypto.randomBytes(32) });
  const m = extensionManifest(cfg);
  assert.deepEqual(m.host_permissions, ['http://127.0.0.1/*']);
  const content = m.content_scripts.find((c) => c.js.includes('content.js'));
  assert.ok(content.matches.includes('http://127.0.0.1/*'));
  assert.deepEqual(content.exclude_matches, ['http://127.0.0.1:8080/*'], 'but not on the dashboard itself');
});

test('production refuses to start without an encryption key', () => {
  assert.throws(() => loadConfig({ env: 'production' }, {}), /DATA_ENCRYPTION_KEY/);
  assert.throws(() => loadConfig({}, { DATA_ENCRYPTION_KEY: 'too-short' }), /32 bytes/);
  const cfg = loadConfig({}, { NODE_ENV: 'production', DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), BASE_URL: 'https://x.example' });
  assert.equal(cfg.secureCookies, true);
});
