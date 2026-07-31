import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import {
  chosenSize,
  unitPriceCents,
  modifierSnapshot,
  lineDescription,
  validateSelection,
  type MenuItem,
  type Selection,
} from "../../../lib/menu";
import { autoCloseOpenTabs, decrementVariantStock } from "../../../lib/tabs";
import { barSettings } from "../../../lib/barSettings";
import { typeMapByVariant } from "../../../lib/inventoryTypes";

export const prerender = false;
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Tabs are STAFF-SHARED: the tx_tab_staff_* / ti_tab_staff_* RLS policies let any
// staff read/append/settle any tab, so we use the RLS-bound locals.supabase here
// (NOT the service-role client) and never filter by cashier. Money is always
// re-derived server-side; menu-line prices are recomputed from the DB.

// Assemble a full MenuItem (sizes + modifier groups + options) from the DB so the
// pure pricing/validation helpers in src/lib/menu.ts can run server-side.
async function loadMenuItem(supabase: any, id: string): Promise<MenuItem | null> {
  const { data: item } = await supabase.from("menu_items").select("*").eq("id", id).maybeSingle();
  if (!item) return null;
  const { data: sizes } = await supabase.from("menu_item_sizes").select("*").eq("menu_item_id", id).order("sort_order");
  const { data: links } = await supabase
    .from("menu_item_modifier_groups").select("group_id, sort_order").eq("menu_item_id", id).order("sort_order");
  const groupIds = (links ?? []).map((l: any) => l.group_id);
  let groups: any[] = [];
  if (groupIds.length) {
    const { data: gs } = await supabase.from("menu_modifier_groups").select("*").in("id", groupIds);
    const { data: opts } = await supabase.from("menu_modifier_options").select("*").in("group_id", groupIds).order("sort_order");
    const optsByGroup = new Map<string, any[]>();
    for (const o of opts ?? []) { if (!optsByGroup.has(o.group_id)) optsByGroup.set(o.group_id, []); optsByGroup.get(o.group_id)!.push(o); }
    groups = (links ?? [])
      .map((l: any) => { const g = (gs ?? []).find((x: any) => x.id === l.group_id); return g ? { ...g, options: optsByGroup.get(g.id) ?? [] } : null; })
      .filter(Boolean);
  }
  return { ...item, sizes: sizes ?? [], groups } as MenuItem;
}

// Recompute + persist a tab's running subtotal/discount/total from its lines.
// The UPDATE is guarded by status='open' so a tab settled concurrently (by another
// staffer or the auto-close sweep) is never re-totalled — `open` reports whether it
// actually landed, so callers can undo a write that raced a settle.
async function recomputeTab(supabase: any, tabId: string) {
  const { data: items } = await supabase
    .from("transaction_items").select("unit_price_cents, qty, discount_cents").eq("transaction_id", tabId);
  const rows = items ?? [];
  const subtotal = rows.reduce((s: number, it: any) => s + (it.unit_price_cents || 0) * (it.qty || 1), 0);
  const discount = Math.min(subtotal, rows.reduce((s: number, it: any) => s + (it.discount_cents || 0), 0));
  const total = Math.max(0, subtotal - discount);
  const { data: upd } = await supabase
    .from("transactions").update({ subtotal_cents: subtotal, discount_cents: discount, total_cents: total })
    .eq("id", tabId).eq("is_tab", true).eq("status", "open").select("id");
  return { subtotal, discount, total, open: (upd?.length ?? 0) > 0 };
}

// Is the Food & Beverage department enabled? (Mirrors AppLayout/tabs.astro gating
// with the legacy menuEnabled fallback.) Used to stop tab activity on a retail-only
// license at the API boundary, not just in the page render.
async function fnbEnabled(supabase: any): Promise<boolean> {
  const { data: dept } = await supabase.from("store_departments").select("is_enabled").eq("key", "food_bev").maybeSingle();
  if (dept) return dept.is_enabled === true;
  const { data: ss } = await supabase.from("store_settings").select("settings").eq("id", 1).maybeSingle();
  return (ss?.settings as any)?.menuEnabled === true;
}

