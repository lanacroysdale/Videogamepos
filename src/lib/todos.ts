// To-do helpers shared by the page + API.
export const PRIORITIES = [
  { key: "high", label: "High" },
  { key: "normal", label: "Normal" },
  { key: "low", label: "Low" },
];
export const PRIORITY_KEYS = PRIORITIES.map((p) => p.key);
export const priorityRank = (p: string) => (p === "high" ? 0 : p === "low" ? 2 : 1);

// The store-local (Portland) calendar date, so the daily checklist resets at
// local midnight regardless of where the server runs.
export function storeToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}
