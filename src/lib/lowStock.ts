// "Only N left" badge config — lives in store_settings.settings, edited on the
// POS Settings page, read by the shop + product page.
export interface LowStockSettings {
  lowStockEnabled: boolean;
  lowStockThreshold: number;       // show the badge when stock is at/below this
  lowStockMinPriceCents: number;   // only on items priced at/above this (0 = all)
  lowStockHoverOnly: boolean;      // only reveal the badge when the card is hovered
}

export const LOW_STOCK_DEFAULTS: LowStockSettings = {
  lowStockEnabled: true,
  lowStockThreshold: 3,
  lowStockMinPriceCents: 0,
  lowStockHoverOnly: false,
};

export function lowStockSettings(raw: any): LowStockSettings {
  return {
    lowStockEnabled: raw?.lowStockEnabled ?? LOW_STOCK_DEFAULTS.lowStockEnabled,
    lowStockThreshold: Number(raw?.lowStockThreshold ?? LOW_STOCK_DEFAULTS.lowStockThreshold),
    lowStockMinPriceCents: Number(raw?.lowStockMinPriceCents ?? LOW_STOCK_DEFAULTS.lowStockMinPriceCents),
    lowStockHoverOnly: raw?.lowStockHoverOnly ?? LOW_STOCK_DEFAULTS.lowStockHoverOnly,
  };
}

// Free-shipping threshold banner.
export interface FreeShipSettings { freeShipEnabled: boolean; freeShipThresholdCents: number; }
export const FREE_SHIP_DEFAULTS: FreeShipSettings = { freeShipEnabled: true, freeShipThresholdCents: 10000 };
export function freeShipSettings(raw: any): FreeShipSettings {
  return {
    freeShipEnabled: raw?.freeShipEnabled ?? FREE_SHIP_DEFAULTS.freeShipEnabled,
    freeShipThresholdCents: Number(raw?.freeShipThresholdCents ?? FREE_SHIP_DEFAULTS.freeShipThresholdCents),
  };
}

// Should the "Only N left" badge show for an item at this stock + price?
export function showLowStock(quantity: number, priceCents: number, s: LowStockSettings): boolean {
  return s.lowStockEnabled && quantity > 0 && quantity <= s.lowStockThreshold && priceCents >= s.lowStockMinPriceCents;
}
