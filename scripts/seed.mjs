// ============================================================================
// Seed demo data into Supabase using the service-role key (bypasses RLS).
// Run with:  npm run db:seed   (which loads .env and calls this script)
// Safe to re-run: it clears operational tables first and upserts the logins.
// ============================================================================
import { createClient } from "@supabase/supabase-js";

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// Local-dev demo password. Set SEED_PASSWORD in .env to pin it, otherwise a
// random one is generated and printed at the end. These demo accounts are
// LOCAL DEV ONLY — never provision them (or this password) in production.
const DEMO_PASSWORD = process.env.SEED_PASSWORD || "dev-" + Math.random().toString(36).slice(2, 10);

const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// Store hours weighted toward midday/evening for a realistic "busy hours" chart.
const HOUR_WEIGHTS = { 10: 1, 11: 2, 12: 3, 13: 4, 14: 4, 15: 4, 16: 5, 17: 5, 18: 4, 19: 3, 20: 2 };
function weightedHour() {
  const pool = [];
  for (const [h, w] of Object.entries(HOUR_WEIGHTS)) for (let i = 0; i < w; i++) pool.push(Number(h));
  return pick(pool);
}

async function upsertUser(email, full_name, role) {
  const { data: list } = await sb.auth.admin.listUsers();
  let user = list.users.find((u) => u.email === email);
  if (!user) {
    const { data, error } = await sb.auth.admin.createUser({
      email,
      password: DEMO_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name, role },
    });
    if (error) throw error;
    user = data.user;
  } else {
    await sb.auth.admin.updateUserById(user.id, { user_metadata: { full_name, role } });
  }
  await sb.from("profiles").upsert({ id: user.id, full_name, role });
  return user.id;
}

async function clearTable(name) {
  const { error } = await sb.from(name).delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (error) throw new Error(`clear ${name}: ${error.message}`);
}

