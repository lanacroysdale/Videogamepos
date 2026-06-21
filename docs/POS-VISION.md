# TimeLag — Unified Commerce Platform (POS + Website)

> Single source of truth for the product vision, data model, and build plan.
> Living doc — update it as decisions change. Doubles as the future licensing/onboarding reference.

---

## 1. North star

One system, two front-ends:

- **In-store POS** (`/app`) and the **public website** (`/`, `/shop`) run on **one shared Supabase database**.
- A product's edit screen **is** the single source of truth: change a price, condition, barcode, or publish flag and it updates the register, the trade-in desk, **and** the website at once. There is no POS↔site "sync" to build or break.
- **Inventory is one stock pool.** Sell in store → it disappears from the site; sell online → in-store stock drops. The only hard part is making the stock decrement concurrency-safe (no double-selling).

### License-ready by design
This POS is intended to be **licensed to other stores** later. We are **not** building multi-tenancy now, but every choice keeps the door open cheaply:

1. **Features live in a settings table**, not in code (`store_settings`). "Some stores want it, some don't" → a flag.
2. **Business rules are data**, not hardcoded (config/rules tables): pricing rules, trade margins, promotions, rewards, condition taxonomy, tag definitions.
3. **Never hardcode "the one store"** — so a `store_id`/`org_id` can slot in later with no rewrite.
4. **The website-facing surface is a clean, read-only catalog** — the licensee's "connect a site" seam, and what keeps cost/internal data from leaking.

**Tenant model (deferred decision):** one Supabase project per licensee (simplest; the current env-var-driven code already supports it) vs. one shared multi-tenant DB with `store_id` + RLS. The four habits above let us pick either later.

---

## 2. Current state (all local / unpushed unless noted)

### Built & verified this work
- **Leads inbox** — public `Sell` form → `sell_request` lead, `Join the Club` signup → `free_club` lead; staff-only inbox at `/app/leads` with status workflow, convert-to-customer, nav badge, and in-app desktop-notification poller. Email notification once Resend is configured.
- **Hidden shop** — `/shop`, SSR, `noindex` + robots Disallow + sitemap-excluded, reads published in-stock variants from shared inventory.
- **POS "Publish to web" toggle** — per-variant `online_visible` (+ optional `online_price_cents`) edited from the inventory screen; flows straight to the shop.
- **Inventory redesign v1** — responsive, info-rich product cards (cover, tags, per-condition chips, web status) + a unified edit modal (product fields, per-condition pricing/web grid, barcodes, view-on-website). Edits apply to POS + website in one save.
- **Site IA cleanup** — route-aware nav with active state, dedicated `/about` page, `#shop`→`#ebay` rename (frees "shop" for the real catalog).
- **Login hardening** — removed prefilled demo creds + the demo-logins block from `/app/login`.

### Already in the codebase (pre-existing)
- POS core: `products` → `product_variants` → `product_barcodes`; `categories`; `transactions` + `transaction_items`; `trade_margins`; `sales_report_items` view.
- Phase 2: employee **card/keycard login** (`profiles.card_code`); **repairs**, **shifts**, **time_entries**; **price_changes** (manager review of auto price changes); `merge_customers()` RPC.
- Auth middleware gating `/app` + `/api/pos`; roles owner/manager/cashier.
- **Returns** with manager approval past the window; **trade-in** with total-offer redistribution + PriceCharting/eBay/GameStop links; **open/suspended transactions** (shared across registers via one DB); checkout per-line + whole-cart discounts; customer **points / store credit / membership** fields; inventory + customer search.

### Cloud DB state
- Project `haeptwngswpokfngxffb`. Migrations applied: `leads`, shop columns (`online_visible`, `online_price_cents`, `products.image_url`, `products.description`). 12+ demo products published to the shop.

---

## 3. Data model

### Identity & customers
- `customers` (staff-created today). **Planned:** `auth_user_id` linking a self-registered online shopper to their in-store record (claim-by-email on confirmation), `is_customer()` predicate, own-row RLS so a customer reads only their own data and never POS data.

