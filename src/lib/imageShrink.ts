import sharp from "sharp";

// Product photos are shown at most ~550 CSS px wide (the PDP main image on
// desktop), so 1200px on the long edge stays crisp on 2x retina screens while
// cutting a typical 300KB–1MB+ eBay/phone photo down to ~80–150KB.
export const MAX_EDGE = 1200;
export const WEBP_QUALITY = 82;

// Formats we re-encode. GIF (may be animated) and SVG (vector) pass through.
const SHRINKABLE = /^image\/(jpe?g|png|webp|avif|heic|heif|tiff)$/i;

// Resize to fit MAX_EDGE (never upscales), honour EXIF rotation, strip
// metadata, encode WebP. Returns the original bytes untouched if the input
// isn't a shrinkable raster, can't be decoded, or wouldn't get smaller.
export async function shrinkImage(
  bytes: Uint8Array,
  contentType: string,
): Promise<{ bytes: Uint8Array; contentType: string; shrunk: boolean }> {
  if (!SHRINKABLE.test(contentType)) return { bytes, contentType, shrunk: false };
  try {
    const out = await sharp(bytes, { failOn: "none" })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    if (out.byteLength >= bytes.byteLength) return { bytes, contentType, shrunk: false };
    return { bytes: new Uint8Array(out), contentType: "image/webp", shrunk: true };
  } catch {
    return { bytes, contentType, shrunk: false };
  }
}
