# TCGBot — restock monitor & checkout assist

TCGBot watches Australian retailers for Pokémon TCG and One Piece Card Game
releases — including products that **aren't listed yet** and products that are
**sold out** — and alerts you the moment one becomes available. It then opens
your logged-in browser, adds the item to your cart, fills in checkout with your
saved details, and **stops on the final "Place order" button** for you to click.

Everything is controlled from a local dashboard at <http://127.0.0.1:8787>.

> **TCGCopBot** — the hosted, multi-user version you can sell (sign-up, a private
> dashboard per customer, Stripe subscriptions, admin page, browser extension that
> connects to each customer's own account) — lives in [`tcgcopbot/`](tcgcopbot/README.md).

| Retailer | How it's checked |
|---|---|
| EB Games, Zing Pop Culture | product page, search for unlisted items |
| JB Hi-Fi, Toys"R"Us | Shopify product JSON (fast), page fallback |
| Kmart, Target, BIG W | product page; switches to a real browser window if the site refuses plain requests |
| Amazon AU | product page (ASIN as SKU), checked at most every 10s |
| Any other Shopify store | enter its domain (lots of local game stores use Shopify) |
| Any other website | paste a product link |

## ⚡ Quick Checkout

The dashboard opens on **Quick Checkout**: TCGBot's own button for your
normal browser. On a product page, one press does **Add to Bag → Bag →
Checkout**, then you finish the purchase yourself. It only acts when you press
it and never reloads pages by itself. Use either option:

**Option 1 — TCGBot browser extension** (Chrome, Edge, Brave, Arc, Opera)
1. Go to `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**, click **Load unpacked**, and choose the
   `extension` folder inside your TCGBot folder. The dashboard shows the exact path.
3. In the dashboard, set the **Qty** next to a product and press **⚡ Buy**. A new
   tab opens the product, and the extension sets the quantity, adds it to your bag
   and goes to checkout by itself. You can also open a product and press **Add to
   Bag → Checkout** in the panel bottom right. If the store goes to the bag page,
   the extension carries on to checkout by itself.

After adding to bag, the extension carries on through checkout (Kmart:
**Continue to details → Continue to delivery → Continue to payment**). It keeps
whatever the store already filled in from your account and fills empty fields
from **Profile & payment**: your address, home delivery, and card payment with
your card's number, expiry and CVV (if the card is unlocked). It also fills card
boxes inside the payment provider's frame. It then stops with the final button
(**Checkout securely**, Place order, Pay now…) highlighted. **TCGBot never
presses that button — you do.** It never ticks marketing boxes (e.g. Kmail).

Each **⚡ Buy** press creates a one-time code (valid for 2 minutes) that the
extension checks with your dashboard before starting, so no other website can
trigger an add-to-bag. Your address and card go to the extension only with the
short-lived pass that code unlocks, only for that store's tab, and they're
never saved in the browser.

Quantity is set with the page's quantity box or its +/− buttons. If the product
page has neither, it's set in the bag before checkout. If the store caps the
quantity (e.g. 2 per customer), it adds the maximum and tells you.

The panel sits small in the top-left corner. Drag it by its title to move it
(it remembers where), or press – to shrink it. The Quick Checkout tab shows
whether this browser has the extension and whether it's up to date. **After
updating TCGBot, remove the extension and Load unpacked again** (or press ↻ on it
in `chrome://extensions`), then reload your store tabs.

The extension uses your dashboard's product list and reports "added to bag" and
"at checkout" back to it, and to Discord if you've set it up. If TCGBot isn't
running, it uses the last list it saw. If you start TCGBot on a port other than
8787, set the port in the extension's toolbar popup.

**Option 2 — Bookmark button** (Safari, Firefox, any browser)
1. Show your bookmarks bar (Safari: View → Show Favourites Bar).
2. Drag **⚡ TCGBot Checkout** from the dashboard onto the bar.
3. On a product page (use **Open ↗** or **⚡ Buy** in the dashboard), click the
   bookmark. It sets your quantity, adds to bag and goes to checkout. If the store
   shows the bag page instead of a checkout popup, click it once more there.

The bookmark contains your list as it was when you dragged it, so drag it again
after you change the list.

Your list comes preloaded with the Kmart Pokémon TCG 30th Celebration products
(UPCs first, then by price). Add, edit, hide or reorder them on the Quick
Checkout tab.

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

There are 75 tests (they need Node.js 22+). They cover:
- HTML parsing and stock detection
- keyword matching (including the presets)
- form-field recognition
- the monitor engine over real HTTP
- the dashboard API, including the security checks
- the dashboard UI driven by a real browser
- Quick Checkout: the real extension loaded into Chromium, and the bookmark button, both run on the fake store. Covers ⚡ Buy from the dashboard with a quantity (quantity box, +/− buttons, set in the bag, store limits), slow-loading pages, the "added to bag" popup, the bag page, refusing made-up codes, and a Kmart-style checkout (details → delivery → payment, card in the page or in a payment iframe, card locked) that stops at "Checkout securely" without pressing it
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
