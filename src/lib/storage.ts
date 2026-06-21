// Copy an external image into our own Supabase Storage bucket so we own a
// stable URL (external hosts like eBay/IGDB can rotate or expire links).
// Retries on transient network failures. Returns the public URL, or null.
export async function copyImageToStorage(
  admin: any,
  url: string,
  prefix = "cover",
): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) { await new Promise((r) => setTimeout(r, 600)); continue; }
      const ct = res.headers.get("content-type") || "image/jpeg";
      const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
      const bytes = new Uint8Array(await res.arrayBuffer());
      const path = `products/${prefix}-${crypto.randomUUID()}.${ext}`;
      const { error } = await admin.storage.from("product-images").upload(path, bytes, { contentType: ct });
      if (error) { await new Promise((r) => setTimeout(r, 600)); continue; }
      return admin.storage.from("product-images").getPublicUrl(path).data.publicUrl;
    } catch {
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  return null;
}