### Catalog
- **Product** (shared across all conditions): title, platform, franchise, genre, rating; **planned** cover image(s), description, trailer URL, release year, alternative names (for search), flexible **tags**.
- **Variant** (one per condition): completeness × grade (see below), price, online price, cost, quantity, `online_visible`, **planned** `restocked_at`, optional grade/cert fields (sealed/graded).
- **Identifiers per variant:** one auto-generated **unique internal label code** (condition-encoded, e.g. `C3S045496599720`) printed on the price label and scanned to pull the exact variant; **plus many** external barcodes/UPCs and alt-SKUs. Scanning any identifier resolves to the exact variant. *(Generalize today's single `sku` + `product_barcodes`.)*

### Condition = two configurable axes
Stored as two axes **always** (clean data/filters); **presented** combined (one picklist) or separate (two pickers) per a `store_settings` flag.
- **Completeness** — `L` loose · `CIB` complete-in-box · `IB` in box (no manual) · `New`. Store-editable list. **Per-category default** (Switch→CIB, SNES→loose, Super Famicom→CIB…).
- **Grade** — 1★ poor · 2★ fair · 3★ great · 🌙 mint. Store-editable list with icons. Optionally not-applicable for some completeness levels (e.g. New).
- Each taxonomy entry carries **display rules**: badge label/color, optional **thumbnail banner** (e.g. `IB` → "No manual" over the cover), and a "use as search filter" flag.

### Tags & collections
- Flexible tag system (region-free, import, graded, rare…) for rich filters.
- **Collections are saved filters/rules**, not duplicated products or hardcoded categories:
  - "Factory Sealed" = `completeness = New` (sealed)
  - "Certified Open Box" = `completeness in (CIB, IB)`
  - "No manual" filter = `completeness = IB`
  - "New Arrivals (48h)" = `restocked_at > now() - 48h`

### Transactions & inventory
- One `transactions` table for every sale. **Planned** `channel` (`in_store`/`online`, default in_store) and a separate online-only `fulfillment` lifecycle.
- One stock pool (`product_variants.quantity`). **Planned:** atomic, oversell-safe decrement RPC (fixes the existing race) + a `stock_movements` ledger (reason: sale/return/receive/manual; powers New Arrivals and audit) + `stock_holds` for online carts.

### Settings
- `store_settings` — feature flags & store config (condition pricing on/off, combined-vs-separate condition entry, per-category defaults, enrichment provider/key, receipt config, etc.).

---

## 4. Subsystems & status

| Area | Status | Notes |
|---|---|---|
| Inventory management (rich, responsive, unified edit) | ✅ v1 | Card list + edit modal; per-condition pricing/web grid |
| Leads inbox + notifications | ✅ | Email (needs Resend) + in-app desktop alerts |
| Hidden shop | ✅ | Browse-only, reads shared inventory |
| Publish-to-web toggle | ✅ | Per variant |
| Site IA (nav/about/shop rename) | ✅ | Sell consolidation still owner's call |
| Returns w/ manager approval | ✅ pre-existing | |
| Trade-in (margins, redistribution, links) | 🟡 pre-existing | Extend: per-category/franchise margins, sales-history-at-a-glance, per-condition price edit |
| Employee keycard login / open transactions | ✅ pre-existing | |
| **Catalog foundation** (settings, condition axes, tags, identifiers, restock) | ✅ | `store_settings`, `completeness_levels`×`condition_grades`, `internal_code`, `product_skus`, `stock_movements`, restock trigger |
| **Condition-based pricing engine** | ✅ | Settings-gated (`condition_pricing_enabled`) + multipliers (rules-as-data); `reprice_product()` RPC; wired into the edit modal's ↻ button |
| **Smart find-or-create entry** | ✅ | Shared `src/lib/smartSearch.ts` parser used by BOTH inventory (find-or-create) and trade-in (typeahead + catalog-suggested resale). Alias/fuzzy, structured-config-driven |
| **Image upload + auto-enrichment** | 🔜 | Supabase Storage; IGDB cover/description/trailer + alt-names |
| **Product detail page + SEO** | ✅ | `/shop/[slug]` SSR + indexable, Product JSON-LD, auto description + YouTube trailer, condition/price, reserve CTA. Hub + POS "View on website" link here. Gated behind login pre-launch (SEO activates when the /shop gate is removed at launch) |
| **Filters & collections** | 🔜 | Saved filters over metadata (Factory Sealed, No Manual, New Arrivals) |
| Online accounts + unified history | 🔜 P2 | `auth_user_id`, `/account`, own-row RLS |
| Online checkout | 🔜 P3 | Cart, Stripe, atomic order RPC, holds, fulfillment |
| Promotions / sales engine | 🔜 | in-store vs online, %-off, date windows, B2G1, price-range tiers |
| Loyalty / rewards | 🔜 | Earn points per $, redeem as credit/points |
| Hardware/printing | 🔜 | Scan-in, barcode label printer, configurable receipts |
| Customer merge UX | 🟡 | `merge_customers()` exists; rebuild the flow |
| Multi-location sales-based pricing | 🔜 | Needs a locations concept |

---

## 5. Critical fixes flagged by audit

1. **🔴 Privilege escalation (latent).** The `handle_new_user` trigger makes every new auth signup a staff `cashier`. Must be fixed *before* any customer self-registration.
2. **🔴 Silent overselling.** `checkout.ts` decrements stock with a non-atomic read-then-update + `Math.max(0,…)` that hides oversell. Fix with a guarded atomic decrement RPC before online sales go live.
3. **🟠 Returns never restock.** `return.ts` records a return but never adds stock back; quantity drifts down.

---

## 6. Phased roadmap

- **Phase 1 — Catalog & merchandising (in progress):** hidden shop ✅ → catalog foundation (settings, condition axes, tags, identifiers, restock) → condition-pricing engine → smart entry → image upload + enrichment → product detail pages + SEO → filters/collections.
- **Phase 2 — Online accounts + unified history:** customer auth + link-by-email, own-row RLS, `/account` order history, `transactions.channel`, customer-merge UX. (Fix the privilege-escalation trigger here.)
- **Phase 3 — Online checkout:** cart, Stripe + signature-verified webhook, atomic `place_online_order` RPC, stock holds, fulfillment lifecycle. Replaces the eBay handoff.
- **Cross-cutting (slot in as needed):** promotions engine, loyalty/rewards, hardware/printing, multi-location, reliability/speed pass.

---

## 7. The configurable surface (the licensable knobs)

Everything here is `store_settings` or a rules/config table, default sensible-for-a-licensee:

- Condition pricing on/off + the rules (per-condition multipliers, category/franchise overrides)
- Condition entry: combined vs separate; completeness list; grade list + icons; per-category defaults
- Tag definitions; collection/filter rules; thumbnail-banner rules
- Trade-in margins (by price band, category, franchise)
- Promotions, rewards rules
- Metadata enrichment provider + API key
- Receipt content; label format
- Website connection (publish flags + catalog surface)

---

## 8. Decisions still open

- **Sell page**: homepage `#sell` section (current, auto-opens) vs. canonical `/sell` dedicated page.
- **Condition combined-vs-separate default** for *this* store (owner prefers separate).
- **Grade optional** for new/sealed?
- **Tenant model** (project-per-tenant vs shared DB) — deferred until closer to licensing.
- **Go-live timing** — currently iterating locally; nothing pushed.
