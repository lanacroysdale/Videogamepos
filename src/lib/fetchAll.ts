// Supabase (PostgREST) returns at most 1,000 rows per request — anything past
// that is silently dropped. Catalog loads (checkout, inventory, trade-in) must
// page through everything: request `from…to` windows until a short page.
// The query MUST have a stable order (end it with .order("id")) so pages
// don't overlap or skip rows.
export const PAGE = 1000;

export async function fetchAll<T = any>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
): Promise<{ data: T[]; error: any }> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) return { data: out, error };
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return { data: out, error: null };
  }
}
