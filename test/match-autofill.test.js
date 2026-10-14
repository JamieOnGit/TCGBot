import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchText, parseKeywords, rankHits, searchQueryFor, termRegex } from '../src/match.js';
import { classifyField, planFill, chooseOption, profileValues, expiryText } from '../src/autofill.js';
import { classifyCheckoutButton, isConfirmationPage } from '../src/assist.js';
import { PRESETS } from '../src/presets.js';

test('keyword groups, alternatives and set codes', () => {
  const kw = 'one piece, op-18|op18, booster box|display';
  assert.ok(matchText('ONE PIECE CARD GAME OP18 Booster Box', kw).ok);
  assert.ok(matchText('One Piece TCG - OP 18 - Booster Display (24 packs)', kw).ok);
  assert.ok(matchText('one-piece-card-game-op-18-booster-boxes', kw).ok, 'slugs and plurals');
  assert.ok(!matchText('One Piece OP-1 Booster Box', kw).ok, 'op-1 must not match op-18');
  assert.ok(!matchText('One Piece OP-180 Booster Box', kw).ok);
  assert.ok(!matchText('One Piece OP-18 Sleeves', kw).ok);
  assert.ok(matchText('Pokémon TCG Ultra-Premium Collection', 'pokemon, ultra premium').ok, 'accents and dashes');
  const r = matchText('One Piece OP-18 Booster Box Sleeves', kw, 'sleeves, playmat');
  assert.equal(r.ok, false);
  assert.deepEqual(r.excluded, ['sleeves']);
  assert.ok(termRegex('30th').test('pokemon 30th anniversary'));
  assert.ok(!termRegex('box').test('boxing'));
  assert.equal(searchQueryFor(kw), 'one piece op-18 booster box');
  assert.equal(parseKeywords('a|b, ,c').length, 2);
});

test('presets match realistic titles and reject accessories', () => {
  const op = PRESETS.find((p) => p.id === 'op-18-box');
  assert.ok(matchText('One Piece Card Game OP-18 Booster Box', op.keywords, op.exclude).ok);
  assert.ok(matchText('ONE PIECE CARD GAME - OP18 BOOSTER DISPLAY', op.keywords, op.exclude).ok);
  assert.ok(!matchText('One Piece Card Game OP-18 Booster Box Card Sleeves', op.keywords, op.exclude).ok);
  const upc = PRESETS.find((p) => p.id === 'pkm-upc-30th');
  assert.ok(matchText('Pokémon TCG: 30th Anniversary Celebration Ultra-Premium Collection', upc.keywords, upc.exclude).ok);
  assert.ok(!matchText('Pokémon TCG: Scarlet & Violet Ultra-Premium Collection', upc.keywords, upc.exclude).ok);
});

test('ranking prefers the most specific listing', () => {
  const hits = [
    { url: 'u1', name: 'One Piece OP-18 Booster Box Case (12 boxes) Bundle Deal' },
    { url: 'u2', name: 'One Piece OP-18 Booster Box' },
    { url: 'u3', name: 'One Piece OP-18 Sleeves' },
  ];
  const ranked = rankHits(hits, 'one piece, op-18, booster box', 'sleeves');
  assert.deepEqual(ranked.map((h) => h.url), ['u2', 'u1']);
});

const rec = (o) => ({ key: 'f', tag: 'input', type: 'text', desc: '', autocomplete: '', value: '', required: false, ...o });

test('field classification', () => {
  const cases = [
    [{ autocomplete: 'shipping given-name' }, 'firstName'],
    [{ autocomplete: 'cc-number' }, 'cardNumber'],
    [{ autocomplete: 'name', desc: 'name | name on card' }, 'cardName'],
    [{ type: 'email', desc: 'login' }, 'email'],
    [{ desc: 'checkout[shipping_address][last_name] | surname' }, 'lastName'],
    [{ desc: 'addressline2 | apartment, suite, etc.' }, 'address2'],
    [{ desc: 'street | street address' }, 'address1'],
    [{ desc: 'start typing your address' }, 'addressLookup'],
    [{ desc: 'country/region' }, 'country'],
    [{ desc: 'state/territory' }, 'state'],
    [{ desc: 'postcode' }, 'postcode'],
    [{ desc: 'city | suburb' }, 'suburb'],
    [{ desc: 'number | card number' }, 'cardNumber'],
    [{ desc: 'verification_value | security code' }, 'cardCvc'],
    [{ desc: 'expiry | expiration date (mm / yy)' }, 'cardExpiry'],
    [{ desc: 'encryptedexpirymonth' }, 'cardExpMonth'],
    [{ desc: 'gift card number' }, null],
    [{ desc: 'company name' }, null],
    [{ desc: 'promo code' }, null],
    [{ desc: 'recipient name' }, 'fullName'],
    [{ type: 'tel', desc: 'mobile' }, 'phone'],
  ];
  for (const [r, kind] of cases) assert.equal(classifyField(rec(r)), kind, JSON.stringify(r));
});

