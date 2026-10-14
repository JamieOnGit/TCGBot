# TCGBot — restock monitor & checkout assist

TCGBot watches Australian retailers for Pokémon TCG and One Piece Card Game
releases — including products that **aren't listed yet** and products that are
**sold out** — and alerts you the moment one becomes available. It then opens
your logged-in browser, adds the item to your cart, fills in checkout with your
saved details, and **stops on the final "Place order" button** for you to click.

Everything is controlled from a local dashboard at <http://127.0.0.1:8787>.

| Retailer | How it's checked |
|---|---|
| EB Games, Zing Pop Culture | product page, search for unlisted items |
| JB Hi-Fi, Toys"R"Us | Shopify product JSON (fast), page fallback |
| Kmart, Target, BIG W | product page; switches to a real browser window if the site refuses plain requests |
| Amazon AU | product page (ASIN as SKU), checked at most every 10s |
| Any other Shopify store | enter its domain (lots of local game stores use Shopify) |
| Any other website | paste a product link |

## ⚡ Quick Checkout (Tampermonkey panel)

The dashboard opens on **Quick Checkout**: a panel for your own browser
(through the Tampermonkey extension) that shows your product list on store
pages. When you press **Add to Bag → Checkout** on a product page, it clicks
Add to Bag, opens the bag and clicks Checkout. You finish the purchase yourself.
It only acts when you press the button, and it never refreshes pages by itself.

1. Start TCGBot (see Quick start below). The dashboard opens on the Quick Checkout tab.
2. Click **Install / update the userscript**, then **Install** in Tampermonkey.
   The first time the panel loads, Tampermonkey asks whether it may connect to
   `127.0.0.1`. Choose **Always allow** so the panel stays in sync with your list.
3. Click **Open ↗** next to a product, wait for the page to load, and press
   **Add to Bag → Checkout** in the panel (bottom right).

Your list comes preloaded with the Kmart Pokémon TCG 30th Celebration products
(UPCs first, then by price). Add, edit, hide or reorder products in the dashboard,
and open pages pick up changes while TCGBot is running. If TCGBot isn't running,
the panel uses the copy saved when you last installed the userscript, so
re-install it after big changes. "Added to bag" and "at checkout" events
show up in the dashboard and on Discord, if you've set it up.

## Quick start

1. Install **Node.js 20 or newer** (LTS) from <https://nodejs.org>.
2. Download this folder.
3. **Windows:** double-click `start-windows.bat`. **Mac:** double-click `start-mac.command`.
   (Or in a terminal: `npm run setup` once, then `npm start`.)
4. The dashboard opens in your browser.

**Try the demo first:** `npm run demo` runs TCGBot against a fake store on your
own computer. It plays out a drop — a new listing, a restock, pre-orders
opening — so you can watch the alerts and checkout assist work without touching
a real retailer.

## Setting up

1. **Profile & payment** — enter your shipping details. Optionally save a card;
   it's encrypted with your passphrase, and you unlock it once per session.
   (A card saved in your retailer account, or PayPal, works too.)
2. **Settings → Retailer logins** — open each store in the bot's browser and sign
   in once. The bot's browser remembers you, and checkout is much faster when
   you're logged in with your address saved.
3. **+ Add item** — choose a preset (e.g. *30th Anniversary Ultra-Premium
   Collection*, *OP-18 Booster Box*) or enter your own, pick the stores, and choose
   what happens when it's available:
   - **Alert me** — sound, desktop notification and Discord message.
   - **Add to cart** — alert + add it to your cart in the bot's browser.
   - **Checkout assist** — alert + add to cart + go through checkout filling in
     your details, then stop at *Place order / Pay now* for you to click.
4. Press **▶ Start monitoring**. Keep the dashboard tab open for sounds.

The **⚡ Go** button on any item runs add-to-cart and checkout immediately, e.g.
when you know a drop has just gone live.

### Finding products

- **Product link** — fastest and most precise, for products already listed.
- **SKU / product code** — EB Games' number, Kmart keycode, Amazon ASIN, etc. The
  bot finds the page through the store's search.
