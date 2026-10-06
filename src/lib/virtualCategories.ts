// Virtual categories — groups a listing belongs to by a FIELD, not by its one
// real category. "🇯🇵 Japanese Imports" = every listing whose region is Japan,
// so a JP Zelda shows under Video Games AND Japanese Imports, a Pikmin plush
// under Collectibles AND Japanese Imports, without tagging anything twice.
// Rules as data (a licensee can retune / add PAL Imports etc.).

import { regionOf, regionByCode, type Region } from "./regions";

export interface VirtualCategory {
  key: string;     // url / filter key ("japanese-imports")
  label: string;
  icon: string;
  region: string;  // region code the listing must have
}

export const VIRTUAL_CATEGORIES: VirtualCategory[] = [
  { key: "japanese-imports", label: "Japanese Imports", icon: "🇯🇵", region: "JP" },
];

/** The virtual categories this store can use (its region exists and is active). */
export const activeVirtualCategories = (regions: Region[] | null | undefined): VirtualCategory[] =>
  VIRTUAL_CATEGORIES.filter((v) => regionByCode(v.region, regions)?.isActive !== false && !!regionByCode(v.region, regions));

/** Does a listing (its region code) belong to the virtual category? */
export const inVirtualCategory = (v: VirtualCategory, regionCode: string | null | undefined, regions: Region[] | null | undefined) =>
  regionOf(regionCode, regions) === v.region;
