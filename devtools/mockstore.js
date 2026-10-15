// A fake retailer for testing and the demo — never touches a real store.
//
// It serves two shops from one server:
//   * "Demo Games": EB Games-style pages (/product/<cat>/<sku>-<slug>), a search
//     page, an AJAX add-to-cart with a mini-cart drawer, and a multi-step
//     checkout (guest step → shipping with address lookup → delivery → payment
//     with a cross-origin card iframe → Place order).
//   * "/shop": a Shopify-style store (/shop/products/<handle>.js, suggest.json,
//     cart permalinks, one-page checkout with "Pay now").
// A second server on another port serves the card iframe so it is cross-origin,
// like real payment providers.
//
// Control panel: open the store root (/) to restock / sell out / list products.

import http from 'node:http';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function defaultProducts() {
  return [
    { sku: '311001', name: 'Pokémon TCG: 30th Anniversary Celebration Ultra-Premium Collection', price: 189.95, status: 'out_of_stock', listed: false, jsonld: true },
    { sku: '311002', name: 'One Piece Card Game OP-18 Booster Box (24 Packs)', price: 159.0, status: 'out_of_stock', listed: true, jsonld: true },
    { sku: '311003', name: 'One Piece Card Game OP-18 Card Sleeves', price: 12.0, status: 'in_stock', listed: true, jsonld: true },
    { sku: '311004', name: 'Pokémon TCG: Elite Trainer Box', price: 79.95, status: 'in_stock', listed: true, jsonld: false },
  ];
}