async function main() {
  console.log("→ Employees / logins");
  const ownerId = await upsertUser("owner@timelag.test", "Adam (Owner)", "owner");
  const managerId = await upsertUser("manager@timelag.test", "Riley (Manager)", "manager");
  const cashierId = await upsertUser("cashier@timelag.test", "Sam (Cashier)", "cashier");
  const employees = [ownerId, managerId, cashierId];

  console.log("→ Clearing operational tables");
  for (const t of ["transaction_items", "transactions", "price_changes", "product_barcodes", "time_entries", "shifts", "repairs", "product_variants", "products", "categories", "customers", "trade_margins"]) {
    await clearTable(t);
  }

  console.log("→ Employee card codes");
  await sb.from("profiles").update({ card_code: "1001" }).eq("id", ownerId);
  await sb.from("profiles").update({ card_code: "1002" }).eq("id", managerId);
  await sb.from("profiles").update({ card_code: "1003" }).eq("id", cashierId);

  console.log("→ Categories");
  const { data: cats, error: catErr } = await sb
    .from("categories")
    .insert([
      { name: "Video Games", color: "#8b5cf6", is_trackable: true, sort_order: 1 },
      { name: "Consoles", color: "#2ce6e0", is_trackable: true, sort_order: 2 },
      { name: "Accessories", color: "#80ff72", is_trackable: true, sort_order: 3 },
      { name: "Books", color: "#ffd23f", is_trackable: true, sort_order: 4 },
      { name: "Movies", color: "#ff8a5c", is_trackable: true, sort_order: 5 },
      { name: "Gift Cards", color: "#ff49d0", is_trackable: false, sort_order: 6 },
      { name: "Disc Repair", color: "#9aa0c9", is_trackable: false, sort_order: 7 },
    ])
    .select();
  if (catErr) throw catErr;
  const catId = (name) => cats.find((c) => c.name === name).id;

  console.log("→ Customers");
  // Every row must have the SAME keys: PostgREST bulk-insert sends explicit
  // NULL for any key missing from a row, which would bypass column defaults.
  const C = (first, last, email, phone, credit, points, membership, emailSub, textSub) => ({
    first_name: first, last_name: last, email, phone,
    store_credit_cents: credit, points, membership,
    email_subscribed: emailSub, text_subscribed: textSub, notes: null,
  });
  const { data: customers, error: custErr } = await sb
    .from("customers")
    .insert([
      C("Adam", "Reyes", "adam.reyes@email.com", "503-555-0101", 2500, 340, "vip", true, false),
      C("Adelaide", "Cho", "adelaide@email.com", "503-555-0144", 0, 80, "member", true, true),
      C("Marcus", "Webb", "mwebb@email.com", "971-555-0199", 1200, 150, "member", false, false),
      C("Priya", "Nair", "priya.n@email.com", "503-555-0177", 0, 20, "standard", false, false),
      C("Jordan", "Lee", "jlee@email.com", "360-555-0188", 5000, 600, "vip", false, true),
      C("Sofia", "Martinez", "sofia.m@email.com", "503-555-0122", 0, 0, "standard", false, false),
      C("Devin", "Brooks", null, "971-555-0166", 0, 45, "standard", false, false),
      C("Hana", "Suzuki", "hana.s@email.com", "503-555-0133", 0, 0, "member", true, false),
    ])
    .select();
  if (custErr) throw custErr;

  console.log("→ Products + variants");
  const productDefs = [
    { title: "Super Mario 64", platform: "Nintendo 64", franchise: "Mario", genre: "Platformer", rating: "E", category: "Video Games",
      variants: [{ condition: "Loose", completeness: "Cart only", price: 3999, qty: 4 }, { condition: "Complete", completeness: "CIB", price: 8999, qty: 1 }] },
    { title: "The Legend of Zelda: Ocarina of Time", platform: "Nintendo 64", franchise: "Zelda", genre: "Adventure", rating: "E", category: "Video Games",
      variants: [{ condition: "Loose", completeness: "Cart only", price: 3499, qty: 3 }, { condition: "Complete", completeness: "CIB", price: 7999, qty: 0 }] },
    { title: "GoldenEye 007", platform: "Nintendo 64", franchise: "James Bond", genre: "Shooter", rating: "T", category: "Video Games",
      variants: [{ condition: "Loose", completeness: "Cart only", price: 2999, qty: 5 }] },
    { title: "Pokémon Red Version", platform: "Game Boy", franchise: "Pokémon", genre: "RPG", rating: "E", category: "Video Games",
      variants: [{ condition: "Loose", completeness: "Cart only", price: 5999, qty: 2 }, { condition: "Complete", completeness: "CIB", price: 19999, qty: 1 }] },
    { title: "Super Mario World", platform: "Super Nintendo", franchise: "Mario", genre: "Platformer", rating: "E", category: "Video Games",
      variants: [{ condition: "Loose", completeness: "Cart only", price: 2999, qty: 3 }, { condition: "Complete", completeness: "CIB", price: 6499, qty: 1 }] },
    { title: "Chrono Trigger", platform: "Super Nintendo", franchise: "Chrono", genre: "RPG", rating: "E", category: "Video Games",
      variants: [{ condition: "Loose", completeness: "Cart only", price: 12999, qty: 1 }] },
    { title: "Final Fantasy VII", platform: "PlayStation", franchise: "Final Fantasy", genre: "RPG", rating: "T", category: "Video Games",
      variants: [{ condition: "Complete", completeness: "CIB", price: 4999, qty: 2 }] },
    { title: "Metal Gear Solid", platform: "PlayStation", franchise: "Metal Gear", genre: "Stealth", rating: "M", category: "Video Games",
      variants: [{ condition: "Complete", completeness: "CIB", price: 5499, qty: 2 }] },
    { title: "Halo: Combat Evolved", platform: "Xbox", franchise: "Halo", genre: "Shooter", rating: "M", category: "Video Games",
      variants: [{ condition: "Complete", completeness: "CIB", price: 1999, qty: 6 }] },
    { title: "The Legend of Zelda: Breath of the Wild", platform: "Nintendo Switch", franchise: "Zelda", genre: "Adventure", rating: "E10+", category: "Video Games",
      variants: [{ condition: "Complete", completeness: "CIB", price: 4499, qty: 5 }] },
    { title: "Mario Kart 8 Deluxe", platform: "Nintendo Switch", franchise: "Mario", genre: "Racing", rating: "E", category: "Video Games",
      variants: [{ condition: "Complete", completeness: "CIB", price: 4999, qty: 8 }] },
    { title: "Nintendo 64 Console", platform: "Nintendo 64", franchise: null, genre: null, rating: null, category: "Consoles",
      variants: [{ condition: "Used", completeness: "Console + cables", price: 8999, qty: 3 }] },
    { title: "PlayStation 2 Slim", platform: "PlayStation 2", franchise: null, genre: null, rating: null, category: "Consoles",
      variants: [{ condition: "Used", completeness: "Console + 2 controllers", price: 7999, qty: 2 }] },
    { title: "Nintendo Switch", platform: "Nintendo Switch", franchise: null, genre: null, rating: null, category: "Consoles",
      variants: [{ condition: "Used", completeness: "Console + dock", price: 19999, qty: 4 }] },
    { title: "N64 Controller", platform: "Nintendo 64", franchise: null, genre: null, rating: null, category: "Accessories",
      variants: [{ condition: "Used", completeness: null, price: 2499, qty: 9 }] },
    { title: "DualShock 2 Controller", platform: "PlayStation 2", franchise: null, genre: null, rating: null, category: "Accessories",
      variants: [{ condition: "Used", completeness: null, price: 1999, qty: 7 }] },
  ];

  let skuN = 1000;
  const variantPool = []; // sellable items for transactions
  for (const def of productDefs) {
    const { data: prod, error: pErr } = await sb
      .from("products")
      .insert({ title: def.title, platform: def.platform, franchise: def.franchise, genre: def.genre, rating: def.rating, category_id: catId(def.category) })
      .select()
      .single();
    if (pErr) throw pErr;
    const vRows = def.variants.map((v) => ({
      product_id: prod.id,
      condition: v.condition,
      completeness: v.completeness,
      sku: `TLG-${skuN++}`,
      barcode: String(700000000000 + skuN),
      price_cents: v.price,
      cost_cents: Math.round(v.price * 0.45),
      quantity: v.qty,
    }));
    const { data: variants, error: vErr } = await sb.from("product_variants").insert(vRows).select();
    if (vErr) throw vErr;
    for (const v of variants) {
      variantPool.push({ variant_id: v.id, category_id: catId(def.category), price_cents: v.price_cents, description: `${def.title} (${v.condition})` });
    }
  }
  // a non-inventory service item
  variantPool.push({ variant_id: null, category_id: catId("Disc Repair"), price_cents: 499, description: "Disc Resurfacing (service)", kind: "service" });

  console.log("→ Trade-in margins");
  await sb.from("trade_margins").insert([
    { label: "Under $15", min_cents: 0, max_cents: 1500, cash_percent: 20, credit_percent: 30, sort_order: 1 },
    { label: "$15 – $50", min_cents: 1500, max_cents: 5000, cash_percent: 35, credit_percent: 45, sort_order: 2 },
    { label: "$50 – $150", min_cents: 5000, max_cents: 15000, cash_percent: 45, credit_percent: 55, sort_order: 3 },
    { label: "$150+", min_cents: 15000, max_cents: null, cash_percent: 55, credit_percent: 65, sort_order: 4 },
  ]);

  console.log("→ Transactions (completed history)");
  const now = Date.now();
  let completedCount = 0;
  for (let d = 0; d < 12; d++) {
    const perDay = rand(3, 8);
    for (let i = 0; i < perDay; i++) {
      const when = new Date(now - d * 86400000);
      when.setHours(weightedHour(), rand(0, 59), 0, 0);
      const employee = pick(employees);
      const customer = Math.random() < 0.6 ? pick(customers) : null;

      const lineCount = rand(1, 3);
      const chosen = Array.from({ length: lineCount }, () => pick(variantPool));
      const items = chosen.map((c) => {
        const qty = 1;
        const discount = Math.random() < 0.18 ? Math.round(c.price_cents * 0.1) : 0;
        return {
          variant_id: c.variant_id,
          category_id: c.category_id,
          kind: c.kind || "sale",
          description: c.description,
          qty,
          unit_price_cents: c.price_cents,
          discount_cents: discount,
        };
      });
      const subtotal = items.reduce((s, it) => s + it.unit_price_cents * it.qty, 0);
      const discount = items.reduce((s, it) => s + it.discount_cents, 0);
      const total = subtotal - discount;
      const cash = Math.random() < 0.4 ? total : 0;
      const card = cash ? 0 : total;

      const { data: txn, error: tErr } = await sb
        .from("transactions")
        .insert({
          customer_id: customer?.id ?? null,
          employee_id: employee,
          type: "sale",
          status: "completed",
          subtotal_cents: subtotal,
          discount_cents: discount,
          total_cents: total,
          cash_cents: cash,
          card_cents: card,
          created_at: when.toISOString(),
          completed_at: when.toISOString(),
        })
        .select()
        .single();
      if (tErr) throw tErr;
      const { error: iErr } = await sb
        .from("transaction_items")
        .insert(items.map((it) => ({ ...it, transaction_id: txn.id })));
      if (iErr) throw iErr;
      completedCount++;
    }
  }

  console.log("→ Open transactions (drafts on the dashboard)");
  const drafts = [
    { employee: cashierId, customer: customers[1], items: [variantPool[0], variantPool[4]] },
    { employee: managerId, customer: customers[4], items: [variantPool[9]] },
    { employee: cashierId, customer: null, items: [variantPool[2], variantPool[2]] },
  ];
  for (const dft of drafts) {
    const items = dft.items.map((c) => ({
      variant_id: c.variant_id,
      category_id: c.category_id,
      kind: c.kind || "sale",
      description: c.description,
      qty: 1,
      unit_price_cents: c.price_cents,
      discount_cents: 0,
    }));
    const subtotal = items.reduce((s, it) => s + it.unit_price_cents * it.qty, 0);
    const { data: txn, error } = await sb
      .from("transactions")
      .insert({
        customer_id: dft.customer?.id ?? null,
        employee_id: dft.employee,
        type: "sale",
        status: "open",
        subtotal_cents: subtotal,
        total_cents: subtotal,
      })
      .select()
      .single();
    if (error) throw error;
    await sb.from("transaction_items").insert(items.map((it) => ({ ...it, transaction_id: txn.id })));
  }

  const sellable = variantPool.filter((v) => v.variant_id);

  console.log("→ Extra barcodes (multi-barcode demo)");
  await sb.from("product_barcodes").insert([
    { variant_id: sellable[0].variant_id, barcode: "TGT-100200300", label: "Target SKU" },
    { variant_id: sellable[0].variant_id, barcode: "WMT-400500600", label: "Walmart SKU" },
    { variant_id: sellable[1].variant_id, barcode: "ANNIV-778899", label: "Anniversary edition" },
  ]);

  console.log("→ Repairs");
  const R = (customer_id, customer_name, phone, device_type, serial, location, issue, status, price_cents, employee_id) =>
    ({ customer_id, customer_name, phone, device_type, serial, location, issue, status, price_cents, employee_id });
  await sb.from("repairs").insert([
    R(customers[0].id, null, customers[0].phone, "Nintendo Switch", "XKW10293", "Bin A3", "Won't charge — dock/port issue", "in_queue", 4999, managerId),
    R(customers[2].id, null, customers[2].phone, "PlayStation 2", "PS2-558210", "Bench 1", "Disc read errors — laser cleaning", "in_progress", 3999, cashierId),
    R(null, "Walk-in (Chris)", "503-555-0190", "Game Boy Color", null, "Bin B1", "Screen lines — needs new LCD", "completed", 5999, ownerId),
    R(customers[4].id, null, customers[4].phone, "Xbox 360 Controller", "XB360-99281", "Bin A1", "Stick drift — hall-effect swap", "picked_up", 2499, managerId),
  ]);

  console.log("→ Shifts + time clock");
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const shiftAt = (dayOffset, startH, endH, emp) => {
    const s = new Date(day0); s.setDate(s.getDate() + dayOffset); s.setHours(startH);
    const e = new Date(day0); e.setDate(e.getDate() + dayOffset); e.setHours(endH);
    return { employee_id: emp, starts_at: s.toISOString(), ends_at: e.toISOString(), note: null };
  };
  await sb.from("shifts").insert([
    shiftAt(0, 10, 18, cashierId), shiftAt(0, 12, 20, managerId),
    shiftAt(1, 10, 18, ownerId), shiftAt(1, 12, 20, cashierId),
    shiftAt(2, 10, 16, managerId), shiftAt(2, 14, 20, cashierId),
    shiftAt(-1, 10, 18, ownerId),
  ]);

  const nowD = new Date();
  const at = (dayOffset, h, m) => { const d = new Date(day0); d.setDate(d.getDate() + dayOffset); d.setHours(h, m); return d.toISOString(); };
  await sb.from("time_entries").insert([
    { employee_id: cashierId, clock_in: at(0, 9, 2), clock_out: null },               // currently clocked in
    { employee_id: ownerId, clock_in: at(-1, 10, 0), clock_out: at(-1, 18, 15) },
    { employee_id: managerId, clock_in: at(0, 8, 0), clock_out: at(0, 12, 30) },
  ]);
  void nowD;

  console.log("→ Pending price changes (PriceCharting review demo)");
  const factors = [1.12, 0.92, 1.2, 0.85];
  await sb.from("price_changes").insert(
    sellable.slice(0, 4).map((v, i) => ({
      variant_id: v.variant_id, old_cents: v.price_cents,
      suggested_cents: Math.round(v.price_cents * factors[i] / 100) * 100, source: "pricecharting", status: "pending",
    })),
  );

  console.log(`\n✅ Seed complete: ${completedCount} completed sales, ${drafts.length} open drafts, ${customers.length} customers, ${productDefs.length} products.`);
  console.log(`   Local-dev logins (password for all: ${DEMO_PASSWORD}):`);
  console.log("   • owner@timelag.test   (Owner)");
  console.log("   • manager@timelag.test (Manager)");
  console.log("   • cashier@timelag.test (Cashier)");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