test('select options: states, months, years', () => {
  const values = profileValues({ state: 'NSW' }, { number: '4242424242424242', name: 'A', expMonth: '07', expYear: '2027', cvc: '' });
  assert.equal(chooseOption('state', [{ value: '', text: 'Select' }, { value: 'New South Wales', text: 'New South Wales' }], values), 'New South Wales');
  assert.equal(chooseOption('state', [{ value: '2', text: 'NSW' }], values), '2');
  assert.equal(chooseOption('state', [{ value: 'x', text: 'State of New South Wales' }], values), 'x');
  assert.equal(chooseOption('cardExpMonth', [{ value: '7', text: 'July' }], values), '7');
  assert.equal(chooseOption('cardExpMonth', [{ value: 'a', text: 'Jul' }], values), 'a');
  assert.equal(chooseOption('cardExpYear', [{ value: '27', text: '27' }], values), '27');
  assert.equal(chooseOption('country', [{ value: 'NZ', text: 'New Zealand' }, { value: 'AU', text: 'Australia' }], values), 'AU');
  assert.equal(expiryText({ maxLength: 4 }, values), '0727');
  assert.equal(expiryText({ placeholder: 'MM / YYYY' }, values), '07/2027');
  assert.equal(expiryText({ placeholder: 'MM / YY' }, values), '07/27');
});

test('fill plan: never overwrites, picks delivery, ticks terms only', () => {
  const values = profileValues({ firstName: 'Ash', lastName: 'K', email: 'a@b.co', state: 'VIC', postcode: '3000', address1: '1 St', suburb: 'Melb' });
  const plan = planFill([
    rec({ key: 'a', autocomplete: 'given-name' }),
    rec({ key: 'b', autocomplete: 'family-name', value: 'Existing' }),
    rec({ key: 'c', tag: 'select', type: 'select', desc: 'state', value: '', selectedText: 'Select state', options: [{ value: '', text: 'Select state' }, { value: 'VIC', text: 'Victoria' }] }),
    rec({ key: 'd', desc: 'mystery field', required: true }),
    rec({ key: 'e', type: 'radio', name: 'delivery', label: 'Click & Collect (free)' }),
    rec({ key: 'f', type: 'radio', name: 'delivery', label: 'Standard Delivery $9.95' }),
    rec({ key: 'g', type: 'checkbox', label: 'I agree to the Terms & Conditions' }),
    rec({ key: 'h', type: 'checkbox', label: 'Subscribe to our newsletter' }),
    rec({ key: 'i', desc: 'card number' }),
  ], values);
  const byKey = Object.fromEntries(plan.actions.map((a) => [a.key, a]));
  assert.equal(byKey.a.value, 'Ash');
  assert.ok(!byKey.b, 'existing value kept');
  assert.equal(byKey.c.value, 'VIC');
  assert.ok(!byKey.e);
  assert.equal(byKey.f.action, 'click');
  assert.equal(byKey.g.action, 'click');
  assert.ok(!byKey.h, 'never opts into marketing');
  assert.ok(!byKey.i, 'no card without unlocked vault');
  assert.deepEqual(plan.unknownRequired, ['mystery field']);
});

test('checkout button classification never treats express-pay as continue', () => {
  assert.equal(classifyCheckoutButton('Place Order'), 'final');
  assert.equal(classifyCheckoutButton('Pay now'), 'final');
  assert.equal(classifyCheckoutButton('Pay $189.95'), 'final');
  assert.equal(classifyCheckoutButton('Place your order'), 'final');
  assert.equal(classifyCheckoutButton('Continue to delivery'), 'continue');
  assert.equal(classifyCheckoutButton('Continue  ›'), 'continue');
  assert.equal(classifyCheckoutButton('Continue as Guest'), 'guest');
  assert.equal(classifyCheckoutButton('Secure Checkout'), 'checkout');
  assert.equal(classifyCheckoutButton('Checkout'), 'checkout');
  assert.equal(classifyCheckoutButton('Enter address manually'), 'manual');
  for (const t of ['Continue to PayPal', 'Checkout with Afterpay', 'Continue shopping', 'Sign in', 'Apply', 'Back', 'Buy with Google Pay']) {
    assert.equal(classifyCheckoutButton(t), null, t);
  }
  assert.ok(isConfirmationPage({ url: 'https://x/checkout/confirmation', text: '' }));
  assert.ok(isConfirmationPage({ url: 'https://x/a', text: 'Thank you for your order! Order number: DG-1001' }));
  assert.ok(!isConfirmationPage({ url: 'https://x/checkout/payment', text: 'Payment details' }));
});
