import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML, textContent, findAll, decodeEntities } from '../src/html.js';
import {
  extractProduct, mapAvailability, parsePrice, classifyActionText, classifyAvailabilityText, extractProductLinks, slugWords, looksBlocked,
} from '../src/extract.js';
import { STATUS } from '../src/status.js';

test('parser copes with messy HTML', () => {
  const doc = parseHTML(`<!doctype html><html><body>
    <div class=a id=x data-x='1'><p>one<p>two<br/>three</div>
    <script>if (a < b && c > d) { document.write("</div>") }</script>
    <!-- <button>hidden in comment</button> -->
    <ul><li>a<li>b</ul>
    <input type=submit value="Add to Cart" disabled>
    <span>&amp; &#39;x&#39; &#x27;y&#x27; &nbsp;caf&eacute;</span>
    </body></html>`);
  const ps = findAll(doc, (n) => n.tag === 'p');
  assert.equal(ps.length, 2);
  assert.equal(findAll(doc, (n) => n.tag === 'li').length, 2);
  const script = findAll(doc, (n) => n.tag === 'script')[0];
  assert.match(script.text, /document\.write/);
  assert.equal(findAll(doc, (n) => n.tag === 'button').length, 0, 'comment content is ignored');
  const input = findAll(doc, (n) => n.tag === 'input')[0];
  assert.equal(input.attrs.value, 'Add to Cart');
  assert.ok('disabled' in input.attrs);
  const span = findAll(doc, (n) => n.tag === 'span')[0];
  assert.equal(textContent(span), "& 'x' 'y'  café".replace(/\s+/g, ' ').trim());
  assert.equal(decodeEntities('&lt;b&gt; &unknown; &#999999999;'), '<b> &unknown; &#999999999;');
});

test('availability vocabulary', () => {
  assert.equal(mapAvailability('https://schema.org/InStock'), STATUS.IN_STOCK);
  assert.equal(mapAvailability('http://schema.org/PreOrder'), STATUS.PREORDER);
  assert.equal(mapAvailability('BackOrder'), STATUS.PREORDER);
  assert.equal(mapAvailability('schema:OutOfStock'), STATUS.OUT_OF_STOCK);
  assert.equal(mapAvailability('InStoreOnly'), STATUS.OUT_OF_STOCK);
  assert.equal(mapAvailability('instock'), STATUS.IN_STOCK);
  assert.equal(mapAvailability('out of stock'), STATUS.OUT_OF_STOCK);
  assert.equal(mapAvailability('whatever'), null);
  assert.equal(parsePrice('$1,299.95'), 1299.95);
  assert.equal(parsePrice('AU$ 79'), 79);
  assert.equal(parsePrice(12.5), 12.5);
  assert.equal(parsePrice('free'), null);
});

test('buy-button text classification', () => {
  assert.equal(classifyActionText('Add to Cart'), STATUS.IN_STOCK);
  assert.equal(classifyActionText('ADD TO BAG'), STATUS.IN_STOCK);
  assert.equal(classifyActionText('Pre-order now'), STATUS.PREORDER);
  assert.equal(classifyActionText('Preorder'), STATUS.PREORDER);
  assert.equal(classifyActionText('Sold Out'), STATUS.OUT_OF_STOCK);
  assert.equal(classifyActionText('Currently unavailable'), STATUS.OUT_OF_STOCK);
  assert.equal(classifyActionText('Notify me when available'), STATUS.COMING_SOON);
  assert.equal(classifyActionText('Coming Soon'), STATUS.COMING_SOON);
  assert.equal(classifyActionText('Add to wishlist'), null);
  assert.equal(classifyActionText('Pay with Afterpay'), null);
  assert.equal(classifyActionText('Check stock in store'), null);
});

test('stock message classification ignores in-store stock', () => {
  assert.equal(classifyAvailabilityText('In stock'), STATUS.IN_STOCK);
  assert.equal(classifyAvailabilityText('Only 3 left!'), STATUS.IN_STOCK);
  assert.equal(classifyAvailabilityText('Not in stock'), STATUS.OUT_OF_STOCK);
  assert.equal(classifyAvailabilityText('Temporarily out of stock.'), STATUS.OUT_OF_STOCK);
  assert.equal(classifyAvailabilityText('In-store only'), STATUS.OUT_OF_STOCK);
  assert.equal(classifyAvailabilityText('Sold out online'), STATUS.OUT_OF_STOCK);
  assert.equal(classifyAvailabilityText('In stock at 3 stores near you'), null);
  assert.equal(classifyAvailabilityText('Usually dispatched within 2 to 3 days'), STATUS.IN_STOCK);
  assert.equal(classifyAvailabilityText('Pre-order: releases 14/11'), STATUS.PREORDER);
});

const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

test('JSON-LD wins and related-product lists are ignored', () => {
  const html = `<html><head>
    ${ld({ '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', item: { '@type': 'Product', name: 'Other', offers: { availability: 'https://schema.org/InStock' } } }] })}
    ${ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'BreadcrumbList' }, { '@type': 'Product', name: 'OP-18 Booster Box', sku: '123', offers: { '@type': 'Offer', price: '159.00', priceCurrency: 'AUD', availability: 'https://schema.org/OutOfStock' } }] })}
    </head><body><h1>OP-18 Booster Box</h1>
    <section class="recommendations"><button>Add to cart</button></section>
    </body></html>`;
  const r = extractProduct(html, { url: 'https://x.com/p/123' });
  assert.equal(r.status, STATUS.OUT_OF_STOCK);
  assert.equal(r.decidedBy, 'json-ld');
  assert.equal(r.title, 'OP-18 Booster Box');
  assert.equal(r.price, 159);
  assert.equal(r.sku, '123');
});

