import { AwsClient } from "aws4fetch";

// Where product/menu photos live. When the R2_* env vars are set, photos go to
// Cloudflare R2 (10GB free, no bandwidth fees); otherwise they fall back to the
// Supabase "product-images" bucket. Paths are the same in both ("products/…",
// "menu/…"), so moving between them is a copy + a URL-prefix swap.
// Custom label fonts stay in Supabase (tiny, and fetched server-side).

const env = (k: string): string => ((import.meta.env as any)?.[k] ?? process.env[k] ?? "").trim();

export const SUPABASE_BUCKET = "product-images";

const r2 = () => ({
  accountId: env("R2_ACCOUNT_ID"),
  accessKeyId: env("R2_ACCESS_KEY_ID"),
  secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
  bucket: env("R2_BUCKET"),
  publicUrl: env("R2_PUBLIC_URL").replace(/\/+$/, ""),
});

export function r2Configured(): boolean {
  const c = r2();
  return !!(c.accountId && c.accessKeyId && c.secretAccessKey && c.bucket && c.publicUrl);
}

// Supabase's public URL prefix for this bucket (what old links start with).
export function supabasePublicPrefix(): string {
  const base = env("PUBLIC_SUPABASE_URL").replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${SUPABASE_BUCKET}/`;
}
export const r2PublicPrefix = () => `${r2().publicUrl}/`;

let client: AwsClient | null = null;
function aws() {
  const c = r2();
  client ??= new AwsClient({
    accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, service: "s3", region: "auto",
  });
  return client;
}
const objectUrl = (key: string) => {
  const c = r2();
  const k = key.split("/").map(encodeURIComponent).join("/");
  return `https://${c.accountId}.r2.cloudflarestorage.com/${c.bucket}/${k}`;
};

// ---- R2 primitives -------------------------------------------------------

export async function r2Put(key: string, bytes: Uint8Array, contentType: string) {
  const res = await aws().fetch(objectUrl(key), {
    method: "PUT",
    body: bytes as BodyInit,
    headers: { "content-type": contentType, "cache-control": "public, max-age=31536000" },
  });
  if (!res.ok) throw new Error(`R2 upload ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export async function r2Delete(keys: string[]) {
  const CONC = 8;
  for (let i = 0; i < keys.length; i += CONC) {
    await Promise.all(keys.slice(i, i + CONC).map(async (k) => {
      const res = await aws().fetch(objectUrl(k), { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`R2 delete ${k}: ${res.status}`);
    }));
  }
}

const unxml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// Every object under `prefix` (all pages), as { key, size }.
export async function r2List(prefix: string): Promise<{ key: string; size: number }[]> {
  const c = r2();
  const out: { key: string; size: number }[] = [];
  let token = "";
  for (;;) {
    const q = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
    if (token) q.set("continuation-token", token);
    const res = await aws().fetch(`https://${c.accountId}.r2.cloudflarestorage.com/${c.bucket}?${q}`);
    if (!res.ok) throw new Error(`R2 list: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = unxml(/<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1] ?? "");
      const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0);
      if (key) out.push({ key, size });
    }
    token = unxml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "");
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !token) break;
  }
  return out;
}

// ---- Backend-agnostic helpers (R2 when configured, else Supabase) --------

// Upload a photo; returns its public URL.
export async function putImage(admin: any, path: string, bytes: Uint8Array, contentType: string, upsert = false) {
  if (r2Configured()) {
    await r2Put(path, bytes, contentType);
    return `${r2PublicPrefix()}${path}`;
  }
  const { error } = await admin.storage.from(SUPABASE_BUCKET).upload(path, bytes, { contentType, upsert });
  if (error) throw new Error(error.message);
  return admin.storage.from(SUPABASE_BUCKET).getPublicUrl(path).data.publicUrl as string;
}

// File names (not full paths) directly inside `folder`, sorted, plus which
// store they came from. R2 first; if it has nothing (folder not migrated
// yet), whatever Supabase still holds.
export async function listFolder(admin: any, folder: string): Promise<{ names: string[]; inR2: boolean }> {
  if (r2Configured()) {
    const names = (await r2List(`${folder}/`))
      .map((o) => o.key.slice(folder.length + 1))
      .filter((n) => n && !n.includes("/"))
      .sort();
    if (names.length) return { names, inR2: true };
  }
  const { data } = await admin.storage.from(SUPABASE_BUCKET)
    .list(folder, { limit: 100, sortBy: { column: "name", order: "asc" } });
  const names = (data || []).map((f: any) => f.name as string).filter((n: string) => n && !n.startsWith("."));
  return { names, inR2: false };
}

// Public URL of a stored path in the given store.
export function publicUrlFor(admin: any, path: string, inR2: boolean) {
  return inR2
    ? `${r2PublicPrefix()}${path}`
    : admin.storage.from(SUPABASE_BUCKET).getPublicUrl(path).data.publicUrl as string;
}

// Remove paths from wherever they are (both stores; missing is fine).
export async function removeImages(admin: any, paths: string[]) {
  if (!paths.length) return;
  if (r2Configured()) await r2Delete(paths);
  for (let i = 0; i < paths.length; i += 100) {
    await admin.storage.from(SUPABASE_BUCKET).remove(paths.slice(i, i + 100));
  }
}

// Every file in the Supabase bucket under `prefix` (folders walked, pages
// followed), sorted by path.
export type StoredFile = { path: string; size: number; mimetype: string };
export async function listSupabase(admin: any, prefix = ""): Promise<StoredFile[]> {
  const out: StoredFile[] = [];
  const walk = async (dir: string) => {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await admin.storage.from(SUPABASE_BUCKET)
        .list(dir, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`storage list: ${error.message}`);
      for (const item of data ?? []) {
        const p = dir ? `${dir}/${item.name}` : item.name;
        if (item.id === null) await walk(p);
        else out.push({ path: p, size: item.metadata?.size ?? 0, mimetype: item.metadata?.mimetype ?? "" });
      }
      if ((data?.length ?? 0) < 1000) break;
    }
  };
  await walk(prefix);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
