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
const SUPABASE_MARKER = `/storage/v1/object/public/${SUPABASE_BUCKET}/`;

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
        await r.put(path, await toBytes(body), opts.contentType || "application/octet-stream", cache);
        return { data: { path }, error: null };
      } catch (e) { return { data: null, error: errOf(e) }; }
    },

    getPublicUrl(path: string) {
      return { data: { publicUrl: r.publicUrl(path) } };
    },

    // One folder level, files and sub-folders together, by name — like
    // Supabase's list (a sub-folder comes back with id: null).
    async list(folder = "", opts: { limit?: number } = {}): Promise<{ data: ListItem[] | null; error: Err }> {
      try {
        const prefix = folder ? folder.replace(/\/+$/, "") + "/" : "";
        const { keys, prefixes } = await r.list(prefix, { delimiter: "/", max: opts.limit ?? 100 });
        const items: ListItem[] = [
          ...prefixes.map((p) => ({ name: p.slice(prefix.length).replace(/\/$/, ""), id: null })),
          ...keys.map((k) => ({ name: k.key.slice(prefix.length), id: k.key, metadata: { size: k.size } })),
        ];
        items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return { data: items.slice(0, opts.limit ?? 100), error: null };
      } catch (e) { return { data: null, error: errOf(e) }; }
    },

    async remove(paths: string[]): Promise<{ data: { name: string }[] | null; error: Err }> {
      try {
        for (let i = 0; i < paths.length; i += 8) await Promise.all(paths.slice(i, i + 8).map((p) => r.remove(p)));
        return { data: paths.map((name) => ({ name })), error: null };
      } catch (e) { return { data: null, error: errOf(e) }; }
    },

    async copy(from: string, to: string): Promise<{ data: { path: string } | null; error: Err }> {
      try { await r.copy(from, to); return { data: { path: to }, error: null }; }
      catch (e) { return { data: null, error: errOf(e) }; }
    },
  };
}

/** The bucket path when `url` is one of our stored images (R2 or Supabase), else null. */
export function imagePathOf(url: string): string | null {
  if (R2) return R2.keyOf(url);
  const i = url.indexOf(SUPABASE_MARKER);
  if (i < 0) return null;
  try { return decodeURIComponent(url.slice(i + SUPABASE_MARKER.length).split(/[?#]/)[0]); } catch { return null; }
}
