// Bar / food-&-beverage menu domain types + pure pricing/validation helpers,
// shared by the staff POS and the customer QR flow. Integer cents throughout.

export type MenuSection = {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
};

export type MenuModifierOption = {
  id: string;
  group_id: string;
  name: string;
  price_delta_cents: number;
  is_default: boolean;
  is_available: boolean;
  sort_order: number;
};

export type MenuModifierGroup = {
  id: string;
  name: string;
  min_select: number;       // 0 = optional
  max_select: number | null; // null = unlimited; 1 = single-choice
  sort_order: number;
  options: MenuModifierOption[];
};

export type MenuItemSize = {
  id: string;
  menu_item_id: string;
  label: string;
  price_cents: number;
  is_default: boolean;
  is_available: boolean;
  sort_order: number;
};

export type MenuItem = {
  id: string;
  section_id: string | null;
  name: string;
  description: string | null;
  base_price_cents: number;
  cost_cents: number; // est. pour/food cost, for F&B margin in Reports
  image_url: string | null;
  is_available: boolean;
  online_orderable: boolean;
  abv: number | null;
  tags: string[];
  sort_order: number;
  sizes: MenuItemSize[];
  groups: MenuModifierGroup[];
};

// What a guest/staff picked for one line.
export type Selection = {
  sizeId?: string | null;
  optionIdsByGroup: Record<string, string[]>; // group_id -> chosen option ids
  qty: number;
};

// A modifier snapshot stored on the transaction line (immune to later edits).
export type ChosenModifier = { name: string; price_delta_cents: number };

const optionById = (item: MenuItem) => {
  const m = new Map<string, MenuModifierOption>();
  for (const g of item.groups) for (const o of g.options) m.set(o.id, o);
  return m;
};

// The chosen size row (explicit, default, or none).
export function chosenSize(item: MenuItem, sel: Selection): MenuItemSize | null {
  if (sel.sizeId) return item.sizes.find((s) => s.id === sel.sizeId) ?? null;
  return item.sizes.find((s) => s.is_default) ?? null;
}

// Per-unit price = (chosen size price, else base) + Σ chosen modifier deltas.
export function unitPriceCents(item: MenuItem, sel: Selection): number {
  const size = chosenSize(item, sel);
  let cents = size ? size.price_cents : item.base_price_cents;
  const byId = optionById(item);
  for (const ids of Object.values(sel.optionIdsByGroup || {})) {
    for (const id of ids) cents += byId.get(id)?.price_delta_cents ?? 0;
  }
  return Math.max(0, cents);
}

export function lineTotalCents(item: MenuItem, sel: Selection): number {
  return unitPriceCents(item, sel) * Math.max(1, sel.qty || 1);
}

// The flat modifier snapshot to persist on transaction_items.modifiers.
export function modifierSnapshot(item: MenuItem, sel: Selection): ChosenModifier[] {
  const byId = optionById(item);
  const out: ChosenModifier[] = [];
  for (const ids of Object.values(sel.optionIdsByGroup || {})) {
    for (const id of ids) {
      const o = byId.get(id);
      if (o) out.push({ name: o.name, price_delta_cents: o.price_delta_cents });
    }
  }
  return out;
}

// Human-readable line description, e.g. "Latte (Large) · Oat, Extra shot".
export function lineDescription(item: MenuItem, sel: Selection): string {
  const size = chosenSize(item, sel);
  const mods = modifierSnapshot(item, sel).map((m) => m.name);
  let s = item.name;
  if (size) s += ` (${size.label})`;
  if (mods.length) s += ` · ${mods.join(", ")}`;
  return s;
}

// Validate a selection against the item's rules; returns an error string or null.
export function validateSelection(item: MenuItem, sel: Selection): string | null {
  if (!item.is_available) return `${item.name} is currently unavailable.`;
  if (item.sizes.length > 0) {
    const size = chosenSize(item, sel);
    if (!size) return `Choose a size for ${item.name}.`;
    if (!size.is_available) return `${size.label} ${item.name} is unavailable.`;
  }
  for (const g of item.groups) {
    const ids = sel.optionIdsByGroup?.[g.id] ?? [];
    // chosen options must exist in the group and be available
    const valid = new Set(g.options.filter((o) => o.is_available).map((o) => o.id));
    for (const id of ids) if (!valid.has(id)) return `Invalid choice for ${g.name}.`;
    if (ids.length < g.min_select) {
      return g.min_select === 1 ? `Choose ${g.name}.` : `Choose at least ${g.min_select} for ${g.name}.`;
    }
    if (g.max_select != null && ids.length > g.max_select) {
      return `Choose at most ${g.max_select} for ${g.name}.`;
    }
  }
  return null;
}
