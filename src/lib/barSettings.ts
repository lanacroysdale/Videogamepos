// Bar / tab config — lives in store_settings.settings (jsonb), edited on the POS
// Settings page (Food & Beverage panel), read by the tabs API + auto-close cron.

export interface BarSettings {
  tabClosingTime: string;          // "HH:MM" Portland-local; "" = no auto-close
  tabAutoGratuityEnabled: boolean; // force gratuity on tabs left open at closing
  tabAutoGratuityPercent: number;  // integer percent (e.g. 25)
}

export const BAR_DEFAULTS: BarSettings = {
  tabClosingTime: "",
  tabAutoGratuityEnabled: true,
  tabAutoGratuityPercent: 25,
};

export function barSettings(raw: any): BarSettings {
  const pct = Math.round(Number(raw?.tabAutoGratuityPercent));
  const t = raw?.tabClosingTime;
  return {
    tabClosingTime: typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : BAR_DEFAULTS.tabClosingTime,
    tabAutoGratuityEnabled: raw?.tabAutoGratuityEnabled ?? BAR_DEFAULTS.tabAutoGratuityEnabled,
    tabAutoGratuityPercent: Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : BAR_DEFAULTS.tabAutoGratuityPercent,
  };
}

// Whether departments are locked from editing (governed config). Editing while
// locked requires owner + (if set) the company LICENSE_UNLOCK_CODE.
export function departmentsLocked(raw: any): boolean {
  return raw?.departmentsLocked === true;
}

// Current wall-clock minutes-since-midnight in a timezone (default Portland).
export function localMinutes(now: Date, tz = "America/Los_Angeles"): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(now);
  const h = (Number(parts.find((p) => p.type === "hour")?.value) || 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value) || 0;
  return h * 60 + m;
}

// True when `now` (in tz) falls within `windowMin` minutes AFTER the "HH:MM"
// closing time, wrapping past midnight. Lets an hourly cron sweep open tabs for
// a few runs right after close without ever firing during normal daytime.
export function withinClosingWindow(closing: string, now: Date, windowMin = 180, tz = "America/Los_Angeles"): boolean {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(closing);
  if (!m) return false;
  const close = Number(m[1]) * 60 + Number(m[2]);
  let diff = localMinutes(now, tz) - close;
  if (diff < 0) diff += 1440;
  return diff < windowMin;
}