- **Keywords** — for unreleased products or several stores at once. The bot
  searches each store and locks on to the listing as soon as it appears.
  `one piece, op-18|op18, booster box|display` means *one piece* AND (*op-18* OR
  *op18*) AND (*booster box* OR *display*). Case, accents and dashes don't matter
  (`OP-18` = `op18`), but `op-1` won't match `op-18`. Put accessories in
  **Exclude** (sleeves, playmats…).

Use **Test link** and **Preview matches** in the form to see exactly what the
bot reads from a store before relying on it. Click any item's status to see the
signals behind it (structured data, buy button, stock message…).

## How it works

- **Stock detection** reads several independent signals from each page and
  trusts the most reliable one: schema.org structured data → product meta tags
  → stock messages → the buy button ("Add to cart", "Pre-order", "Sold out",
  "Coming soon", disabled or not). Recommendation carousels and site
  headers/footers are ignored. "In-store only" counts as out of stock.
- **Shopify stores** use the `/products/<handle>.js` endpoint and cart
  permalinks, which jump straight to checkout.
- **Politeness:** requests to the same site are spaced out (default 4s apart,
  however many items you watch there). Blocks and errors back off automatically.
  Plain requests identify as `TCGBot/1.0`. If a site refuses them, *Auto* mode
  switches that site to the bot's real browser window.
- **One trigger per restock:** an item fires once when it becomes available and
  re-arms when it sells out again. After you complete an order, the
  confirmation page is detected and the item pauses so it won't buy twice.

## What TCGBot deliberately leaves to you

- **CAPTCHAs, "are you human" checks and queues/waiting rooms.** The bot pauses,
  alerts you, and carries on automatically after you complete them.
- **Logging in, bank verification (3-D Secure), and the final purchase click.**
- **Purchase limits:** one account, the quantity you set. No proxies, no
  multiple accounts, nothing that hides it's automated.

Automated access may be against some retailers' terms of use, so use TCGBot for
your own purchases and keep the check interval reasonable (10–30s).

## Tests

```bash
npm test
```

There are 61 tests (they need Node.js 22+). They cover:
- HTML parsing and stock detection
- keyword matching (including the presets)
- form-field recognition
- the monitor engine over real HTTP
- the dashboard API, including the security checks
- the dashboard UI driven by a real browser
- the Quick Checkout userscript running in a real browser on the fake store, both through the "added to bag" popup and through the bag page
- **end-to-end checkout** in headless Chromium against the fake store

The end-to-end checkout tests cover:
- the steps: add to cart → guest checkout → shipping (with "enter address
  manually") → delivery choice → card typed into a cross-origin payment iframe →
  stop at *Place order*
- the Shopify one-page checkout
- add-to-cart mode
- CAPTCHA pause and resume
- the switch to the browser when a site blocks plain requests
- purchase detection
- a check that the bot never places an order itself

**Not covered by the tests:** the live retailer sites themselves. Their pages
change and sit behind bot protection, and testing checkout needs your accounts.
Before a big drop, do a dry run on each store you care about:
1. Add a cheap, in-stock item with **Checkout assist**.
2. Press **⚡ Go** and check that it reaches the *Place order* button.
3. Don't click it.

If a store's links or search change, fix the patterns in
`src/retailers/specs.js`. Each store is a few lines of data.

## Troubleshooting

- **"Blocked by site"** — the store refused the request. Leave the method on
  *Auto* (it switches to the browser), raise the interval, or log in to the store
  in the bot browser.
- **Status "Unknown"** — the page had no recognisable stock signals. Try **Test
  link** with the *Browser* method (Add item → Advanced).
- **Checkout stopped with "Needs you"** — the page asked for something the bot
  doesn't know (a new field, login, CAPTCHA). Finish that step in the browser
  window; the bot picks up again on the next page. Failures save a screenshot in
  `data/screenshots/`.
- **Browser won't start** — run `npm run setup`, or pick Google Chrome/Edge under
  Settings → Browser.

## Your data

Everything stays on your computer in `data/`:
- `state.json` — settings, profile and watchlist
- `vault.json` — the encrypted card (AES-256-GCM, scrypt key derived from your
  passphrase)
- `browser-profile/` — the bot browser's logins

The dashboard listens on 127.0.0.1 only and rejects requests from other websites.
