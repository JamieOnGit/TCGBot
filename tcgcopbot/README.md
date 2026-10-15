# TCGCopBot

The hosted, multi-user version of TCGBot's Quick Checkout, with restock alerts.
You run it on a server; customers sign up, start a free trial, subscribe, and get
their **own private** dashboard:

- **⚡ Quick Checkout** — your own product list with a quantity per product. **⚡ Buy**
  opens the product, and the browser extension adds it to the bag, goes to
  checkout and fills in your details. It stops at the final button (**Checkout
  securely**, **Place order**…), which you press yourself.
- **Watchlist** — restock and pre-order alerts in the dashboard, on Discord and by
  email.
- **Delivery details**, **Alerts**, **Activity**, **Billing** (Stripe) and **Account**
  (change password, download my data, delete account).
- **Browser extension** — connects to the account with one click. The card is kept
  in that browser only.
- **Admin page** (for you) — customers, plans, free access, trial extensions,
  suspensions and an audit log.

## Whose data is where

Everything personal belongs to one login. Every database row carries its owner's
ID, every query is filtered by it, and the tests check that one account can't
reach another's data in any way the API allows.

| Data | Stored | Who can see it |
|---|---|---|
| Email, name, plan | Server database | The customer; admins (to give support) |
| Password | scrypt hash only | Nobody |
| Delivery details (address, phone, checkout email) | Server, **encrypted with a key unique to that customer** | The customer and their connected extension |
| Alert settings (Discord webhook, email choices) | Server, encrypted per customer | The customer |
| Quick Checkout list, watchlist, activity, connected browsers | Server, tied to the customer | The customer (admins see counts only) |
| **Payment card** | **Only in the customer's browser extension**, encrypted with their passphrase and filed under their account | The customer. It's never sent to the server. |
| Subscription payments | Stripe | The customer; you, in Stripe |

- If a different account connects the same browser, it can't see or use the first
  account's card.
- ⚡ Buy codes only work for the account that made them: once, within 2 minutes.
- Deleting an account deletes all of its data and its encryption key, so any copy
  left in a backup can't be read.

## Same guardrails as TCGBot

- **The customer always presses the final purchase button.** TCGCopBot never places
  an order.
- **No CAPTCHA, queue or bot-protection bypassing, and no hidden automation.**
  Restock checks say `TCGCopBot/1.0` in their User-Agent. A store that refuses them
  is shown as "Blocked by site" and checked less often.
- **Store purchase limits are respected.** One account, the quantity the store
  allows, no proxies.

## Try it on your computer

You need Node.js 22.13 or newer.

```bash
cd tcgcopbot
cp .env.example .env        # optional; the defaults work locally
npm start                   # http://localhost:8080
```

1. Sign up. To get admin access, put your email in `ADMIN_EMAILS` in `.env` first.
2. On the **Extension** tab, download the extension and unzip it.
3. Open `chrome://extensions`, turn on **Developer mode**, and **Load unpacked** the
   unzipped folder.
4. Reload the dashboard and press **Connect this browser**.
5. Fill in **Delivery details**. Optionally save a card in the extension
   (toolbar icon → **Card settings**).
6. Set a quantity and press **⚡ Buy**.

Without Stripe keys, everyone stays on the free trial, and you can give free
access from the admin page. Without an email provider, password-reset links are
printed in the server log.

## Go live

### 1. Deploy (Fly.io, Sydney)

```bash
cd tcgcopbot
fly launch --no-deploy --copy-config          # pick your app name; update `app` in fly.toml
fly volumes create tcgcopbot_data --region syd --size 1
fly secrets set DATA_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  BASE_URL=https://<your-app>.fly.dev ADMIN_EMAILS=you@example.com SUPPORT_EMAIL=support@yourdomain.com
fly deploy
```

**Save `DATA_ENCRYPTION_KEY` in your password manager.** If it's lost or changed,
customers' saved delivery details can't be read any more.

For your own domain: `fly certs add app.yourdomain.com`, add the DNS records it
shows, then set `BASE_URL=https://app.yourdomain.com`. Also set
`EXTRA_ORIGINS=https://<your-app>.fly.dev` if you keep using the fly.dev address.

**Render instead:** `render.yaml` is a Blueprint. Render looks for it at the root
of the repository, so move it there (or give its path when you create the
Blueprint). Fill in the variables marked `sync: false`. Render needs a paid
instance for the persistent disk.

Run **one** server instance, because the database is a single SQLite file on
the volume. Fly snapshots volumes daily. For an extra backup, copy
`/data/tcgcopbot.db` (for example with `fly ssh sftp get /data/tcgcopbot.db`).

### 2. Payments (Stripe)

1. In Stripe, create a **Product** with a recurring **Price** (e.g. A$19/month).
   Copy the price ID (`price_…`).
2. Under **Developers → API keys**, copy the secret key (`sk_live_…`; use
   `sk_test_…` while testing).
