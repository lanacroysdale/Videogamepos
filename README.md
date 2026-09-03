# TimeLag Video Games — Website

Marketing site for **TimeLag Video Games** (Portland, OR — "Buy · Sell · Chill"). Built with
[Astro](https://astro.build) and deployed on [Vercel](https://vercel.com), per the project's
infrastructure plan (Cloudflare registrar → Vercel hosting → Supabase for the POS app).

## What's here

**Public marketing site** (`/`) — a long-scroll home page:

- **Hero** — glitch-3D headline, animated pixel field, and an auto-scrolling trust marquee.
- **About / "Why TimeLag"** (`#about`) — the quality-and-curation pitch.
- **Shop / eBay** (`#shop`) — the curated **eBay store** showcase + category chips.
- **Hangout Hub** (`#journey`) — the vision + a grand-opening **timeline**, and a
  **"Want Updates?"** newsletter signup.
- **Sell Your Games** (`#sell`) — an inline **cash-offer form** and a "how it works" panel.
- **Sell page** (`/sell`) — focused "how it works" steps, the contact form, and an FAQ.
- **404 page** — on-brand not-found page.
- **`/api/contact`** — a serverless endpoint that validates the forms and emails the lead
  (the newsletter, the cash-offer form, and the `/sell` contact form all post here).

**Point-of-sale app** (`/app`, employee login required — see the [POS app](#point-of-sale-app-app) section)

- **Dashboard** — customer type-ahead search, recent customers, open transactions, clock in/out, quick actions.
- **Checkout** — category tiles, searchable catalog (+ barcode auto-add), cart with per-item & whole-cart discounts, cash/card tender, change due, stock decrement.
- **Trade-In / Buy** — cash/credit offers from customizable margins, dynamic total redistribution, and PriceCharting/eBay/GameStop reference links.
- **Returns / refunds** — look up a sale by number, refund items to cash or store credit, manager approval past the return window.
- **Inventory** — search/sort/filter, one row per title with condition rows, inline price/quantity edits, **multiple barcodes** per item, add product.
- **Repairs** — create tickets (device, serial, customer, location, issue), track status.
- **Customers** — edit details/store credit/subscriptions; **merge** duplicate accounts (managers).
- **Schedule** — weekly shifts (managers assign) + time clock for everyone.
- **Reports** & **Pricing** (managers/owners only) — analytics charts; PriceCharting price-change review (approve/revert).
- **Phone scanner** (`/scan`) — pair any phone to a register with a 6-digit code and use its camera as a wireless barcode scanner on Checkout, Inventory (stock entry), and Trade-In. Works on iPhone Safari and Android Chrome; the phone shows what each scan matched.
- **Card / NFC quick login** plus email+password.
- Backed by **Supabase** (Postgres + Auth) with Row Level Security and **per-employee** access control (cashiers see only their own transactions; reports/pricing are manager-only).

## Edit the content

Almost everything you'll want to change lives in **`src/consts.ts`**:

- Shop name, tagline, email, phone, location
- **`EBAY.storeUrl`** — 👉 set this to your real eBay store link
- Navigation links and the eBay category chips

Look for `TODO` comments for the handful of values to confirm (domain, eBay URL/username).

## Run it locally

You need [Node.js](https://nodejs.org) 18.17+ (LTS recommended). Then:

```bash
npm install      # first time only
npm run dev      # start the dev server → http://localhost:4321
```

Other scripts:

```bash
npm run build    # production build into dist/
npm run preview  # preview the production build
npm run check    # type-check the project
```

## Make the contact forms deliver email

The forms work immediately — but until email is configured, submissions are just
**logged to the server console** (so nothing is lost). To deliver real emails:

1. Create a free account at [resend.com](https://resend.com) and make an API key.
2. Copy `.env.example` to `.env` and fill in `RESEND_API_KEY`.
3. (Optional) Verify your domain in Resend, then set `CONTACT_FROM` to an address
   on that domain (e.g. `TimeLag Video Games <hello@timelag.co>`). Until then the
   included Resend test sender works for trying it out.

Leads are sent to `CONTACT_TO_EMAIL` (defaults to `timelaggaming@gmail.com`).

## Point-of-sale app (`/app`)

The POS app needs a database (Supabase). For local development it runs Supabase
on **Docker**; for production you point it at a free Supabase cloud project.

### Run the app locally

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) running.

```bash
npm install
npm run db:start         # boots local Supabase in Docker (first run pulls images)
npm run db:setup         # applies the schema migration + seeds demo data
npm run dev              # http://localhost:4321  →  visit /app
```

`db:setup` is `db:reset` (apply `supabase/migrations`) + `db:seed`
(`scripts/seed.mjs`). Re-run `npm run db:seed` any time to reset the demo data.

The local Supabase keys are already in `.env`. Other DB scripts: `npm run db:stop`,
`npm run db:reset`, `npm run db:types` (regenerate TypeScript types).

### Demo logins (local dev only)

`npm run db:seed` creates three local demo employees (owner / manager / cashier)
on your **local** Supabase. The password is printed in the seed output (or set
`SEED_PASSWORD` in `.env` to pin it). These accounts and password are for local
development only — **never provision them in production.** Card codes also work
via the **Sign in with card** option (and Web NFC on supported devices).

### Going to production (cloud Supabase)

1. Create a free project at [supabase.com](https://supabase.com).
2. Link and push the schema: `npx supabase link --project-ref <ref>` then
   `npx supabase db push`. (Seed your own data, or adapt `scripts/seed.mjs`.)
3. In **Supabase → Project Settings → API**, copy the Project URL and the
   `anon` and `service_role` keys.
4. Add them as Vercel env vars (next section): `PUBLIC_SUPABASE_URL`,
   `PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
5. In **Supabase → Authentication → URL Configuration**, set the **Site URL** and
   redirect URLs to your production domain.
6. Create your real employee logins in the Supabase Auth dashboard (the
   `profiles` row + role is created automatically; set roles to `owner`/`manager`).

> Note: the public marketing site does **not** need Supabase. If you deploy without
> these vars, the site works, but `/app` and `/api/pos/*` will error until they're set.

## Deploy to Vercel

1. Push this repo to GitHub and merge to your default branch (`main`).
2. In Vercel, **Add New → Project** and import the repo. Vercel auto-detects Astro;
   no build settings needed.
3. Add your environment variables under **Project → Settings → Environment Variables**:
   - Contact forms: `RESEND_API_KEY`, `CONTACT_TO_EMAIL`, `CONTACT_FROM`
   - POS app (optional): `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
4. Point your Cloudflare domain's DNS at Vercel. Every `git push` now auto-deploys.

The repo already targets `https://timelag.co` for canonical URLs and the
sitemap (`astro.config.mjs` `site`, `public/robots.txt`, and `src/consts.ts`). If you
use a different domain, update those three spots.

## Project structure

```
src/
  components/   Header, Footer, Hero, Features (About), EbaySection (Shop),
                Journey (Hangout + timeline + newsletter), SellSection (cash offer),
                Steps, ContactForm
  layouts/      Layout.astro (marketing), AppLayout.astro (POS shell)
  lib/          supabase.ts (SSR client), types.ts, money.ts
  middleware.ts auth + route protection + RBAC for /app and /api/pos
  pages/
    index.astro, sell.astro, 404.astro
    api/contact.ts
    api/pos/      customers, checkout, trade-in, return, inventory, repairs,
                  clock, shifts, pricing, customer, merge-customers, card-login
    app/          login, logout, index (dashboard), checkout, trade-in, returns,
                  inventory, repairs, customers, schedule, reports, pricing
  styles/       global.css (shared brand system + marketing), app.css (POS)
  consts.ts     ← marketing-site content / config you edit
supabase/       migrations/ (schema — two migrations)
scripts/        seed.mjs (demo data)
public/         favicon.svg, og-default.svg, robots.txt, logo + storefront assets
```

## Notes / next steps

- `public/og-default.svg` is the social-share image. For best compatibility across
  every platform, export a **1200×630 PNG** version and point `image` in
  `src/layouts/Layout.astro` at it.
- **PriceCharting sync** simulates market moves until you set `PRICECHARTING_API_TOKEN`
  (then wire the real lookup in `src/pages/api/pos/pricing.ts`). The manager review
  workflow (approve/revert) is fully built.
- **Card/NFC login** maps a card code → employee. Web NFC works on supported devices
  (Chrome/Android); elsewhere staff type/scan the code.
- **Phone scanner** decoding uses the browser's native `BarcodeDetector` where it reads
  retail codes (Chrome/Android) and otherwise a bundled ZXing WebAssembly decoder
  (`barcode-detector` + `zxing-wasm`, ~1 MB, loaded only on first camera use) — so
  iPhones work too. Pairing rides on Supabase Realtime broadcast (`src/lib/scanChannel.ts`);
  register pages adopt it via `src/lib/scanReceive.ts` and can pass `describe()` so the
  phone shows what each scan matched. The camera needs HTTPS (or `localhost`).
