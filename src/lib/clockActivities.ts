// Clock-in activities — what staff tag their time against. Data-driven (kept in
// store_settings.settings.clockActivities) so a licensee can retune the list;
// defaults to the owner's set.
export const DEFAULT_CLOCK_ACTIVITIES = [
  "Shipping packages",
  "Processing inventory",
  "Mods & refurbishment",
  "Website",
  "POS",
  "Design",
  "Marketing",
];

export function clockActivities(raw: any): string[] {
  const a = raw?.clockActivities;
  return Array.isArray(a) && a.length ? a.map((x: any) => String(x)).filter(Boolean) : DEFAULT_CLOCK_ACTIVITIES;
}
