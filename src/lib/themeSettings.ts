// Appearance settings — the store's default color theme + whether the
// mouse-reactive checkout gem glisten is on. Lives in store_settings.settings,
// edited on the POS Settings page. The theme is a default; any device can
// override it locally (localStorage 'tl-theme').

export interface ThemeSettings {
  defaultTheme: string;       // one of THEMES[].key (the palette)
  defaultSidebar: string;     // one of SIDEBARS[].key (POS sidebar accent)
  themePosOnly: boolean;      // true = palette applies in the POS only, public site stays default
  gemEffectEnabled: boolean;  // mouse-reactive glisten on checkout category gems
}

export const THEME_DEFAULTS: ThemeSettings = {
  defaultTheme: "default",
  defaultSidebar: "default",
  themePosOnly: false,
  gemEffectEnabled: true,
};

// The selectable palettes. "default" = the base brand tokens in :root; the rest
// are :root[data-theme="…"] overrides in global.css.
export const THEMES = [
  { key: "default", label: "Coffee", swatch: "#2b1809", accent: "#df5e39" },
  { key: "bright", label: "Bright", swatch: "#3a2410", accent: "#f56a3f" },
  { key: "light", label: "Light", swatch: "#f4ece2", accent: "#df5e39" },
  { key: "midnight", label: "Midnight", swatch: "#06040a", accent: "#df5e39" },
  { key: "glass", label: "Liquid Glass", swatch: "#1a1330", accent: "#7fd6e6" },
] as const;

// POS sidebar accent — an independent axis layered on any palette (data-sidebar).
export const SIDEBARS = [
  { key: "default", label: "Default", swatch: "#2b1809" },
  { key: "blue", label: "Blue", swatch: "#5aa6b8" },
  { key: "pink", label: "Pink", swatch: "#f39ccd" },
  { key: "orange", label: "Orange", swatch: "#df5e39" },
] as const;

export const THEME_KEYS = THEMES.map((t) => t.key);
export const SIDEBAR_KEYS = SIDEBARS.map((s) => s.key);

export function themeSettings(raw: any): ThemeSettings {
  const t = String(raw?.defaultTheme ?? THEME_DEFAULTS.defaultTheme);
  const s = String(raw?.defaultSidebar ?? THEME_DEFAULTS.defaultSidebar);
  return {
    defaultTheme: (THEME_KEYS as readonly string[]).includes(t) ? t : THEME_DEFAULTS.defaultTheme,
    defaultSidebar: (SIDEBAR_KEYS as readonly string[]).includes(s) ? s : THEME_DEFAULTS.defaultSidebar,
    themePosOnly: raw?.themePosOnly ?? THEME_DEFAULTS.themePosOnly,
    gemEffectEnabled: raw?.gemEffectEnabled ?? THEME_DEFAULTS.gemEffectEnabled,
  };
}
