// Appearance settings — the store's default color theme + whether the
// mouse-reactive checkout gem glisten is on. Lives in store_settings.settings,
// edited on the POS Settings page. The theme is a default; any device can
// override it locally (localStorage 'tl-theme').

export interface ThemeSettings {
  defaultTheme: string;       // one of THEMES[].key
  gemEffectEnabled: boolean;  // mouse-reactive glisten on checkout category gems
}

export const THEME_DEFAULTS: ThemeSettings = {
  defaultTheme: "default",
  gemEffectEnabled: true,
};

// The selectable palettes. "default" = the base brand tokens in :root; the rest
// are :root[data-theme="…"] overrides in global.css.
export const THEMES = [
  { key: "default", label: "Coffee", swatch: "#2b1809", accent: "#df5e39" },
  { key: "bright", label: "Bright", swatch: "#3a2410", accent: "#f56a3f" },
  { key: "light", label: "Light", swatch: "#f4ece2", accent: "#df5e39" },
  { key: "midnight", label: "Midnight", swatch: "#06040a", accent: "#df5e39" },
] as const;

export const THEME_KEYS = THEMES.map((t) => t.key);

export function themeSettings(raw: any): ThemeSettings {
  const t = String(raw?.defaultTheme ?? THEME_DEFAULTS.defaultTheme);
  return {
    defaultTheme: (THEME_KEYS as readonly string[]).includes(t) ? t : THEME_DEFAULTS.defaultTheme,
    gemEffectEnabled: raw?.gemEffectEnabled ?? THEME_DEFAULTS.gemEffectEnabled,
  };
}
