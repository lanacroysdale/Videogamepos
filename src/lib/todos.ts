// To-do helpers shared by the page + API.
export const PRIORITIES = [
  { key: "high", label: "High" },
  { key: "normal", label: "Normal" },
  { key: "low", label: "Low" },
];
export const PRIORITY_KEYS = PRIORITIES.map((p) => p.key);
export const priorityRank = (p: string) => (p === "high" ? 0 : p === "low" ? 2 : 1);

// ---- To-do categories (task_lists) ------------------------------------------
export type ListKind = "tasks" | "recurring" | "done";
export type Recurrence = "daily" | "weekly" | "monthly";
export type TaskList = { id: string; name: string; kind: ListKind; recurrence: Recurrence | null; managers_only: boolean; sort_order: number };

export const RECURRENCES: Recurrence[] = ["daily", "weekly", "monthly"];
export const RESET_HOUR = 4; // recurring checklists roll over at 4 AM store time
export const RESET_LABEL: Record<Recurrence, string> = {
  daily: "resets daily at 4 AM",
  weekly: "resets Mondays at 4 AM",
  monthly: "resets on the 1st at 4 AM",
};

// Categories offered in the "add a category" picker.
export const SUGGESTED_LISTS: { name: string; kind: ListKind; recurrence: Recurrence | null; managersOnly: boolean }[] = [
  { name: "POS improvements", kind: "tasks", recurrence: null, managersOnly: false },
  { name: "Daily checklist", kind: "recurring", recurrence: "daily", managersOnly: false },
  { name: "Open", kind: "tasks", recurrence: null, managersOnly: false },
  { name: "Done", kind: "done", recurrence: null, managersOnly: false },
  { name: "Management", kind: "tasks", recurrence: null, managersOnly: true },
];

// Best guess at a typed category's type, so "Weekly checklist" just works.
export function inferList(name: string): { kind: ListKind; recurrence: Recurrence | null; managersOnly: boolean } {
  const n = name.trim().toLowerCase();
  const managersOnly = /\bmanage(ment|r|rs)?\b/.test(n);
  if (n === "done" || n === "completed") return { kind: "done", recurrence: null, managersOnly: false };
  if (/\bdaily\b/.test(n)) return { kind: "recurring", recurrence: "daily", managersOnly };
  if (/\bweekly\b/.test(n)) return { kind: "recurring", recurrence: "weekly", managersOnly };
  if (/\bmonthly\b/.test(n)) return { kind: "recurring", recurrence: "monthly", managersOnly };
  if (/\bchecklist\b/.test(n)) return { kind: "recurring", recurrence: "daily", managersOnly };
  return { kind: "tasks", recurrence: null, managersOnly };
}

// The period a recurring check-off belongs to, as the period's start date
// (YYYY-MM-DD): the store-local day, the Monday, or the 1st — where each
// period begins at RESET_HOUR, not midnight. Works in the browser too.
export function periodKey(recurrence: Recurrence, now: Date = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23" })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  const d = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
  if (+parts.hour < RESET_HOUR) d.setUTCDate(d.getUTCDate() - 1); // still "yesterday" until 4 AM
  if (recurrence === "weekly") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  if (recurrence === "monthly") d.setUTCDate(1);
  return d.toISOString().slice(0, 10);
}
