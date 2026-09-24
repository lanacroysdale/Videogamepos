// Zero-dependency QR code encoder (ISO/IEC 18004), byte mode, any version
// 1–40, all four error-correction levels. Returns the module matrix; the SVG
// helpers below draw it. Runs server-side (settings QR generator, emails) and
// in the browser (warranty labels through the label print pipeline) — hence
// no canvas, no DOM. Structure follows Project Nayuki's reference encoder.
//
// Payloads here are short URLs (a warranty link is ~30 chars → version 3 at
// level M, 29×29 modules), so a sticker-sized code stays coarse enough for a
// 203dpi thermal printer.

export type QrEcc = "L" | "M" | "Q" | "H";
export type QrCode = { size: number; modules: boolean[][]; version: number; ecc: QrEcc };

const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };
const ECC_IDX: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };

// Indexed [ecc][version]; version 0 is unused.
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const getBit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}
const numDataCodewords = (ver: number, ecc: QrEcc) =>
  Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ECC_IDX[ecc]][ver] * NUM_ERROR_CORRECTION_BLOCKS[ECC_IDX[ecc]][ver];

// ---- Reed–Solomon over GF(2^8) with the QR polynomial 0x11D ----
function rsMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree: number): number[] {
  const result: number[] = new Array(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}
function rsRemainder(data: number[], divisor: number[]): number[] {
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= rsMultiply(coef, factor)));
  }
  return result;
}

function addEccAndInterleave(data: number[], ver: number, ecc: QrEcc): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ECC_IDX[ecc]][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ECC_IDX[ecc]][ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const rsDiv = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    const eccBytes = rsRemainder(dat, rsDiv);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(eccBytes));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// ---- Matrix drawing ----
function alignmentPatternPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

class Matrix {
  size: number;
  modules: boolean[][];
  isFunction: boolean[][];
  version: number;
  ecc: QrEcc;
  constructor(version: number, ecc: QrEcc) {
    this.version = version;
    this.ecc = ecc;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }
  setFn(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
  drawFunctionPatterns() {
    const n = this.size;
    for (let i = 0; i < n; i++) { this.setFn(6, i, i % 2 === 0); this.setFn(i, 6, i % 2 === 0); }
    this.drawFinder(3, 3); this.drawFinder(n - 4, 3); this.drawFinder(3, n - 4);
    const align = alignmentPatternPositions(this.version);
    const na = align.length;
    for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
      if (!((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0))) this.drawAlignment(align[i], align[j]);
    }
    this.drawFormatBits(0);
    this.drawVersion();
  }
  drawFinder(x: number, y: number) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFn(xx, yy, dist !== 2 && dist !== 4);
    }
  }
  drawAlignment(x: number, y: number) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.setFn(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormatBits(mask: number) {
    const data = (ECC_FORMAT_BITS[this.ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.setFn(8, i, getBit(bits, i));
    this.setFn(8, 7, getBit(bits, 6));
    this.setFn(8, 8, getBit(bits, 7));
    this.setFn(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFn(14 - i, 8, getBit(bits, i));
    const n = this.size;
    for (let i = 0; i < 8; i++) this.setFn(n - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFn(8, n - 15 + i, getBit(bits, i));
    this.setFn(8, n - 8, true);
  }
  drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = this.size - 11 + (i % 3), b = Math.floor(i / 3);
      this.setFn(a, b, bit);
      this.setFn(b, a, bit);
    }
  }
  drawCodewords(data: number[]) {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // hop over the vertical timing column
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }
  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) {
      let invert = false;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
    }
  }
  // Standard penalty rules (N1=3, N2=3, N3=40, N4=10); lowest score wins.
  penalty(): number {
    const n = this.size, m = this.modules;
    let result = 0;
    const runs = (get: (i: number, j: number) => boolean) => {
      for (let i = 0; i < n; i++) {
        let runColor = false, runLen = 0;
        const hist = [0, 0, 0, 0, 0, 0, 0];
        for (let j = 0; j < n; j++) {
          const c = get(i, j);
          if (c === runColor) {
            runLen++;
            if (runLen === 5) result += 3; else if (runLen > 5) result++;
          } else {
            hist.shift(); hist.push(runLen);
            if (!runColor && finderLike(hist)) result += 40;
            runColor = c; runLen = 1;
          }
        }
        hist.shift(); hist.push(runLen);
        if (runColor) { hist.shift(); hist.push(0); }
        if (finderLike(hist)) result += 40;
      }
    };
    const finderLike = (h: number[]) => {
      // …dark 1:1:3:1:1 dark with ≥4 light on one side (history = 7 runs, last is current light run)
      const core = h[1] > 0 && h[2] === h[1] && h[3] === h[1] * 3 && h[4] === h[1] && h[5] === h[1];
      return core && (h[0] >= 4 * h[1] || h[6] >= 4 * h[1]);
    };
    runs((y, x) => m[y][x]);
    runs((x, y) => m[y][x]);
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
    }
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const total = n * n;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  }
}