function page(title, body, { head = '' } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px system-ui;margin:0;background:#fafafa;color:#222}header,footer{background:#222;color:#fff;padding:10px 20px}main{max-width:900px;margin:20px auto;padding:0 20px}
button,.btn{background:#d22;color:#fff;border:0;padding:10px 16px;border-radius:6px;font-size:15px;cursor:pointer;text-decoration:none;display:inline-block}
button[disabled]{background:#999;cursor:default}label{display:block;margin:8px 0}input,select{padding:6px;font-size:15px;width:320px;max-width:100%}
.drawer{position:fixed;right:0;top:0;bottom:0;width:320px;background:#fff;box-shadow:-4px 0 12px rgba(0,0,0,.2);padding:20px;display:none}.drawer.open{display:block}
.tile{display:inline-block;border:1px solid #ddd;padding:10px;margin:6px;width:200px;vertical-align:top}.err{color:#c00;font-weight:600}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center}</style>${head}</head>
<body><header><a href="/" style="color:#fff">Demo Games</a> · <a href="/cart" style="color:#fff">Cart</a> · <a href="/checkout" style="color:#fff">Checkout</a></header><main>${body}</main>
<footer>Demo Games is a fake store for testing TCGBot.</footer></body></html>`;
}

function productPath(p) {
  return `/product/toys-and-collectibles/${p.sku}-${slugify(p.name)}`;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
      } else resolve(Object.fromEntries(new URLSearchParams(data)));
    });
  });
}

const BUTTON = {
  in_stock: '<button type="button" id="atc" class="add-to-cart">Add to Cart</button>',
  preorder: '<button type="button" id="atc" class="add-to-cart">Pre-order Now</button>',
  out_of_stock: '<button type="button" class="add-to-cart" disabled>Sold Out</button>',
  coming_soon: '<button type="button" class="notify" disabled>Coming Soon</button>',
};
const LD_AVAIL = { in_stock: 'InStock', preorder: 'PreOrder', out_of_stock: 'OutOfStock' };

/**
 * @param {{port?: number, cardPort?: number, host?: string, products?: Array, blockNonBrowsers?: boolean}} opts
 */
export async function startMockStore({ port = 0, cardPort = 0, host = '127.0.0.1', products = defaultProducts(), blockNonBrowsers = false } = {}) {
  const state = {
    products: products.map((p) => ({ ...p })),
    cart: [],
    shipping: null,
    delivery: null,
    orders: [],
    challenge: false,
    blockNonBrowsers,
    requests: [],
    shopify: {
      products: [
        { id: 9001, handle: 'one-piece-op-18-booster-box', title: 'One Piece Card Game OP-18 Booster Box', tags: ['one piece'], variants: [{ id: 4400001, sku: 'OP18-BOX', price: 15900, available: false }] },
        { id: 9002, handle: 'pokemon-30th-ultra-premium-collection', title: 'Pokemon TCG 30th Anniversary Ultra Premium Collection', tags: ['pre-order'], variants: [{ id: 4400002, sku: 'PKM-UPC30', price: 18995, available: false }] },
      ],
      cart: [],
      checkout: null,
      orders: [],
    },
  };
  let cardOrigin = '';

  const find = (sku) => state.products.find((p) => p.sku === sku);

  // ------------------------------------------------------------------ card iframe server
  const cardServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/card-frame') {
      const style = u.searchParams.get('style') || 'stripe';
      const fields = style === 'shopify'
        ? '<input name="number" placeholder="Card number" inputmode="numeric"><input name="name" placeholder="Name on card"><input name="expiry" placeholder="Expiration date (MM / YY)"><input name="verification_value" placeholder="Security code" inputmode="numeric">'
        : '<input name="cardnumber" autocomplete="cc-number" placeholder="Card number" inputmode="numeric"><input name="exp-date" autocomplete="cc-exp" placeholder="MM / YY"><input name="cvc" autocomplete="cc-csc" placeholder="CVC" inputmode="numeric"><input name="ccname" placeholder="Name on card">';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui">${fields}
<style>input{display:block;margin:4px 0;padding:6px;width:260px}</style>
<script>
// Format like real payment widgets do.
for (const el of document.querySelectorAll('input')) {
  el.addEventListener('input', () => {
    if (/number|cardnumber/.test(el.name)) el.value = el.value.replace(/\\D/g,'').slice(0,16).replace(/(\\d{4})(?=\\d)/g,'$1 ');
    if (/exp/.test(el.name)) { const d = el.value.replace(/\\D/g,'').slice(0,4); el.value = d.length > 2 ? d.slice(0,2) + ' / ' + d.slice(2) : d; }
  });
}
</script></body></html>`);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // ------------------------------------------------------------------ store server
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    state.requests.push({ method: req.method, path: p, ua: req.headers['user-agent'] || '' });
    if (state.requests.length > 2000) state.requests.splice(0, 1000);
    const html = (status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const redirect = (to) => { res.writeHead(302, { location: to }); res.end(); };

    // Simulated bot protection for non-browser clients.
    if (state.blockNonBrowsers && !/Mozilla|Chrome/i.test(req.headers['user-agent'] || '') && !p.startsWith('/__admin')) {
      return html(403, '<html><head><title>Access Denied</title></head><body>Access Denied. Reference #18.abc123.1700000000</body></html>');
    }

    // ---------------- admin / control panel
    if (p === '/__admin/state') return json(200, { ...state, requests: undefined });
    if (p === '/__admin/set' && req.method === 'POST') {
      const b = await parseBody(req);
      const prod = find(b.sku);
      if (prod) {
        if (b.status) prod.status = b.status;
        if (b.price !== undefined) prod.price = Number(b.price);
        if (b.listed !== undefined) prod.listed = b.listed === true || b.listed === 'true';
      }
      if (b.challenge !== undefined) state.challenge = b.challenge === true || b.challenge === 'true';
      if (b.handle) {
        const sp = state.shopify.products.find((x) => x.handle === b.handle);
        if (sp && b.available !== undefined) sp.variants[0].available = b.available === true || b.available === 'true';
      }
      if (req.headers['content-type']?.includes('json')) return json(200, { ok: true });
      return redirect('/');
    }
    if (p === '/__admin/challenge') return json(200, { challenge: state.challenge });
    if (p === '/') {
      const rows = state.products.map((x) => `<tr><td><a href="${productPath(x)}">${esc(x.name)}</a></td><td>${x.listed ? 'listed' : '<i>not listed</i>'}</td><td><b>${x.status}</b></td><td>$${x.price.toFixed(2)}</td>
        <td>${['in_stock', 'preorder', 'out_of_stock', 'coming_soon'].map((s) => `<form method="post" action="/__admin/set" style="display:inline"><input type="hidden" name="sku" value="${x.sku}"><input type="hidden" name="status" value="${s}"><input type="hidden" name="listed" value="true"><button style="padding:4px 8px;font-size:12px;background:#444">${s}</button></form>`).join(' ')}</td></tr>`).join('');
      const shop = state.shopify.products.map((x) => `<tr><td><a href="/shop/products/${x.handle}">${esc(x.title)}</a> (Shopify)</td><td>listed</td><td><b>${x.variants[0].available ? 'available' : 'sold out'}</b></td><td>$${(x.variants[0].price / 100).toFixed(2)}</td>
        <td>${[true, false].map((a) => `<form method="post" action="/__admin/set" style="display:inline"><input type="hidden" name="handle" value="${x.handle}"><input type="hidden" name="available" value="${a}"><button style="padding:4px 8px;font-size:12px;background:#444">${a ? 'restock' : 'sell out'}</button></form>`).join(' ')}</td></tr>`).join('');
      return html(200, page('Demo Games control panel', `<h1>Demo Games — control panel</h1><p>This fake store exists so you can watch TCGBot work end to end. Change a product's status and watch the dashboard react.</p>
        <table border="1" cellpadding="6" style="border-collapse:collapse;background:#fff">${rows}${shop}</table>
        <p>Orders placed: ${state.orders.length + state.shopify.orders.length}</p>`));
    }

    // ---------------- Demo Games (generic) storefront
    const pm = p.match(/^\/product\/[^/]+\/(\d+)-/);
    if (pm) {
      const prod = find(pm[1]);
      if (!prod || !prod.listed) return html(404, page('Page not found', '<h1>Page not found</h1>'));
      const ld = prod.jsonld ? `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org', '@type': 'Product', name: prod.name, sku: prod.sku,
        ...(LD_AVAIL[prod.status] ? { offers: { '@type': 'Offer', price: prod.price.toFixed(2), priceCurrency: 'AUD', availability: `https://schema.org/${LD_AVAIL[prod.status]}` } } : {}),
      })}</script>` : '';
      const other = state.products.find((x) => x.sku !== prod.sku && x.listed);
      const challenge = state.challenge ? `<div class="overlay" id="chal"><iframe src="/fake/recaptcha/api2/bframe" width="400" height="500" style="background:#fff;border:0"></iframe></div>
        <script>setInterval(async()=>{const r=await fetch('/__admin/challenge').then(r=>r.json());if(!r.challenge)document.getElementById('chal')?.remove()},400)</script>` : '';
      return html(200, page(`${prod.name} | Demo Games`, `
        <div class="product-detail">
          <h1>${esc(prod.name)}</h1>
          <div class="price">$${prod.price.toFixed(2)}</div>
          <p>SKU ${prod.sku}</p>
          ${prod.qtyStyle === 'stepper'
    ? '<div class="qty-stepper">Qty <button type="button" aria-label="Decrease quantity" id="qminus">−</button> <span id="qval">1</span> <button type="button" aria-label="Increase quantity" id="qplus">+</button></div>'
    : prod.qtyStyle === 'none' ? '' : '<label>Qty <input name="quantity" type="number" value="1" min="1" style="width:60px"></label>'}
          <div id="buybox">${prod.lateMs ? '<p>Loading…</p>' : BUTTON[prod.status]}</div>
        </div>
        <section class="recommendations"><h3>You may also like</h3>
          ${other ? `<div class="tile"><a href="${productPath(other)}">${esc(other.name)}</a><button type="button" class="add-to-cart">Add to Cart</button></div>` : ''}
        </section>
        <div class="drawer" id="drawer"><h3>Added to cart</h3><p id="drawer-msg"></p><a class="btn" href="/checkout">Checkout</a> <a href="/cart">View cart</a></div>
        ${challenge}
        <script>
          ${prod.lateMs ? `setTimeout(() => { document.getElementById('buybox').innerHTML = ${JSON.stringify(BUTTON[prod.status])}; }, ${Number(prod.lateMs)});` : ''}
          const qval = document.getElementById('qval');
          document.getElementById('qplus')?.addEventListener('click', () => { qval.textContent = String(Math.min(5, Number(qval.textContent) + 1)); });
          document.getElementById('qminus')?.addEventListener('click', () => { qval.textContent = String(Math.max(1, Number(qval.textContent) - 1)); });
          document.addEventListener('click', async (e) => {
            if (!e.target.closest('#atc')) return;
            const inp = document.querySelector('input[name=quantity]');
            const qty = inp ? Number(inp.value || 1) : Number(qval ? qval.textContent : 1);
            const r = await fetch('/api/cart/add', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({sku:'${prod.sku}', qty})});
            const d = await r.json();
            if (d.ok && ${prod.drawer !== false}) { setTimeout(() => { document.getElementById('drawer-msg').textContent = d.count + ' item(s) in cart'; document.getElementById('drawer').classList.add('open'); }, 150); }
          });
        </script>`, { head: ld }));
    }
    if (p.startsWith('/fake/recaptcha/')) return html(200, '<html><body><h3>I\'m not a robot (fake)</h3></body></html>');

    if (p === '/search') {
      const q = (u.searchParams.get('q') || '').toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const hits = state.products.filter((x) => x.listed && words.some((w) => slugify(x.name).includes(slugify(w)) || x.sku === w));
      if (hits.length === 1 && hits[0].sku === q) return redirect(productPath(hits[0]));
      return html(200, page(`Search: ${q}`, `<h1>Results for "${esc(q)}"</h1>${hits.map((x) => `<div class="tile"><a href="${productPath(x)}">${esc(x.name)}</a><div>$${x.price.toFixed(2)}</div></div>`).join('') || '<p>No results</p>'}
        <script>window.__STATE__ = ${JSON.stringify({ results: hits.map((x) => ({ url: productPath(x) })) }).replace(/\//g, '\\/')};</script>`));
    }

    if (p === '/api/cart/add' && req.method === 'POST') {
      const b = await parseBody(req);
      const prod = find(b.sku);
      if (!prod || !prod.listed || !(prod.status === 'in_stock' || prod.status === 'preorder')) return json(409, { ok: false, error: 'unavailable' });
      state.cart.push({ sku: prod.sku, qty: Number(b.qty) || 1, price: prod.price });
      return json(200, { ok: true, count: state.cart.length });
    }
    if (p === '/cart') {
      const rows = state.cart.map((c) => `<li>${esc(find(c.sku)?.name)} × ${c.qty}</li>`).join('');
      return html(200, page('Your cart', `<h1>Your cart</h1><ul>${rows || '<li>Empty</li>'}</ul><a href="/" class="continue">Continue shopping</a> ${state.cart.length ? '<a class="btn" href="/checkout">Secure Checkout</a>' : ''}`));
    }
    if (p === '/checkout') return redirect('/checkout/login');
    if (p === '/checkout/login') {
      return html(200, page('Checkout', `<h1>Checkout</h1>
        <div style="display:flex;gap:40px"><form><h3>Sign in</h3><label>Email<input name="login_email" type="email"></label><label>Password<input name="pw" type="password"></label><button type="button">Sign In</button></form>
        <div><h3>New customer?</h3><a class="btn" href="/checkout/shipping">Continue as Guest</a></div></div>`));
    }
    if (p === '/checkout/shipping') {
      if (req.method === 'POST') {
        const b = await parseBody(req);
        const required = ['email', 'firstName', 'lastName', 'phone', 'street', 'suburb', 'state', 'postcode'];
        const missing = required.filter((k) => !b[k]);
        if (missing.length) return html(200, page('Shipping', `<p class="err">Missing: ${missing.join(', ')}</p><a href="/checkout/shipping">Back</a>`));
        state.shipping = b;
        return redirect('/checkout/delivery');
      }
      return html(200, page('Shipping details', `<h1>Shipping details</h1>
        <form method="post" id="ship">
          <label>Email address <input name="email" type="email" required></label>
          <label>First name <input name="firstName" required></label>
          <label>Last name <input name="lastName" required></label>
          <label>Mobile number <input name="phone" type="tel" required></label>
          <label for="lookup">Start typing your address</label><input id="lookup" name="addressLookup" placeholder="Start typing your address">
          <p><a href="#" id="manual">Enter address manually</a></p>
          <div id="manual-fields" style="display:none">
            <label>Street address <input name="street"></label>
            <label>Unit / apartment <input name="unit"></label>
            <label>Suburb <input name="suburb"></label>
            <label>State <select name="state"><option value="">Select state</option><option value="NSW">New South Wales</option><option value="VIC">Victoria</option><option value="QLD">Queensland</option><option value="WA">Western Australia</option><option value="SA">South Australia</option><option value="TAS">Tasmania</option><option value="ACT">Australian Capital Territory</option><option value="NT">Northern Territory</option></select></label>
            <label>Postcode <input name="postcode" maxlength="4"></label>
          </div>
          <label><input type="checkbox" name="news"> Send me news and offers</label>
          <button type="submit">Continue to delivery</button>
        </form>
        <script>document.getElementById('manual').addEventListener('click', e => { e.preventDefault(); document.getElementById('manual-fields').style.display='block'; for (const n of ['street','suburb','state','postcode']) document.querySelector('[name='+n+']').required = true; });</script>`));
    }
    if (p === '/checkout/delivery') {
      if (req.method === 'POST') {
        const b = await parseBody(req);
        if (!b.delivery) return html(200, page('Delivery', '<p class="err">Choose a delivery option</p><a href="/checkout/delivery">Back</a>'));
        state.delivery = b.delivery;
        return redirect('/checkout/payment');
      }
      return html(200, page('Delivery', `<h1>Delivery</h1><form method="post">
        <label><input type="radio" name="delivery" value="collect"> Click &amp; Collect (free)</label>
        <label><input type="radio" name="delivery" value="standard"> Standard Delivery $9.95</label>
        <label><input type="radio" name="delivery" value="express"> Express Delivery $14.95</label>
        <button type="submit">Continue to payment</button></form>`));
    }
    if (p === '/checkout/payment') {
      return html(200, page('Payment', `<h1>Payment</h1><form method="post" action="/checkout/place">
        <label><input type="radio" name="method" value="card"> Credit / debit card</label>
        <label><input type="radio" name="method" value="paypal"> PayPal</label>
        <label><input type="radio" name="method" value="afterpay"> Afterpay</label>
        <iframe id="card" src="${cardOrigin}/card-frame?style=stripe" width="320" height="190" style="border:1px solid #ccc"></iframe>
        <label class="terms"><input type="checkbox" name="terms" required> I agree to the Terms &amp; Conditions</label>
        <label><input type="checkbox" name="marketing"> Subscribe to our newsletter</label>
        <p>Total: $${(state.cart.reduce((s, c) => s + c.price * c.qty, 0) + 9.95).toFixed(2)}</p>
        <button type="submit" id="place">Place Order</button></form>`));
    }
    if (p === '/checkout/place' && req.method === 'POST') {
      const b = await parseBody(req);
      state.orders.push({ cart: state.cart.slice(), shipping: state.shipping, delivery: state.delivery, form: b, ts: Date.now() });
      state.cart = [];
      return redirect('/checkout/confirmation');
    }
    if (p === '/checkout/confirmation') return html(200, page('Order confirmed', `<h1>Thank you for your order!</h1><p>Order number: DG-${1000 + state.orders.length}</p>`));

    // ---------------- Shopify-style store under /shop
    if (p.startsWith('/shop')) {
      const sp = p.slice(5) || '/';
      const findH = (h) => state.shopify.products.find((x) => x.handle === h);
      const jsm = sp.match(/^\/products\/([^/]+)\.js$/);
      if (jsm) {
        const prod = findH(jsm[1]);
        if (!prod) return json(404, { error: 'not found' });
        return json(200, { ...prod, price: prod.variants[0].price, available: prod.variants.some((v) => v.available) });
      }
      const hm = sp.match(/^\/products\/([^/.]+)$/);
      if (hm) {
        const prod = findH(hm[1]);
        if (!prod) return html(404, page('404', '<h1>Page not found</h1>'));
        const v = prod.variants[0];
        return html(200, page(prod.title, `<h1>${esc(prod.title)}</h1><form action="/shop/cart/add"><input type="hidden" name="id" value="${v.id}"><button type="submit" name="add" ${v.available ? '' : 'disabled'}>${v.available ? 'Add to cart' : 'Sold out'}</button></form>`));
      }
      if (sp === '/search/suggest.json') {
        const q = (u.searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
        const hits = state.shopify.products.filter((x) => q.every((w) => slugify(x.title).includes(slugify(w))));
        return json(200, { resources: { results: { products: hits.map((x) => ({ title: x.title, handle: x.handle, url: `/shop/products/${x.handle}?_pos=1`, available: x.variants.some((v) => v.available), price: (x.variants[0].price / 100).toFixed(2) })) } } });
      }
      if (sp === '/products.json') {
        return json(200, { products: state.shopify.products.map((x) => ({ ...x, variants: x.variants.map((v) => ({ ...v, price: (v.price / 100).toFixed(2) })) })) });
      }
      const perm = sp.match(/^\/cart\/(\d+):(\d+)$/);
      if (perm) {
        const prod = state.shopify.products.find((x) => x.variants.some((v) => String(v.id) === perm[1]));
        if (!prod || !prod.variants[0].available) return html(200, page('Cart', '<h1>Some items are no longer available</h1>'));
        state.shopify.cart = [{ variant: Number(perm[1]), qty: Number(perm[2]) }];
        return redirect('/shop/checkouts/c/abc123');
      }
      if (sp === '/cart/add') {
        const prod = state.shopify.products.find((x) => x.variants.some((v) => String(v.id) === u.searchParams.get('id')));
        if (prod && prod.variants[0].available) state.shopify.cart.push({ variant: Number(u.searchParams.get('id')), qty: Number(u.searchParams.get('quantity') || 1) });
        return redirect('/shop/cart');
      }
      if (sp === '/cart') return html(200, page('Cart', `<h1>Cart</h1><p>${state.shopify.cart.length} item(s)</p><a class="btn" href="/shop/checkout">Check out</a>`));
      if (sp === '/checkouts/c/abc123') {
        if (req.method === 'POST') {
          const b = await parseBody(req);
          state.shopify.orders.push({ form: b, cart: state.shopify.cart.slice() });
          return redirect('/shop/checkouts/c/abc123/thank-you');
        }
        state.shopify.checkout = { opened: Date.now() };
        return html(200, page('Checkout - Demo Shop', `<h1>Checkout</h1><form method="post">
          <h3>Contact</h3><input name="email" type="email" autocomplete="email" placeholder="Email" required>
          <h3>Delivery</h3>
          <select name="countryCode" autocomplete="shipping country"><option value="AU" selected>Australia</option><option value="NZ">New Zealand</option></select>
          <input name="firstName" autocomplete="shipping given-name" placeholder="First name" required>
          <input name="lastName" autocomplete="shipping family-name" placeholder="Last name" required>
          <input name="address1" autocomplete="shipping address-line1" placeholder="Address" required>
          <input name="address2" autocomplete="shipping address-line2" placeholder="Apartment, suite, etc. (optional)">
          <input name="city" autocomplete="shipping address-level2" placeholder="Suburb" required>
          <select name="zone" autocomplete="shipping address-level1" required><option value="" disabled selected>State/territory</option><option value="ACT">Australian Capital Territory</option><option value="NSW">New South Wales</option><option value="VIC">Victoria</option><option value="QLD">Queensland</option></select>
          <input name="postalCode" autocomplete="shipping postal-code" placeholder="Postcode" required>
          <input name="phone" autocomplete="shipping tel" placeholder="Phone" type="tel">
          <h3>Shipping method</h3><label><input type="radio" name="shipping" value="standard" checked> Standard $10.00</label>
          <h3>Payment</h3><iframe src="${cardOrigin}/card-frame?style=shopify" width="320" height="200" style="border:1px solid #ccc"></iframe>
          <button type="submit" id="pay">Pay now</button></form>`));
      }
      if (sp === '/checkouts/c/abc123/thank-you') return html(200, page('Thank you', '<h1>Thank you for your purchase!</h1><p>Your order is confirmed.</p>'));
    }

    return html(404, page('Page not found', '<h1>Page not found</h1>'));
  });

  await new Promise((r) => cardServer.listen(cardPort, host, r));
  cardOrigin = `http://${host}:${cardServer.address().port}`;
  await new Promise((r) => server.listen(port, host, r));
  const url = `http://${host}:${server.address().port}`;

  return {
    url,
    cardOrigin,
    state,
    productUrl: (sku) => url + productPath(find(sku)),
    set(sku, fields) { Object.assign(find(sku), fields); },
    setShopify(handle, available) { state.shopify.products.find((x) => x.handle === handle).variants[0].available = available; },
    close: () => Promise.all([
      new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
      new Promise((r) => { cardServer.close(() => r()); cardServer.closeAllConnections?.(); }),
    ]),
  };
}

/** Retailer definition for the fake store (generic platform). */
export function demoRetailerSpec(url) {
  return {
    id: 'demo',
    name: 'Demo Games (fake store)',
    base: url,
    group: 'major',
    productPath: /^\/product\/[^/]+\/\d+/,
    skuFromPath: /^\/product\/[^/]+\/(\d+)/,
    searchPath: '/search?q={q}',
    cartPath: '/cart',
    checkoutPath: '/checkout',
    notes: 'A fake store running on your computer for trying TCGBot out.',
  };
}

export function demoShopifySpec(url) {
  return { id: 'demoshop', name: 'Demo Shop (fake Shopify)', base: `${url}/shop`, group: 'major', platform: 'shopify', hosts: [new URL(url).host], notes: 'A fake Shopify store running on your computer.' };
}
