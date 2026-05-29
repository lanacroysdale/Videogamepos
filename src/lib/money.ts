/** Format integer cents as USD, e.g. 1999 -> "$19.99". */
export function fmt(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Parse a dollar string/number into integer cents. */
export function toCents(dollars: number | string): number {
  const n = typeof dollars === "string" ? parseFloat(dollars) : dollars;
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function fullName(c: { first_name: string; last_name: string }): string {
  return `${c.first_name} ${c.last_name}`.trim();
}
