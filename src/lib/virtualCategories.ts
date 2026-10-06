// Virtual categories — groups a listing belongs to by a FIELD, not by its one
// real category. "🇯🇵 Japanese Imports" = every listing whose region is Japan,
// so a JP Zelda shows under Video Games AND Japanese Imports, a Pikmin plush
// under Collectibles AND Japanese Imports, without tagging anything twice.
// "🧸 Plush" = the shop's Plushies department: the "plush" tag, or a title that
// says plush / plushie / stuffed… (the same rule as the shop, so both agree).
// Rules as data (a licensee can retune / add PAL Imports etc.).

import { regionOf, regionByCode, type Region } from "./regions";
import { DEPARTMENTS, inDepartment, type ShopItem } from "./shopFilters";

export interface VirtualCategory {
  key: string;     // url / filter key ("japanese-imports")
  label: string;
  icon: string;
  region?: string; // by region: the code the listing must have
  dept?: string;   // by department (shopFilters): its tag or its title words
}

export const VIRTUAL_CATEGORIES: VirtualCategory[] = [
  { key: "japanese-imports", label: "Japanese Imports", icon: "🇯🇵", region: "JP" },
  { key: "plush", label: "Plush", icon: "🧸", dept: "plushies" },
];

/** The virtual categories this store can use (a region one needs its region active). */
export const activeVirtualCategories = (regions: Region[] | null | undefined): VirtualCategory[] =>
  VIRTUAL_CATEGORIES.filter((v) => v.dept
    ? DEPARTMENTS.some((d) => d.key === v.dept)
    : !!v.region && !!regionByCode(v.region, regions) && regionByCode(v.region, regions)?.isActive !== false);

/** Does a listing belong to the virtual category? */
export const inVirtualCategory = (v: VirtualCategory, item: ShopItem, regions: Region[] | null | undefined): boolean =>
  v.dept ? inDepartment(v.dept, item) : regionOf(item.regionCode, regions) === v.region;

/** The tag a person sets by hand for this virtual category ("plush"), if it has one. */
export const virtualTag = (v: VirtualCategory): string =>
  (v.dept && DEPARTMENTS.find((d) => d.key === v.dept)?.tag) || "";

/** What the category means, for a tooltip. */
export const virtualHint = (v: VirtualCategory): string =>
  v.region ? `Every listing with the ${v.region} region, whatever its category`
    : `Tagged ${v.icon} ${v.label} (edit window / bulk bar), or the title says so — whatever its category`;
