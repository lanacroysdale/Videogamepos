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
      if (b.sku !== undefined) patch.sku = b.sku ? String(b.sku).slice(0, 60) : null;
      if (b.completenessCode !== undefined) patch.completeness_code = b.completenessCode || null;
      if (b.gradeCode !== undefined) patch.grade_code = b.gradeCode || null;
      if (b.onlineVisible !== undefined) patch.online_visible = !!b.onlineVisible;
      if (b.onlinePriceCents !== undefined)
        patch.online_price_cents = b.onlinePriceCents == null ? null : Math.max(0, Math.round(Number(b.onlinePriceCents)));
      if (!Object.keys(patch).length) return json({ error: "Nothing to update" }, 400);
      const { error } = await sb.from("product_variants").update(patch).eq("id", b.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    case "updateProduct": {
      const patch: Record<string, unknown> = {};
      if (b.title !== undefined) {
        if (!String(b.title).trim()) return json({ error: "Title is required" }, 400);
        patch.title = String(b.title).trim().slice(0, 200);
      }
      if (b.platform !== undefined) patch.platform = b.platform || null;
      if (b.franchise !== undefined) patch.franchise = b.franchise || null;
      if (b.genre !== undefined) patch.genre = b.genre || null;
      if (b.categoryId !== undefined) patch.category_id = b.categoryId || null;
      if (b.description !== undefined) patch.description = b.description || null;
      if (b.imageUrl !== undefined) patch.image_url = b.imageUrl || null;
      if (!Object.keys(patch).length) return json({ error: "Nothing to update" }, 400);
      const { error } = await sb.from("products").update(patch).eq("id", b.id);
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
          completeness_code: b.completenessCode || null,
          grade_code: b.gradeCode || null,
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
    case "addVariant": {
      if (!b.productId) return json({ error: "productId required" }, 400);
      const { data, error } = await sb
        .from("product_variants")
        .insert({
          product_id: b.productId,
          condition: b.condition || "Used",
          completeness_code: b.completenessCode || null,
          grade_code: b.gradeCode || null,
          price_cents: Math.max(0, Math.round(Number(b.priceCents)) || 0),
          quantity: Math.max(0, Math.round(Number(b.quantity)) || 0),
        })
        .select("id, internal_code")
        .single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, variant: data });
    }
    case "repriceProduct": {
      // Condition-pricing engine: re-price the product's other conditions from
      // this one. Gated server-side by store_settings.condition_pricing_enabled.
      if (!b.variantId) return json({ error: "variantId required" }, 400);
      const { data, error } = await sb.rpc("reprice_product", { p_variant_id: b.variantId });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, updated: data ?? [] });
    }
    default:
      return json({ error: "Unknown action" }, 400);
  }
};