3. Under **Developers → Webhooks**, add the endpoint
   `https://<your address>/api/billing/webhook` with these events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`

   Copy the signing secret (`whsec_…`).
4. Under **Settings → Billing → Customer portal**, turn on cancelling and updating
   payment methods.
5. Set the keys:
   ```bash
   fly secrets set STRIPE_SECRET_KEY=sk_… STRIPE_PRICE_ID=price_… STRIPE_WEBHOOK_SECRET=whsec_… PRICE_DISPLAY="A\$19 / month"
   ```

A customer who subscribes during their trial keeps the rest of the trial, then
billing starts. Payment-failed accounts keep access while Stripe retries.
Cancelled accounts keep their data but lose ⚡ Buy, autofill and alerts until they
subscribe again.

### 3. Email (Resend)

Create an account at resend.com, verify your domain, then:
`fly secrets set RESEND_API_KEY=re_… EMAIL_FROM="TCGCopBot <alerts@yourdomain.com>"`.
This turns on password resets and email alerts.

### 4. The extension for your customers

- **To start:** customers download it from their dashboard (**Extension** tab). It
  comes already set up for your server address. They load it with Developer mode,
  as above.
- **Chrome Web Store (recommended for selling):** run
  `BASE_URL=https://app.yourdomain.com npm run build:extension` and upload
  `dist/tcgcopbot-extension.zip` in the Chrome Web Store developer console
  (one-time US$5 fee). Then:
  - **Privacy:** declare that it handles personal info (address) and financial
    info (card, stored only on the device).
  - **Single purpose:** "checkout assist for the user's own TCGCopBot account".
  - **Permissions:** `storage` holds the connection and the encrypted card. The
    store sites are where the extension fills in checkout. The server address is
    the customer's account.
  - Once it's approved, set `CHROME_STORE_URL` so the dashboard shows an
    **Add to Chrome** button.

  Bump `version` in `extension/manifest.json` with every update. The dashboard
  tells customers when their copy is out of date.

### 5. Before you sell — checklist

- [ ] Have a lawyer review `web/terms.html` and `web/privacy.html` and fill in the
      [bracketed] parts: business name, ABN, state, hosting region.
- [ ] Register for GST if your turnover will reach A$75,000. Stripe Tax can
      help.
- [ ] Understand the risk: retailers' terms of use may prohibit automated tools.
      They can change their sites, block checks, or cancel orders. Don't
      promise anyone they'll get stock.
- [ ] Do a test run on each store you advertise, with a cheap in-stock item. Stop
      at the final button.
- [ ] Set `SUPPORT_EMAIL` and make sure someone reads it.
- [ ] Back up `DATA_ENCRYPTION_KEY` and the database.

## Running it

- **Admin page:** `/admin`. Here you can search customers, change plans (`comped` =
  free access), extend trials, suspend accounts, sign customers out everywhere,
  or delete an account (this also cancels their subscription). Every change is
  written to the audit log. Personal details are never shown there.
- **Make someone admin later:** add them to `ADMIN_EMAILS` (applies at their next
  login), or run `npm run make-admin -- them@example.com` on the server.
- **Restock monitor:** each product page is checked once per
  `MONITOR_URL_INTERVAL` (60s), however many people watch it, with at least
  `MONITOR_HOST_GAP` (5s) between requests to the same store. Only pages that
  someone with an active plan is watching get checked. Links pointing at private
  or internal addresses (localhost, cloud metadata, your own network) are
  refused, including through redirects.
- **Logs:** `fly logs`.
- **Limits per customer:** 50 products, 25 watched pages and 5 browsers. Change
  them with `MAX_PRODUCTS`, `MAX_WATCH_ITEMS` and `MAX_DEVICES`.

### Growing

One small instance handles thousands of customers. Before you run several
instances behind a load balancer, three things need to change:
- move the database to Postgres
- move the rate limits and the live-update hub (now in memory) to Redis
- run the restock monitor as a single separate worker

## Tests

```bash
cd tcgcopbot
npm test          # needs Playwright's Chromium (npx playwright install chromium)
```

There are 57 tests:
- **Accounts:** sign-up and login, sessions and logout, cross-site request
  blocking, rate limits, password reset and change, export, deletion.
- **Isolation between customers:** lists, delivery details (including copying
  encrypted data between accounts), watchlists, alert settings, activity, live
  alerts, extension devices, ⚡ Buy codes, pairing codes, and what admins can see.
- **Billing:** a fake Stripe that checks Checkout, the portal, webhook signatures
  and replays, plan changes, payment failures, cancellation, trial expiry, and
  admin actions.
- **Restock monitor** against a fake store:
  - one request per page
  - the honest User-Agent
  - alerts only to watchers with an active plan
  - price limits
  - Discord and email delivery
  - backing off when blocked, and recovering
  - refusing links to private or internal addresses
- **Real extension in Chromium:**
  - sign up and connect with one click
  - save the card (encrypted, never sent to the server)
  - ⚡ Buy with quantity 2 through a Kmart-style checkout that stops at "Checkout
    securely" without pressing it
  - a second account on the same browser can't use the first account's codes or
    card
  - disconnecting from the dashboard signs the extension out
- **Website in a browser:** every dashboard tab, the admin page, phone-sized
  screens, and no JavaScript errors or blocked scripts.

## Layout

```
server/          Node server (no npm packages at runtime)
  app.js         routing and security checks     repo.js   all per-user data access
  db.js          SQLite schema                   crypto.js passwords, tokens, per-user encryption
  billing.js     Stripe                          monitor/  restock checks (shared page parser from TCGBot)
  routes/        auth, user, ext (extension API), billing, admin, pages
web/             landing page, sign-in pages, dashboard, admin, terms, privacy
extension/       the browser extension (built per server by server/extension.js)
scripts/         build-extension, make-admin, make-icons
devtools/        the fake store used by the tests
test/            node:test + Playwright
```
