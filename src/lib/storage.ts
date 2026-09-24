import { shrinkImage } from "./imageShrink";
import { putImage, listFolder, publicUrlFor, removeImages, StorageCapError } from "./imageStore";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const extFor = (ct: string) => (ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg");

// Copy an external image into our own photo storage (R2, or the Supabase
// bucket if R2 isn't configured — see imageStore.ts) so we own a stable URL
// (external hosts like eBay/IGDB can rotate or expire links).
// Shrunk to web size (see imageShrink.ts) before upload so storage stays
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
      return await putImage(admin, path, bytes, ct);
    } catch (e) {
      if (e instanceof StorageCapError) return null; // full — retrying won't help
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
  const { names, inR2 } = await listFolder(admin, folder).catch(() => ({ names: [] as string[], inR2: false }));
  return names.map((n) => publicUrlFor(admin, `${folder}/${n}`, inR2));
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
          await putImage(admin, `${folder}/${file}`, bytes, ct, true);
          copied++; written.add(file); return;
        } catch (e) {
          if (e instanceof StorageCapError) return;
          await sleep(500);
        }
      }
    });
    await Promise.all(batch);
  }
  // A re-import can write 00.webp where 00.jpg already exists — drop the old
  // same-index copy so the gallery doesn't show it twice.
  if (written.size) {
    const { names } = await listFolder(admin, folder).catch(() => ({ names: [] as string[] }));
    const indexOf = (f: string) => f.split(".")[0];
    const newIdx = new Set([...written].map(indexOf));
    const stale = names
      .filter((n) => newIdx.has(indexOf(n)) && !written.has(n))
      .map((n) => `${folder}/${n}`);
    await removeImages(admin, stale).catch(() => {});
  }
  return copied;
}
