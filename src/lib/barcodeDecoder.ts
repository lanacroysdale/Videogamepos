// Camera barcode decoding that works on EVERY phone, not just Chrome/Android.
//
// Chrome ships a native BarcodeDetector; Safari (iPhone/iPad, and Chrome on
// iOS which is Safari underneath) doesn't. Sites that scan on iPhones do it
// in software — this picks the native decoder when it genuinely reads retail
// codes, and otherwise lazy-loads a ZXing-C++ WebAssembly build (the same
// engine behind most web scanners) that exposes the identical detect() API.
// The .wasm (~1 MB) is bundled with the site (served from our own host, no
// CDN) and only downloaded when the fallback is actually needed.

export type DecodedBarcode = { rawValue: string; format: string };
export type BarcodeDecoder = {
  engine: "native" | "zxing";
  detect: (source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap) => Promise<DecodedBarcode[]>;
};

// The formats a game shop meets: retail UPC/EAN on boxes, Code 128 on our own
// price labels (numeric label codes + "TL…" internal codes), Code 39 on some
// distributor stickers, QR for anything else.
export const SCAN_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"] as const;
const REQUIRED = ["ean_13", "upc_a", "code_128"];

let cached: Promise<BarcodeDecoder> | null = null;

async function nativeDecoder(): Promise<BarcodeDecoder | null> {
  const BD = (window as any).BarcodeDetector;
  if (!BD) return null;
  try {
    // Some builds expose the class but decode nothing useful (or nothing at
    // all) — trust it only when it lists the retail formats we depend on.
    const supported: string[] = await BD.getSupportedFormats();
    if (!REQUIRED.every((f) => supported.includes(f))) return null;
    const det = new BD({ formats: SCAN_FORMATS.filter((f) => supported.includes(f)) });
    return { engine: "native", detect: (src) => det.detect(src) };
  } catch {
    return null;
  }
}

async function zxingDecoder(): Promise<BarcodeDecoder> {
  const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
    import("barcode-detector/ponyfill"),
    import("zxing-wasm/reader/zxing_reader.wasm?url"),
  ]);
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
    },
    fireImmediately: true,
  });
  const det = new BarcodeDetector({ formats: [...SCAN_FORMATS] });
  return { engine: "zxing", detect: (src) => det.detect(src as any) };
}

// Resolve once per page; every caller shares the same decoder instance.
export function loadBarcodeDecoder(): Promise<BarcodeDecoder> {
  if (!cached) {
    cached = (async () => (await nativeDecoder()) ?? (await zxingDecoder()))().catch((e) => {
      cached = null; // let a later call retry (e.g. transient network failure fetching the .wasm)
      throw e;
    });
  }
  return cached;
}
