import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RETAILER_SPECS, detectRetailer, getRetailer, retailerForItem } from '../src/retailers/index.js';
import { Vault, luhnOk } from '../src/vault.js';
import { normalizeItem, normalizeProfile, normalizeSettings, ValidationError } from '../src/schema.js';

const EXAMPLES = {
  ebgames: ['https://www.ebgames.com.au/product/toys-and-collectibles/321456-pokemon-tcg-ultra-premium-collection', '321456'],
  zing: ['https://www.zingpopculture.com.au/product/trading-cards/298765-one-piece-op-18-booster-box', '298765'],
  jbhifi: ['https://www.jbhifi.com.au/products/pokemon-tcg-30th-anniversary-ultra-premium-collection', 'pokemon-tcg-30th-anniversary-ultra-premium-collection'],
  kmart: ['https://www.kmart.com.au/product/pokemon-trading-card-game-booster-bundle-43301234/', '43301234'],
  target: ['https://www.target.com.au/p/pokemon-tcg-elite-trainer-box/70123456', '70123456'],
  bigw: ['https://www.bigw.com.au/product/one-piece-card-game-op-18-booster-box/p/912345', '912345'],
  toysrus: ['https://www.toysrus.com.au/products/one-piece-card-game-booster-box', 'one-piece-card-game-booster-box'],
  amazon: ['https://www.amazon.com.au/Pokemon-TCG-Ultra-Premium-Collection/dp/B0ABCDEFGH/ref=sr_1_1', 'B0ABCDEFGH'],
};

test('every built-in retailer recognises its own product links', () => {
  for (const spec of RETAILER_SPECS) {
    const ex = EXAMPLES[spec.id];
    assert.ok(ex, `example for ${spec.id}`);
    const d = detectRetailer(ex[0]);
    assert.equal(d.retailer, spec.id, ex[0]);
    assert.equal(d.sku, ex[1], `${spec.id} sku`);
    assert.ok(d.isProduct, `${spec.id} product url`);
    const r = getRetailer(spec.id);
    assert.ok(r.cartUrl().startsWith('https://'), `${spec.id} cart url`);
    if (r.searchPath) assert.match(r.searchUrl('one piece op-18'), /one%20piece%20op-18/);
  }
  assert.equal(getRetailer('kmart').isProductUrl('https://www.kmart.com.au/category/toys/'), false);
  assert.equal(getRetailer('amazon').url(getRetailer('amazon').productPathFromSku.replace('{sku}', 'B0X')), 'https://www.amazon.com.au/dp/B0X');
});

test('unknown links: Shopify guess or generic', () => {
  assert.deepEqual(detectRetailer('https://shop.example.com.au/products/op-18-box').retailer, 'shopify');
  assert.deepEqual(detectRetailer('https://example.com/item/123').retailer, 'generic');
  assert.equal(detectRetailer('not a url'), null);
  const r = retailerForItem({ retailer: 'shopify', domain: 'cards.example.com' });
  assert.equal(r.base, 'https://cards.example.com');
  assert.equal(r.cartPermalink(123, 2), 'https://cards.example.com/cart/123:2');
});

test('item validation', () => {
  const ids = RETAILER_SPECS.map((s) => s.id);
  assert.throws(() => normalizeItem({ retailer: 'nope', keywords: 'x' }, ids), ValidationError);
  assert.throws(() => normalizeItem({ retailer: 'kmart' }, ids), /something to look for/);
  assert.throws(() => normalizeItem({ retailer: 'generic', keywords: 'x' }, ids), /needs a product link/);
  assert.throws(() => normalizeItem({ retailer: 'kmart', url: 'javascript:alert(1)' }, ids), /valid URL|http/);
  assert.throws(() => normalizeItem({ retailer: 'kmart', keywords: 'x', pollSeconds: 1 }, ids), /at least 3/);
  const it = normalizeItem({ retailer: 'kmart', keywords: 'one piece, op-18', maxPrice: '170', quantity: '2' }, ids);
  assert.equal(it.name, 'one piece');
  assert.equal(it.maxPrice, 170);
  assert.equal(it.quantity, 2);
  assert.equal(it.mode, 'notify');
  const edited = normalizeItem({ keywords: 'one piece, op-19' }, ids, { ...it, resolvedUrl: 'https://x/y' });
  assert.equal(edited.resolvedUrl, '', 'changing keywords forgets the old listing');
  assert.equal(edited.id, it.id);
  const p = normalizeProfile({ state: 'victoria', postcode: '3000', email: 'a@b.com' });
  assert.equal(p.state, 'VIC');
  assert.throws(() => normalizeProfile({ postcode: '30000' }), /4 digits/);
  assert.throws(() => normalizeSettings({ pollSeconds: 1 }), /at least 3/);
  assert.throws(() => normalizeSettings({ discordWebhook: 'file:///etc/passwd' }), /http/);
});

test('a corrupt state file is backed up instead of crashing the app', async () => {
  const { Store } = await import('../src/store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgbot-store-'));
  fs.writeFileSync(path.join(dir, 'state.json'), '{"settings": {broken');
  const s = new Store(dir, { knownRetailers: () => RETAILER_SPECS.map((x) => x.id) }).load();
  assert.equal(s.items.length, 0);
  assert.equal(s.settings.pollSeconds, 15);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-')));
  s.addItem({ retailer: 'ebgames', keywords: 'pokemon, etb' });
  s.saveNow();
  const again = new Store(dir, { knownRetailers: () => RETAILER_SPECS.map((x) => x.id) }).load();
  assert.equal(again.items.length, 1, 'round-trips through disk');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('vault encrypts the card and needs the passphrase', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgbot-vault-'));
  const file = path.join(dir, 'vault.json');
  const v = new Vault(file);
  assert.ok(luhnOk('4242 4242 4242 4242'));
  assert.ok(!luhnOk('4242 4242 4242 4241'));
  await assert.rejects(v.save('pw', { number: '4242424242424242', name: 'A', expMonth: 7, expYear: 27 }), /at least 6/);
  await assert.rejects(v.save('secret123', { number: '1234', name: 'A', expMonth: 7, expYear: 27 }), /not valid/);
  const s = await v.save('secret123', { number: '4242 4242 4242 4242', name: 'Ash K', expMonth: '7', expYear: '27', cvc: '123' });
  assert.deepEqual(s, { exists: true, unlocked: true, last4: '4242', expiry: '07/27', hasCvc: true });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('4242'), 'card number is not stored in plain text');
  assert.ok(!raw.includes('Ash'));
  const v2 = new Vault(file);
  assert.equal(v2.unlocked, false);
  await assert.rejects(v2.unlock('wrong-pass'), /Wrong passphrase/);
  await v2.unlock('secret123');
  assert.equal(v2.card.number, '4242424242424242');
  assert.equal(v2.card.expYear, '2027');
  v2.lock();
  assert.equal(v2.card, null);
  v2.remove();
  assert.ok(!fs.existsSync(file));
  fs.rmSync(dir, { recursive: true, force: true });
});