// List open tabs (shared across all staff), newest-opened last so the rail reads
// like a queue. Includes line items + customer for the detail view.
export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const { data, error } = await locals.supabase
    .from("transactions")
    .select(
      "id, human_id, tab_name, table_label, tab_opened_at, employee_id, subtotal_cents, discount_cents, total_cents, customer:customers(first_name, last_name), transaction_items(id, description, qty, unit_price_cents, discount_cents, menu_item_id, variant_id, size_label, modifiers, station, fulfillment)",
    )
    .eq("is_tab", true)
    .eq("status", "open")
    .order("tab_opened_at", { ascending: true });
  if (error) return json({ error: error.message }, 500);
  return json({ tabs: data ?? [] });
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const supabase = locals.supabase;
  const b = await request.json().catch(() => ({} as any));
  const a = b.action;
  const fail = (e: any) => json({ error: e?.message || "Failed" }, 500);

  // ---- Open a new tab ----
  if (a === "open") {
    if (!(await fnbEnabled(supabase))) return json({ error: "Food & Beverage is turned off." }, 403);
    const name = String(b.name ?? "").trim().slice(0, 80);
    if (!name) return json({ error: "Tab name is required" }, 400);
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("transactions")
      .insert({
        is_tab: true,
        status: "open",
        type: "sale",
        tab_name: name,
        table_label: b.table ? String(b.table).trim().slice(0, 40) : null,
        tab_opened_at: now,
        employee_id: locals.user.id,
        customer_id: b.customerId ?? null,
        subtotal_cents: 0, discount_cents: 0, total_cents: 0,
      })
      .select("id, human_id, tab_name, table_label, tab_opened_at")
      .single();
    if (error) return fail(error);
    return json({ ok: true, tab: data });
  }

  // ---- Append a line (menu item or custom) ----
  if (a === "add-item") {
    const tabId = b.tabId;
    if (!tabId) return json({ error: "tabId required" }, 400);
    if (!(await fnbEnabled(supabase))) return json({ error: "Food & Beverage is turned off." }, 403);
    const { data: tab } = await supabase.from("transactions").select("status, is_tab").eq("id", tabId).maybeSingle();
    if (!tab || !tab.is_tab) return json({ error: "Tab not found." }, 404);
    if (tab.status !== "open") return json({ error: "That tab is already closed." }, 409);

    const qty = Math.max(1, parseInt(String(b.qty)) || 1);
    let row: Record<string, unknown>;

    if (b.custom) {
      const desc = String(b.description ?? "").trim().slice(0, 200);
      if (!desc) return json({ error: "Description is required" }, 400);
      row = {
        transaction_id: tabId, menu_item_id: null, variant_id: null, kind: "sale",
        description: desc, qty,
        unit_price_cents: Math.max(0, Math.round(Number(b.priceCents)) || 0), discount_cents: 0,
        department: "food_bev",
        station: ["bar", "kitchen"].includes(String(b.station)) ? String(b.station) : "bar",
        fulfillment: "immediate",
      };
    } else {
      if (!b.menuItemId) return json({ error: "menuItemId required" }, 400);
      const item = await loadMenuItem(supabase, b.menuItemId);
      if (!item) return json({ error: "Menu item not found." }, 404);
      const sel: Selection = { sizeId: b.sizeId ?? null, optionIdsByGroup: b.optionIdsByGroup ?? {}, qty };
      const err = validateSelection(item, sel);
      if (err) return json({ error: err }, 400);
      const size = chosenSize(item, sel);
      row = {
        transaction_id: tabId, menu_item_id: item.id, variant_id: null, kind: "sale",
        description: lineDescription(item, sel), qty,
        unit_price_cents: unitPriceCents(item, sel), discount_cents: 0,
        size_label: size?.label ?? null, modifiers: modifierSnapshot(item, sel),
        department: "food_bev", station: item.station ?? "bar",
        fulfillment: "immediate",
      };
    }

    const { data: inserted, error } = await supabase.from("transaction_items").insert(row).select("id").single();
    if (error) return fail(error);
    const totals = await recomputeTab(supabase, tabId);
    // Lost a race with a settle/auto-close between the status read and the insert:
    // undo the orphan line so a completed tab never gains an unpaid item.
    if (!totals.open) {
      await supabase.from("transaction_items").delete().eq("id", inserted.id);
      return json({ error: "That tab was just closed." }, 409);
    }
    return json({ ok: true, totals });
  }

  // ---- Remove a line ----
  if (a === "remove-item") {
    const { tabId, itemId } = b;
    if (!tabId || !itemId) return json({ error: "tabId and itemId required" }, 400);
    const { data: tab } = await supabase.from("transactions").select("status, is_tab").eq("id", tabId).maybeSingle();
    if (!tab || !tab.is_tab) return json({ error: "Tab not found." }, 404);
    if (tab.status !== "open") return json({ error: "That tab is already closed." }, 409);
    const { error } = await supabase.from("transaction_items").delete().eq("id", itemId).eq("transaction_id", tabId);
    if (error) return fail(error);
    const totals = await recomputeTab(supabase, tabId);
    return json({ ok: true, totals });
  }

  // ---- Settle (close) a tab: optional manual tip + payment split ----
  if (a === "settle") {
    const tabId = b.tabId;
    if (!tabId) return json({ error: "tabId required" }, 400);
    const { data: tab } = await supabase.from("transactions").select("status, is_tab").eq("id", tabId).maybeSingle();
    if (!tab || !tab.is_tab) return json({ error: "Tab not found." }, 404);
    if (tab.status !== "open") return json({ error: "That tab is already closed." }, 409);

    const { data: items } = await supabase
      .from("transaction_items").select("id, variant_id, qty, unit_price_cents, discount_cents").eq("transaction_id", tabId);
    const rows = items ?? [];
    if (rows.length === 0) return json({ error: "Add an item before settling." }, 400);

    // Inventory-type pass for retail lines parked on tabs (no-op today — tab
    // lines are menu/custom — but correct the day cross-side pickup lands):
    // live block check + type/department stamp for reporting.
    const variantLines = rows.filter((it: any) => it.variant_id);
    if (variantLines.length) {
      const { ready: tReady, map: tMap } = await typeMapByVariant(supabase, variantLines.map((it: any) => it.variant_id));
      const blockedLine = variantLines.find((it: any) => tMap.get(it.variant_id)?.block_at_checkout);
      if (blockedLine) return json({ error: "This tab includes an item from a blocked inventory type — remove it or unblock the type first." }, 409);
      if (tReady) {
        for (const it of variantLines as any[]) {
          const t = tMap.get(it.variant_id);
          if (t) await supabase.from("transaction_items").update({ inventory_type: t.key, department: "retail" }).eq("id", it.id);
        }
      }
    }

    const subtotal = rows.reduce((s: number, it: any) => s + (it.unit_price_cents || 0) * (it.qty || 1), 0);
    const discount = Math.min(subtotal, rows.reduce((s: number, it: any) => s + (it.discount_cents || 0), 0));
    const base = Math.max(0, subtotal - discount);
    const tip = Math.max(0, Math.round(Number(b.tipCents)) || 0);
    const total = base + tip;

    // Payment split (server-clamped): cash applied first, then store credit, card
    // fills the remainder (matches checkout.ts's card-fills-remainder behavior).
    const tendered = Math.max(0, Math.round(Number(b.cashCents)) || 0);
    const wantCredit = Math.max(0, Math.round(Number(b.storeCreditCents)) || 0);
    const cash = Math.min(total, tendered);
    const credit = Math.min(total - cash, wantCredit);
    const card = total - cash - credit;
    const change = tendered > total ? tendered - total : 0;
    const stamp = new Date().toISOString();

    const { data: settled, error } = await supabase
      .from("transactions")
      .update({
        status: "completed",
        subtotal_cents: subtotal, discount_cents: discount, tip_cents: tip, total_cents: total,
        cash_cents: cash, card_cents: card, store_credit_cents: credit,
        completed_at: stamp, tab_closed_at: stamp,
      })
      .eq("id", tabId)
      .eq("status", "open")
      .select("id");
    if (error) return fail(error);
    // Lost the settle race (already closed) → don't double-decrement stock or report a phantom settle.
    if (!settled || settled.length === 0) return json({ error: "That tab was just closed." }, 409);

    await decrementVariantStock(supabase, rows);
    return json({ ok: true, total, tip, cash, card, storeCredit: credit, change });
  }

  // ---- Void a tab (mistake / walkout, no charge) ----
  if (a === "void") {
    const tabId = b.tabId;
    if (!tabId) return json({ error: "tabId required" }, 400);
    const { error } = await supabase
      .from("transactions").update({ status: "void", tab_closed_at: new Date().toISOString() })
      .eq("id", tabId).eq("is_tab", true).eq("status", "open");
    if (error) return fail(error);
    return json({ ok: true });
  }

  // ---- Close out ALL open tabs (end of night) — managers/owners only ----
  if (a === "close-all") {
    if (!["owner", "manager"].includes(locals.profile?.role ?? "")) return json({ error: "Managers only" }, 403);
    const admin = createSupabaseAdminClient();
    const { data: row } = await admin.from("store_settings").select("settings").eq("id", 1).maybeSingle();
    const bs = barSettings(row?.settings);
    const res = await autoCloseOpenTabs(admin, {
      gratuityPercent: bs.tabAutoGratuityEnabled ? bs.tabAutoGratuityPercent : 0,
      note: "Closed out at end of night",
    });
    return json({ ok: true, ...res });
  }

  return json({ error: "Unknown action" }, 400);
};
