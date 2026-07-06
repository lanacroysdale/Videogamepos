// Shared bar-tab settle logic. A tab is a long-lived is_tab=true, status='open'
// transaction; auto-close (the manager "Close out all" button, or the nightly
// close-tabs cron) settles every open tab to CARD ON FILE with the configured
// auto-gratuity. Both callers go through autoCloseOpenTabs() so the rules can't
// drift. Integer cents throughout.
import type { SupabaseClient } from "@supabase/supabase-js";

type Client = SupabaseClient<any, any, any>;

export interface AutoCloseResult {
  closed: number;     // tabs settled to card on file
  voided: number;     // empty tabs voided (no items, no gratuity)
  grossCents: number; // total billed (incl. gratuity) across settled tabs
}

// Decrement on-hand stock for any retail-variant lines on a settled tab.
// (Menu lines aren't unit-tracked, so they're skipped.) Works with either the
// service-role admin client or an RLS-bound user client.
export async function decrementVariantStock(
  client: Client,
  items: { variant_id: string | null; qty: number | null }[],
): Promise<void> {
  const variantItems = items.filter((it) => it.variant_id);
  if (!variantItems.length) return;
  const ids = variantItems.map((it) => it.variant_id as string);
  const { data: vars } = await client.from("product_variants").select("id, quantity").in("id", ids);
  const qtyMap = new Map((vars ?? []).map((v: any) => [v.id, v.quantity]));
  for (const it of variantItems) {
    const cur = qtyMap.get(it.variant_id as string) ?? 0;
    await client.from("product_variants").update({ quantity: Math.max(0, cur - (it.qty || 1)) }).eq("id", it.variant_id as string);
  }
}

function appendNote(existing: string | null, add: string): string {
  return existing && existing.trim() ? `${existing} — ${add}` : add;
}

// Settle (or void, if empty) every currently-open tab. Requires the admin client
// because the cron has no user session. Gratuity is computed on the post-discount
// subtotal and the full total is recorded as card_cents (card on file).
export async function autoCloseOpenTabs(
  admin: Client,
  opts: { gratuityPercent: number; note?: string },
): Promise<AutoCloseResult> {
  const pct = Math.max(0, Math.min(100, Math.round(opts.gratuityPercent) || 0));
  const stamp = new Date().toISOString();
  const note = opts.note ?? "Auto-closed at closing";
  const result: AutoCloseResult = { closed: 0, voided: 0, grossCents: 0 };

  const { data: tabs } = await admin
    .from("transactions")
    .select("id, note, subtotal_cents, discount_cents, transaction_items(variant_id, qty)")
    .eq("is_tab", true)
    .eq("status", "open");

  for (const t of (tabs ?? []) as any[]) {
    const items = t.transaction_items ?? [];

    // Empty tab → void so it doesn't linger as ledger/UI noise; no gratuity.
    if (items.length === 0) {
      const { error } = await admin
        .from("transactions")
        .update({ status: "void", completed_at: stamp, tab_closed_at: stamp, note: appendNote(t.note, `${note} (empty)`) })
        .eq("id", t.id)
        .eq("status", "open");
      if (!error) result.voided++;
      continue;
    }

    const subtotal = Math.max(0, t.subtotal_cents ?? 0);
    const discount = Math.min(subtotal, Math.max(0, t.discount_cents ?? 0));
    const base = subtotal - discount;
    const gratuity = Math.round((base * pct) / 100);
    const total = base + gratuity;

    const { error } = await admin
      .from("transactions")
      .update({
        status: "completed",
        tip_cents: gratuity,
        total_cents: total,
        cash_cents: 0,
        card_cents: total, // card on file
        store_credit_cents: 0,
        completed_at: stamp,
        tab_closed_at: stamp,
        note: appendNote(t.note, pct > 0 ? `${note} · ${pct}% gratuity` : note),
      })
      .eq("id", t.id)
      .eq("status", "open"); // guard: only settle still-open tabs
    if (error) continue;

    await decrementVariantStock(admin, items);
    result.closed++;
    result.grossCents += total;
  }

  return result;
}
