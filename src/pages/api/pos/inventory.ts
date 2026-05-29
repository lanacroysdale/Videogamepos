import type { APIRoute } from "astro";

export const prerender = false;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({}));
  const sb = locals.supabase;

  switch (b.action) {
    case "updateVariant": {
      const patch: Record<string, unknown> = {};
      if (b.priceCents != null) patch.price_cents = Math.max(0, Math.round(Number(b.priceCents)));
      if (b.quantity != null) patch.quantity = Math.max(0, Math.round(Number(b.quantity)));
      if (b.condition) patch.condition = String(b.condition).slice(0, 40);
      if (b.completeness !== undefined) patch.completeness = b.completeness || null;
      if (!Object.keys(patch).length) return json({ error: "Nothing to update" }, 400);
      const { error } = await sb.from("product_variants").update(patch).eq("id", b.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    case "addBarcode": {
      if (!b.variantId || !String(b.barcode ?? "").trim()) return json({ error: "Variant and barcode required" }, 400);
      const { data, error } = await sb
        .from("product_barcodes")
        .insert({ variant_id: b.variantId, barcode: String(b.barcode).trim(), label: b.label || null })
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, barcode: data });
    }
    case "removeBarcode": {
      const { error } = await sb.from("product_barcodes").delete().eq("id", b.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    case "addProduct": {
      if (!String(b.title ?? "").trim() || !b.categoryId) return json({ error: "Title and category required" }, 400);
      const { data: prod, error: pErr } = await sb
        .from("products")
        .insert({ title: String(b.title).trim(), platform: b.platform || null, franchise: b.franchise || null, category_id: b.categoryId })
        .select()
        .single();
      if (pErr) return json({ error: pErr.message }, 500);
      const { data: variant, error: vErr } = await sb
        .from("product_variants")
        .insert({
          product_id: prod.id,
          condition: b.condition || "Used",
          price_cents: Math.max(0, Math.round(Number(b.priceCents)) || 0),
          quantity: Math.max(0, Math.round(Number(b.quantity)) || 0),
          sku: b.sku || null,
          barcode: b.barcode || null,
        })
        .select()
        .single();
      if (vErr) return json({ error: vErr.message }, 500);
      return json({ ok: true, productId: prod.id, variantId: variant.id });
    }
    default:
      return json({ error: "Unknown action" }, 400);
  }
};
