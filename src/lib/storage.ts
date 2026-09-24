import { shrinkImage } from "./imageShrink";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const extFor = (ct: string) => (ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg");

// Copy an external image into our own Supabase Storage bucket so we own a
// stable URL (external hosts like eBay/IGDB can rotate or expire links).
// Shrunk to web size (see imageShrink.ts) before upload so the bucket stays
// small. Retries on transient network failures. Returns the public URL, or null.
export async function copyImageToStorage(
  admin: any,
  url: string,
  prefix = "cover",
): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) { await sleep(600); continue; }
      const { bytes, contentType: ct } = await shrinkImage(
        new Uint8Array(await res.arrayBuffer()), res.headers.get("content-type") || "image/jpeg");
      const path = `products/${prefix}-${crypto.randomUUID()}.${extFor(ct)}`;
      const { error } = await admin.storage.from("product-images").upload(path, bytes, { contentType: ct });
      if (error) { await sleep(600); continue; }
      return admin.storage.from("product-images").getPublicUrl(path).data.publicUrl;
    } catch {
      await sleep(700);
    }
  }
  return null;
}

// The per-product gallery folder. The PDP lists this folder (sorted by name) to
// build the image gallery, so no DB column is needed.
export const galleryFolder = (productId: string) => `products/gallery/${productId}`;

// List a product's gallery image URLs (ordered). Returns [] if none.
export async function listGallery(admin: any, productId: string): Promise<string[]> {
  const folder = galleryFolder(productId);
  const { data } = await admin.storage.from("product-images")
    .list(folder, { limit: 50, sortBy: { column: "name", order: "asc" } });
  return (data || [])
    .filter((f: any) => f.name && !f.name.startsWith("."))
    .map((f: any) => admin.storage.from("product-images").getPublicUrl(`${folder}/${f.name}`).data.publicUrl);
}

// Copy up to `max` images into the product's gallery folder, named 00,01,…
// (zero-padded so listing them back preserves order). Returns the count copied.
export async function copyGallery(
  admin: any,
  urls: string[],
  productId: string,
  max = 16,
): Promise<number> {
  const folder = galleryFolder(productId);
  const list = urls.slice(0, max);
  let copied = 0;
  const written = new Set<string>();
  // Small concurrency keeps it quick without hammering eBay/storage.
  const CONC = 3;
  for (let i = 0; i < list.length; i += CONC) {
    const batch = list.slice(i, i + CONC).map(async (url, j) => {
      const name = String(i + j).padStart(2, "0");
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url);
          if (!res.ok) { await sleep(400); continue; }
          const { bytes, contentType: ct } = await shrinkImage(
            new Uint8Array(await res.arrayBuffer()), res.headers.get("content-type") || "image/jpeg");
          const file = `${name}.${extFor(ct)}`;
          const { error } = await admin.storage.from("product-images")
            .upload(`${folder}/${file}`, bytes, { contentType: ct, upsert: true });
          if (!error) { copied++; written.add(file); return; }
          await sleep(400);
        } catch { await sleep(500); }
      }
    });
    await Promise.all(batch);
  }
  // A re-import can write 00.webp where 00.jpg already exists — drop the old
  // same-index copy so the gallery doesn't show it twice.
  if (written.size) {
    const { data } = await admin.storage.from("product-images").list(folder, { limit: 100 });
    const indexOf = (f: string) => f.split(".")[0];
    const newIdx = new Set([...written].map(indexOf));
    const stale = (data || [])
      .map((f: any) => f.name as string)
      .filter((n: string) => n && newIdx.has(indexOf(n)) && !written.has(n))
      .map((n: string) => `${folder}/${n}`);
    if (stale.length) await admin.storage.from("product-images").remove(stale);
  }
  return copied;
}