/** Encode text (UTF-8, byte mode) at the smallest version that fits. */
export function encodeQr(text: string, ecc: QrEcc = "M", opts?: { minVersion?: number; maxVersion?: number }): QrCode {
  const bytes = Array.from(new TextEncoder().encode(text));
  const minV = Math.max(1, opts?.minVersion ?? 1), maxV = Math.min(40, opts?.maxVersion ?? 40);
  let version = -1;
  for (let v = minV; v <= maxV; v++) {
    const countBits = v <= 9 ? 8 : 16;
    const used = 4 + countBits + bytes.length * 8;
    if (used <= numDataCodewords(v, ecc) * 8) { version = v; break; }
  }
  if (version < 0) throw new Error("Text too long for a QR code");

  const bits: number[] = [];
  const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0x4, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = numDataCodewords(version, ecc) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = new Array(bits.length / 8).fill(0);
  bits.forEach((b, i) => (data[i >>> 3] |= b << (7 - (i & 7))));

  const q = new Matrix(version, ecc);
  q.drawFunctionPatterns();
  q.drawCodewords(addEccAndInterleave(data, version, ecc));
  let best = -1, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    q.applyMask(mask);
    q.drawFormatBits(mask);
    const s = q.penalty();
    if (s < bestScore) { bestScore = s; best = mask; }
    q.applyMask(mask); // undo (XOR)
  }
  q.applyMask(best);
  q.drawFormatBits(best);
  return { size: q.size, modules: q.modules, version, ecc };
}

/** One SVG path (unit modules, origin 0,0) covering every dark module. */
export function qrPath(qr: QrCode): string {
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    // Merge horizontal runs into one rect each — fewer path ops, cleaner print.
    let x = 0;
    while (x < qr.size) {
      if (!qr.modules[y][x]) { x++; continue; }
      let w = 1;
      while (x + w < qr.size && qr.modules[y][x + w]) w++;
      parts.push(`M${x} ${y}h${w}v1h-${w}z`);
      x += w;
    }
  }
  return parts.join("");
}

/**
 * A group (no <svg> wrapper) that draws the code inside a box at (x, y) of
 * `sizeMm` — for embedding in the label renderer. quietModules = light
 * border in module units (spec says 4; 2 is fine for a sticker on white).
 */
export function qrSvgGroup(qr: QrCode, x: number, y: number, sizeMm: number, quietModules = 2, fill = "#000"): string {
  const total = qr.size + quietModules * 2;
  const s = sizeMm / total;
  const off = quietModules * s;
  return `<g transform="translate(${(x + off).toFixed(3)} ${(y + off).toFixed(3)}) scale(${s.toFixed(4)})"><path fill="${fill}" shape-rendering="crispEdges" d="${qrPath(qr)}"/></g>`;
}

/** Standalone SVG document (px units; `px` = size of the whole image). */
export function qrSvg(text: string, opts?: { ecc?: QrEcc; px?: number; quiet?: number; fg?: string; bg?: string }): string {
  const qr = encodeQr(text, opts?.ecc ?? "M");
  const quiet = opts?.quiet ?? 4;
  const total = qr.size + quiet * 2;
  const px = opts?.px ?? 512;
  const fg = opts?.fg ?? "#000", bg = opts?.bg ?? "#fff";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="${bg}"/>` +
    `<path fill="${fg}" transform="translate(${quiet} ${quiet})" d="${qrPath(qr)}"/></svg>`;
}
