// Pure sales-analytics math for /app/reports, kept separate from the page so the
// money logic can be unit-tested. Everything is integer cents in, integer cents
// out (except marginPct). Revenue model (from the POS schema):
//   - A completed SALE is a transaction with sale/service line items.
//   - A RETURN is its own transaction (type='return') whose items have
//     kind='return'; unit_price_cents is the refund amount.
//   - A TRADE-IN line (kind='trade_in') is money paid OUT to acquire stock.
//   - COGS isn't snapshotted at sale time, so margin joins the variant's current
//     cost_cents (see costUnknownUnits for honesty about coverage).

export type Txn = {
  id: string;
  type: string;
  completed_at: string | null;
  employee_id: string | null;
  discount_cents: number;
  cash_cents: number;
  card_cents: number;
  store_credit_cents: number;
  customer_id: string | null;
};

export type Item = {
  transaction_id: string;
  variant_id: string | null;
  category_id: string | null;
  kind: string;
  description: string;
  qty: number;
  unit_price_cents: number;
  discount_cents: number;
};

export type Summary = {
  grossSales: number; // Σ unit*qty over sale/service lines (pre-discount)
  discounts: number; // Σ line discounts on sale/service lines
  returns: number; // Σ refund over return lines
  netSales: number; // grossSales - discounts - returns
  cogs: number; // Σ variant cost * qty over sold lines with a known cost
  grossProfit: number; // netSales - cogs
  marginPct: number; // grossProfit / netSales (0 when netSales <= 0)
  txnCount: number; // distinct transactions that contain a sale/service line
  unitsSold: number; // Σ qty over sale lines
  avgOrder: number; // netSales / txnCount
  tradeInPayout: number; // Σ unit*qty over trade_in lines (paid out)
  tradeInCount: number; // distinct transactions with a trade_in line
  payments: { cash: number; card: number; storeCredit: number };
  costKnownUnits: number; // sold units whose variant cost is known (>0)
  costUnknownUnits: number; // sold units missing a cost basis
};

const lineNet = (it: Item) => it.unit_price_cents * it.qty - it.discount_cents;

// Roll a set of transactions + their line items into the headline summary.
export function summarize(txns: Txn[], items: Item[], costOf: Map<string, number>): Summary {
  const txById = new Map(txns.map((t) => [t.id, t]));
  const saleTxnIds = new Set<string>();
  const tradeTxnIds = new Set<string>();

  let grossSales = 0, discounts = 0, returns = 0, cogs = 0;
  let unitsSold = 0, tradeInPayout = 0;
  let costKnownUnits = 0, costUnknownUnits = 0;

  for (const it of items) {
    if (it.kind === "sale" || it.kind === "service") {
      grossSales += it.unit_price_cents * it.qty;
      discounts += it.discount_cents;
      saleTxnIds.add(it.transaction_id);
      if (it.kind === "sale") unitsSold += it.qty;
      // COGS only for stocked goods (a variant). Services have no cost of goods.
      if (it.variant_id) {
        const c = costOf.get(it.variant_id) ?? 0;
        if (c > 0) { cogs += c * it.qty; costKnownUnits += it.qty; }
        else costUnknownUnits += it.qty;
      }
    } else if (it.kind === "return") {
      returns += lineNet(it);
      // Reverse the returned unit's COGS so a same-period sale+return nets to ~0
      // profit (return items carry the original variant_id).
      if (it.variant_id) {
        const c = costOf.get(it.variant_id) ?? 0;
        if (c > 0) { cogs -= c * it.qty; costKnownUnits -= it.qty; }
        else costUnknownUnits -= it.qty; // mirror the sale branch so coverage nets out
      }
    } else if (it.kind === "trade_in") {
      tradeInPayout += it.unit_price_cents * it.qty;
      tradeTxnIds.add(it.transaction_id);
    }
  }

  let cash = 0, card = 0, storeCredit = 0;
  for (const id of saleTxnIds) {
    const t = txById.get(id);
    if (!t) continue;
    cash += t.cash_cents; card += t.card_cents; storeCredit += t.store_credit_cents;
  }

  const netSales = grossSales - discounts - returns;
  const grossProfit = netSales - cogs;
  const txnCount = saleTxnIds.size;
  return {
    grossSales, discounts, returns, netSales, cogs, grossProfit,
    marginPct: netSales > 0 ? (grossProfit / netSales) * 100 : 0,
    txnCount,
    unitsSold,
    avgOrder: txnCount ? Math.round(netSales / txnCount) : 0,
    tradeInPayout,
    tradeInCount: tradeTxnIds.size,
    payments: { cash, card, storeCredit },
    costKnownUnits, costUnknownUnits,
  };
}

