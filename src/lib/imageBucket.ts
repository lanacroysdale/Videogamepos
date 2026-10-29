import { r2, r2Configured, type R2Config } from "./r2";

// Where product photos, menu photos, label logos and label fonts live.
// With the R2_* env vars set it's Cloudflare R2 (served from R2_PUBLIC_URL —
// free egress, 10 GB free); without them it's the Supabase "product-images"
// bucket, as before. Supabase's free plan caps storage at 1 GB and egress at
// 5 GB, and photos were most of both — the project got restricted Oct 2026.
//
// imageBucket(admin) answers the same calls as supabase-js's
// admin.storage.from("product-images") (upload / getPublicUrl / list / remove /
// copy, same result shapes), so callers don't care which one is behind it.

// (Each read spelled out: Vite only fills in import.meta.env.X written literally.)
const cfg: Partial<R2Config> = {
  accountId: (import.meta.env.R2_ACCOUNT_ID ?? process.env.R2_ACCOUNT_ID ?? "").trim(),
  accessKeyId: (import.meta.env.R2_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID ?? "").trim(),
  secretAccessKey: (import.meta.env.R2_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY ?? "").trim(),
  bucket: (import.meta.env.R2_BUCKET ?? process.env.R2_BUCKET ?? "").trim(),
  publicUrl: (import.meta.env.R2_PUBLIC_URL ?? process.env.R2_PUBLIC_URL ?? "").trim(),
};
const R2 = r2Configured(cfg) ? r2(cfg) : null;

const SUPABASE_BUCKET = "product-images";
// This project's public bucket address (another project's look-alike URL isn't ours).
const SUPABASE_URL = String(import.meta.env.PUBLIC_SUPABASE_URL ?? process.env.PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_PREFIX = SUPABASE_URL ? `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/` : "\0"; // "\0": matches nothing
const EXISTS = { message: "The resource already exists" }; // Supabase's wording

type Err = { message: string } | null;
type Body = Uint8Array | ArrayBuffer | Blob;
type ListItem = { name: string; id: string | null; metadata?: { size: number } };

const toBytes = async (b: Body) =>
  b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(await b.arrayBuffer());
const errOf = (e: unknown): { message: string } => ({ message: e instanceof Error ? e.message : String(e) });

export function imageBucket(admin: any) {
  if (!R2) return admin.storage.from(SUPABASE_BUCKET);
  const r = R2;
  return {
    async upload(path: string, body: Body, opts: { contentType?: string; upsert?: boolean; cacheControl?: string } = {}): Promise<{ data: { path: string } | null; error: Err }> {
      try {
        // A file with a random (uuid) name never changes → cache for a year.
        // Reusable names (gallery 00, 01…) → an hour, like Supabase did.
        const fresh = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(path.split("/").pop()!.replace(/^[a-z]+-/, ""));
        const cache = opts.cacheControl ? `public, max-age=${opts.cacheControl}`
          : fresh && !opts.upsert ? "public, max-age=31536000, immutable" : "public, max-age=3600";
        // Supabase refuses to overwrite unless upsert is set; so does this.
        if (!opts.upsert && (await r.exists(path))) return { data: null, error: EXISTS };
        await r.put(path, await toBytes(body), opts.contentType || "application/octet-stream", cache);
        return { data: { path }, error: null };
      } catch (e) { return { data: null, error: errOf(e) }; }
    },

    getPublicUrl(path: string) {
      return { data: { publicUrl: r.publicUrl(path) } };
    },

    // One folder level, like Supabase's list: sub-folders first (id: null),
    // then files, each by name; `limit` / `offset` apply to that whole list.
    async list(folder = "", opts: { limit?: number; offset?: number } = {}): Promise<{ data: ListItem[] | null; error: Err }> {
      try {
        const prefix = folder ? folder.replace(/\/+$/, "") + "/" : "";
        const byName = (a: ListItem, b: ListItem) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        const { keys, prefixes } = await r.list(prefix, { delimiter: "/" });
        const items: ListItem[] = [
          ...prefixes.map((p) => ({ name: p.slice(prefix.length).replace(/\/$/, ""), id: null })).sort(byName),
          ...keys.map((k) => ({ name: k.key.slice(prefix.length), id: k.key, metadata: { size: k.size } })).sort(byName),
        ];
        const from = opts.offset ?? 0;
        return { data: items.slice(from, from + (opts.limit ?? 100)), error: null };
      } catch (e) { return { data: null, error: errOf(e) }; }
    },

    async remove(paths: string[]): Promise<{ data: { name: string }[] | null; error: Err }> {
      try {
        for (let i = 0; i < paths.length; i += 8) await Promise.all(paths.slice(i, i + 8).map((p) => r.remove(p)));
        return { data: paths.map((name) => ({ name })), error: null };
      } catch (e) { return { data: null, error: errOf(e) }; }
    },

    async copy(from: string, to: string): Promise<{ data: { path: string } | null; error: Err }> {
      try {
        if (await r.exists(to)) return { data: null, error: EXISTS };
        await r.copy(from, to);
        return { data: { path: to }, error: null };
      }
      catch (e) { return { data: null, error: errOf(e) }; }
    },
  };
}

// The bucket path inside one of this project's Supabase image URLs, else null.
function supabasePathOf(url: string): string | null {
  if (!url.startsWith(SUPABASE_PREFIX)) return null;
  try { return decodeURIComponent(url.slice(SUPABASE_PREFIX.length).split(/[?#]/)[0]) || null; } catch { return null; }
}

/** The bucket path when `url` is one of our stored images, else null. (Once
 * on R2, an old Supabase address maps to the same path — the move keeps paths.) */
export function imagePathOf(url: string): string | null {
  return R2 ? (R2.keyOf(url) ?? supabasePathOf(url)) : supabasePathOf(url);
}

/**
 * A URL about to be saved, with an old Supabase image address swapped for its
 * R2 one once R2 is on and R2 has that file. A POS tab opened before the move
 * still holds the old addresses and sends them back on save; after the
 * Supabase copies are deleted those would be broken for good. A file not
 * copied yet (or an R2 hiccup) keeps its Supabase address, which still works
 * and which the next images:to-r2 run moves. Anything else comes back unchanged.
 */
export async function currentImageUrl<T extends string | null | undefined>(url: T): Promise<T> {
  if (!R2 || !url) return url;
  const path = supabasePathOf(url);
  if (!path) return url;
  try { return ((await R2.exists(path)) ? R2.publicUrl(path) : url) as T; } catch { return url; }
}