test('ProductGroup with variants: any orderable variant counts', () => {
  const html = ld({ '@type': 'ProductGroup', name: 'Box', hasVariant: [
    { '@type': 'Product', sku: 'a', offers: { availability: 'OutOfStock', price: 10 } },
    { '@type': 'Product', sku: 'b', offers: { availability: 'PreOrder', price: 10 } },
  ] });
  assert.equal(extractProduct(html).status, STATUS.PREORDER);
});

test('broken JSON-LD (raw newlines, trailing commas) still parses', () => {
  const html = `<script type="application/ld+json">{"@type":"Product","name":"Line1
Line2","offers":{"availability":"InStock","price":"5.00",},}</script>`;
  const r = extractProduct(html);
  assert.equal(r.status, STATUS.IN_STOCK);
  assert.equal(r.price, 5);
});

test('meta tags and microdata', () => {
  assert.equal(extractProduct('<meta property="product:availability" content="preorder"><meta property="product:price:amount" content="49.95">').status, STATUS.PREORDER);
  const md = '<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">X</span><link itemprop="availability" href="https://schema.org/InStock"><span itemprop="price" content="12.00">$12</span></div>';
  const r = extractProduct(md);
  assert.equal(r.status, STATUS.IN_STOCK);
  assert.equal(r.decidedBy, 'microdata');
  assert.equal(r.price, 12);
});

test('buttons: main product beats recommendation carousel; disabled = sold out', () => {
  const html = `<header><button>Add to cart</button></header><main>
    <div class="product-info"><h1>UPC</h1><span class="price">$189.95</span><button class="btn add-to-cart" disabled>Add to Cart</button></div>
    <div class="you-may-also-like"><button>Add to cart</button></div></main>`;
  const r = extractProduct(html);
  assert.equal(r.status, STATUS.OUT_OF_STOCK);
  assert.equal(r.decidedBy, 'button');
  assert.equal(r.price, 189.95);

  const live = extractProduct('<main><div class="pdp"><button class="product-form__submit">Add to cart</button></div></main>');
  assert.equal(live.status, STATUS.IN_STOCK);

  const hidden = extractProduct('<main><button class="hidden">Add to cart</button><button disabled>Sold out</button></main>');
  assert.equal(hidden.status, STATUS.OUT_OF_STOCK);

  const soon = extractProduct('<main><a class="btn btn-primary" href="#notify">Notify me</a></main>');
  assert.equal(soon.status, STATUS.COMING_SOON);
});

test('Amazon-style availability block', () => {
  const html = '<div id="availability"><span class="a-color-success"> In stock </span></div><input type="submit" id="add-to-cart-button" value="Add to Cart">';
  const r = extractProduct(html);
  assert.equal(r.status, STATUS.IN_STOCK);
  assert.equal(r.decidedBy, 'availability');
  const oos = extractProduct('<div id="availability"><span>Currently unavailable.</span></div>');
  assert.equal(oos.status, STATUS.OUT_OF_STOCK);
});

test('block and not-found pages', () => {
  const blocked = extractProduct('<html><head><title>Access Denied</title></head><body>You don\'t have permission. Reference #18.6f2d.1700000.abc</body></html>');
  assert.equal(blocked.status, STATUS.BLOCKED);
  assert.ok(looksBlocked('<div id="px-captcha"></div>', 'x'));
  assert.ok(!looksBlocked('<html>'.padEnd(200000, 'x') + 'px-captcha', 'Product'));
  const nf = extractProduct('<title>Page Not Found | Store</title><h1>Oops</h1>');
  assert.equal(nf.status, STATUS.NOT_FOUND);
  assert.equal(extractProduct('<h1>Hello</h1>').status, STATUS.UNKNOWN);
});

test('search page link extraction (anchors + embedded JSON + slug names)', () => {
  const html = `<a href="/product/toys/311002-one-piece-op-18-booster-box">One Piece OP-18 Booster Box</a>
    <a href="https://www.store.com.au/product/toys/311003-op-18-sleeves?ref=x#top"><img alt="OP-18 Sleeves"></a>
    <a href="https://evil.com/product/toys/1-bad">bad</a>
    <a href="/cart">Cart</a>
    <script>window.__STATE__={"u":"\\/product\\/toys\\/311009-pokemon-ultra-premium-collection"}</script>`;
  const hits = extractProductLinks(html, 'https://www.store.com.au/search?q=x', /^\/product\/[^/]+\/\d+/);
  assert.equal(hits.length, 3);
  assert.equal(hits[0].name, 'One Piece OP-18 Booster Box');
  assert.equal(hits[1].name, 'OP-18 Sleeves');
  assert.equal(hits[1].url, 'https://www.store.com.au/product/toys/311003-op-18-sleeves');
  assert.match(hits[2].name, /Pokemon Ultra Premium Collection/);
  assert.equal(slugWords('/product/toys-and-collectibles/123-pokemon-tcg-etb'), '123 pokemon tcg etb');
});