// Period-over-period percentage change, or null when there's no comparable base.
export function pctChange(cur: number, prev: number): number | null {
  if (!prev) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

// ---- Time-series bucketing (for the sales trend chart) ----
export type Granularity = "day" | "week" | "month";

export function granularityFor(spanDays: number): Granularity {
  if (spanDays <= 45) return "day";
  if (spanDays <= 180) return "week";
  return "month";
}

// Portland-local Y-M-D so buckets line up with store days regardless of the
// server's timezone (Vercel runs UTC).
const PT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
});
export const ymd = (ms: number): string => PT.format(new Date(ms));

// Sunday-anchored week start (YYYY-MM-DD) for a Portland-local day key. The y/m/d
// are treated as a UTC calendar date purely for stable week arithmetic, and the
// result is formatted from UTC fields — no PT round-trip, so the anchor doesn't
// drift a day (the bug being that ymd() would shift UTC-midnight back into PT).
function weekKey(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const sunday = new Date(Date.UTC(y, m - 1, d) - new Date(Date.UTC(y, m - 1, d)).getUTCDay() * 86400000);
  const mm = String(sunday.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(sunday.getUTCDate()).padStart(2, "0");
  return `${sunday.getUTCFullYear()}-${mm}-${dd}`;
}

const keyFor = (ms: number, g: Granularity): string =>
  g === "month" ? ymd(ms).slice(0, 7) : g === "week" ? weekKey(ymd(ms)) : ymd(ms);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function bucketLabel(key: string, g: Granularity): string {
  if (g === "month") { const [, m] = key.split("-").map(Number); return MONTHS[m - 1] ?? key; }
  const [, m, d] = key.split("-").map(Number); // day or week → "Jun 8"
  return `${MONTHS[m - 1] ?? "?"} ${d}`;
}

export type Bucket = { key: string; label: string; net: number };

// Build an ordered, gap-filled series of net sales per bucket across [startMs, endMs].
export function bucketSeries(txns: Txn[], items: Item[], startMs: number, endMs: number, g: Granularity): Bucket[] {
  const txById = new Map(txns.map((t) => [t.id, t]));
  const order: string[] = [];
  const seen = new Set<string>();
  const push = (k: string) => { if (!seen.has(k)) { seen.add(k); order.push(k); } };

  if (g === "month") {
    const [sy, sm] = ymd(startMs).split("-").map(Number);
    const [ey, em] = ymd(endMs).split("-").map(Number);
    for (let y = sy, m = sm; y < ey || (y === ey && m <= em); m++) {
      if (m > 12) { m = 1; y++; }
      push(`${y}-${String(m).padStart(2, "0")}`);
    }
  } else {
    const step = g === "week" ? 7 * 86400000 : 86400000;
    // Anchor to the bucket key of the start so day/week align cleanly.
    for (let ms = startMs; ms <= endMs + step; ms += step) {
      push(keyFor(ms, g));
      if (keyFor(ms, g) === keyFor(endMs, g)) break;
    }
  }

  const totals = new Map<string, number>(order.map((k) => [k, 0]));
  for (const it of items) {
    if (it.kind !== "sale" && it.kind !== "service") continue;
    const t = txById.get(it.transaction_id);
    if (!t?.completed_at) continue;
    const k = keyFor(Date.parse(t.completed_at), g);
    if (totals.has(k)) totals.set(k, totals.get(k)! + lineNet(it));
  }
  return order.map((k) => ({ key: k, label: bucketLabel(k, g), net: totals.get(k) ?? 0 }));
}

// Group sold-line revenue by an arbitrary key (category id, employee id, …).
// Pass costOf to also accumulate COGS per group (for per-group margin).
export function rollupBy(
  items: Item[],
  keyOf: (it: Item) => string | null,
  costOf?: Map<string, number>,
): Map<string, { net: number; units: number; cogs: number }> {
  const m = new Map<string, { net: number; units: number; cogs: number }>();
  for (const it of items) {
    if (it.kind !== "sale" && it.kind !== "service") continue;
    const k = keyOf(it) ?? "—";
    const cur = m.get(k) ?? { net: 0, units: 0, cogs: 0 };
    cur.net += lineNet(it);
    cur.units += it.qty;
    if (costOf && it.variant_id) cur.cogs += (costOf.get(it.variant_id) ?? 0) * it.qty;
    m.set(k, cur);
  }
  return m;
}
