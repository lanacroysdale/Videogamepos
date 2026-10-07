// Direct-to-Zebra printing via the free Zebra Browser Print agent
// (https://www.zebra.com/browserprint) — bypasses macOS printing entirely.
// No print dialogs, no paper sizes, no orientation, no driver scaling: the
// label is rendered here at the head's exact dot pitch and shipped as native
// ZPL, so what the POS composes is what the head burns, dot for dot. The ZPL
// also declares the label length (^LL) and gap tracking (^MN), which stops
// the runaway blank-label feeding a mismatched macOS paper size causes.
//
// The agent serves http://127.0.0.1:9100. Chrome treats localhost as a
// secure context, so the HTTPS POS may call it; the agent asks the user to
// approve the site on first contact. Requests are sent without custom
// headers (simple requests — the agent doesn't answer CORS preflights).
import { renderLabelSvg, ensureLabelFont, type LabelTemplate, type LabelItem } from "./labels";
import { fontStyleTag, inlineLogo, escAttr, snapToInchGrid } from "./labelPdf";

export type ZebraJob = { item: LabelItem; copies: number };
export type ZebraTune = { scalePct?: number; nudgeXMm?: number; nudgeYMm?: number };

const AGENT = "http://127.0.0.1:9100";
const DOTS_PER_MM = 8; // ZD-series 203dpi class = 8 dots/mm exactly

// Resolves to the agent's default printer device (JSON blob the /write call
// needs back verbatim), or null when the agent isn't running on this station.
export async function findZebraPrinter(): Promise<{ device: any; name: string } | null> {
  try {
    const r = await fetch(`${AGENT}/default?type=printer`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    if (!t) return null;
    const j = JSON.parse(t);
    const device = j?.connection ? j : Array.isArray(j?.printer) ? j.printer[0] : null;
    if (!device?.connection) return null;
    return { device, name: String(device.name || "Zebra") };
  } catch { return null; }
}

// Render one label to a 1-bit ZPL graphic field at exact head dots.
async function labelToZplBitmap(tpl: LabelTemplate, item: LabelItem, tune?: ZebraTune, deps?: { styleTag: string; logoData: string }): Promise<{ hex: string; rowBytes: number; rows: number; pw: number }> {
  let svg = renderLabelSvg(tpl, item);
  if (deps?.styleTag) svg = svg.replace(/(<svg[^>]*>)/, `$1${deps.styleTag}`);
  if (tpl.logoUrl && deps?.logoData) svg = svg.split(escAttr(tpl.logoUrl)).join(deps.logoData).split(tpl.logoUrl).join(deps.logoData);
  return svgToZplBitmap(svg, { widthMm: tpl.widthMm, heightMm: tpl.heightMm }, tune);
}
// Any ready-made label SVG (fonts / images inlined) → the same 1-bit field.
async function svgToZplBitmap(svg: string, size: { widthMm: number; heightMm: number }, tune?: ZebraTune): Promise<{ hex: string; rowBytes: number; rows: number; pw: number }> {

  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("Label failed to render"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });

  // Canvas = the physical label at 8 dots/mm (inch-exact size).
  const pw = Math.round(snapToInchGrid(size.widthMm) * DOTS_PER_MM);
  const rows = Math.round(snapToInchGrid(size.heightMm) * DOTS_PER_MM);
  const canvas = document.createElement("canvas");
  canvas.width = pw;
  canvas.height = rows;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, pw, rows);
  const s = Math.min(100, Math.max(60, Math.round(Number(tune?.scalePct) || 100))) / 100;
  const nx = Math.min(30, Math.max(-30, Number(tune?.nudgeXMm) || 0)) * DOTS_PER_MM;
  const ny = Math.min(30, Math.max(-30, Number(tune?.nudgeYMm) || 0)) * DOTS_PER_MM;
  const dw = size.widthMm * DOTS_PER_MM * s, dh = size.heightMm * DOTS_PER_MM * s;
  ctx.drawImage(img, (pw - dw) / 2 + nx, (rows - dh) / 2 + ny, dw, dh);

  // 1 bit per dot, MSB first, rows byte-aligned. In ZPL ^GFA a 1 is BLACK.
  const px = ctx.getImageData(0, 0, pw, rows).data;
  const rowBytes = Math.ceil(pw / 8);
  const bytes = new Uint8Array(rowBytes * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y * pw + x) * 4;
      const lum = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
      if (lum < 128) bytes[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0").toUpperCase();
  return { hex, rowBytes, rows, pw };
}

export function buildZpl(bitmap: { hex: string; rowBytes: number; rows: number; pw: number }, copies: number): string {
  const total = bitmap.rowBytes * bitmap.rows;
  // ^MNY gap tracking + ^PW/^LL pin the geometry so the printer never
  // free-runs past the label gap; ^PQ prints N copies of the one format.
  return `^XA^MNY^PW${bitmap.pw}^LL${bitmap.rows}^LH0,0^FO0,0^GFA,${total},${total},${bitmap.rowBytes},${compressGfa(bitmap.hex, bitmap.rowBytes)}^FS^PQ${Math.max(1, Math.min(500, copies))}^XZ`;
}

// ZPL's ASCII compression for ^GFA hex (every Zebra printer reads it): a row
// equal to the one above is ":", a row of zeros is ",", trailing zeros end
// with ",", and runs of one hex digit get a count (G–Y = 1–19, g–z = 20–400).
// A label is mostly white, so this cuts each one from ~20 KB to a few KB —
// a whole entry of labels no longer overwhelms the Browser Print agent.
export function compressGfa(hex: string, rowBytes: number): string {
  const w = rowBytes * 2;
  let out = "", prev = "";
  for (let i = 0; i < hex.length; i += w) {
    const row = hex.slice(i, i + w);
    if (row === prev) { out += ":"; continue; }
    prev = row;
    const body = row.replace(/0+$/, "");
    if (!body) { out += ","; continue; }
    for (let j = 0; j < body.length;) {
      let k = j;
      while (k < body.length && body[k] === body[j] && k - j < 400) k++; // a count tops out at 400
      out += runCode(k - j) + body[j];
      j = k;
    }
    if (body.length < w) out += ",";
  }
  return out;
}
function runCode(n: number): string {
  let s = "";
  if (n >= 20) { s += String.fromCharCode(102 + Math.floor(n / 20)); n %= 20; } // g=20 … z=400
  if (n > 1 || (n === 1 && s)) s += String.fromCharCode(70 + n); // G=1 … Y=19
  return s;
}

// ---- Sending ----
// The macOS agent (Browser Print 1.3.x) writes each POST to the printer as ONE
// USB transfer and gives up after 5 s ("write timeout"). The printer only
// takes bytes while its receive buffer has room, so pouring 48 KB batches in
// as fast as the agent answered filled that buffer, the next write timed out
// and the rest of a 197-label job was never sent (2026-10-06). So now:
//  • one label design per write, at most COPIES_PER_FORMAT copies — freeing
//    room for the next never takes long, and at most a few labels are ever
//    in doubt when something stops;
//  • paced — only about LEAD_MS of printing waits in the printer, so its
//    buffer never fills and "sent" stays close to "printed";
//  • a status check (~HQES) runs alongside: out of labels, head open or
//    paused stops the sending at once, with the reason.
const COPIES_PER_FORMAT = 3;
const LEAD_MS = 3000;

/** One ^XA…^XZ write: `copies` labels of dialog line `line`, starting at that line's copy `copyStart`. */
type Format = { line: number; copyStart: number; copies: number; zpl: string };
export type DirectProgress = { phase: "render" | "send"; done: number; total: number };
export type DirectOpts = { onProgress?: (p: DirectProgress) => void; shouldStop?: () => boolean };
export type ZebraStop = "printer" | "timeout" | "disconnected" | "unreachable" | "agent" | "stopped" | "render";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class AgentError extends Error {
  constructor(public kind: ZebraStop, message: string) { super(message); }
}
async function agentPost(path: "write" | "read", body: any, timeoutMs: number): Promise<string> {
  let r: Response;
  try {
    r = await fetch(`${AGENT}/${path}`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: any) {
    throw e?.name === "TimeoutError"
      ? new AgentError("unreachable", "Zebra Browser Print stopped answering.")
      : new AgentError("unreachable", "Couldn't reach Zebra Browser Print — is it running (menu-bar app)?");
  }
  const text = await r.text().catch(() => "");
  if (r.ok) return text;
  const why = text.trim().slice(0, 200);
  if (/write timeout/i.test(why)) throw new AgentError("timeout", "The printer stopped taking labels.");
  if (/no such device|unable to establish|pipe error|usb error|disconnect/i.test(why)) throw new AgentError("disconnected", "The printer was disconnected or turned off.");
  throw new AgentError("agent", `Zebra Browser Print couldn't send to the printer (${r.status}${why ? `: ${why}` : ""}).`);
}

/** ~HQES "ERRORS: f gggggggg hhhhhhhh" → "" (no error), a reason, or null (no reply to parse). */
export function parseHqes(text: string): string | null {
  const m = [...text.matchAll(/ERRORS:\s*(\d)\s+([0-9A-Fa-f]{8})\s+([0-9A-Fa-f]{8})/g)].pop();
  if (!m) return null;
  const g1 = parseInt(m[3], 16), g2 = parseInt(m[2], 16);
  if (m[1] === "0" && !g1 && !g2) return "";
  const why: string[] = [];
  if (g1 & 0x1) why.push("out of labels");
  if (g1 & 0x2) why.push("out of ribbon");
  if (g1 & 0x4) why.push("the lid / print head is open");
  if (g1 & 0x8) why.push("cutter fault");
  if (g1 & 0x30) why.push("overheated");
  if (g1 & 0x10000) why.push("paused");
  return why.length ? why.join(", ") : "printer error";
}
// One status round trip. Each /read costs the macOS agent 1–3.4 s.
async function printerProblem(device: any): Promise<string | null> {
  await agentPost("write", { device, data: "~HQES" }, 6000);
  let text = "";
  for (let k = 0; k < 2; k++) {
    text += await agentPost("read", { device }, 6000);
    const r = parseHqes(text);
    if (r !== null) return r;
  }
  return null;
}
// Polls the printer while a job is sent. Turns itself off when the printer
// never answers (status reads aren't available on every setup).
function watchPrinter(device: any) {
  let on = true, problem = "", misses = 0;
  (async () => {
    // Drop any late reply from an earlier check first, so an old "out of
    // labels" can't stop a fresh job.
    await agentPost("read", { device }, 6000).catch(() => "");
    while (on && misses < 2) {
      const r = await printerProblem(device).catch(() => null);
      if (!on) break;
      if (r === null) misses++;
      else { misses = 0; if (r) { problem = r; break; } }
      await sleep(4000);
    }
  })();
  return { problem: () => problem, stop: () => { on = false; } };
}

// Streams the formats, paced to the printer. Returns the labels sent.
async function sendFormats(device: any, formats: Format[], labelLenMm: number, opts?: DirectOpts): Promise<number> {
  const total = formats.reduce((a, f) => a + f.copies, 0);
  // Estimated time per label: feed (label + gap) at 3 ips, plus processing.
  // Slow writes (the printer's buffer was full) stretch it.
  let msPerLabel = ((labelLenMm + 3) / 76) * 1000 + 150;
  let doneAt = 0, sent = 0, retried = false;
  const watch = watchPrinter(device);
  try {
    for (let i = 0; i < formats.length; i++) {
      const f = formats[i];
      for (;;) {
        if (opts?.shouldStop?.()) throw new ZebraError("Stopped.", sent, f, "stopped");
        const p = watch.problem();
        if (p) throw new ZebraError(`The printer reported a problem: ${p}.`, sent, f, "printer");
        const wait = doneAt - performance.now() - LEAD_MS;
        if (wait <= 0) break;
        await sleep(Math.min(wait, 250));
      }
      const t0 = performance.now();
      try {
        // ~JX first: drops a half-received design a stopped job may have left behind.
        await agentPost("write", { device, data: (i === 0 ? "~JX" : "") + f.zpl }, 20000);
      } catch (e: any) {
        if (!(e instanceof AgentError)) throw e;
        // Nothing reached the printer yet and the connection was stale
        // (printer re-plugged / woke up): one quiet retry.
        if (sent === 0 && !retried && (e.kind === "disconnected" || e.kind === "unreachable")) { retried = true; await sleep(1000); i--; continue; }
        let msg = e.message;
        if (e.kind === "timeout") {
          const p = watch.problem() || (await Promise.race([printerProblem(device).catch(() => null), sleep(8000).then(() => null)]));
          msg += p ? ` It says: ${p}.` : " Is it out of labels, paused, or is the lid open?";
        }
        throw new ZebraError(msg, sent, f, e.kind);
      }
      if (performance.now() - t0 > 1000) msPerLabel = Math.min(3000, msPerLabel * 1.3);
      doneAt = Math.max(performance.now(), doneAt) + f.copies * msPerLabel;
      sent += f.copies;
      opts?.onProgress?.({ phase: "send", done: sent, total });
    }
    return sent;
  } finally { watch.stop(); }
}

// A line's copies as designs of one bitmap, `per` copies at most each.
function formatsFor(line: number, bitmap: { hex: string; rowBytes: number; rows: number; pw: number }, copies: number, per = COPIES_PER_FORMAT): Format[] {
  const out: Format[] = [];
  for (let c = 0; c < copies; c += per) {
    const n = Math.min(per, copies - c);
    out.push({ line, copyStart: c, copies: n, zpl: buildZpl(bitmap, n) });
  }
  return out;
}

// Render every job first (a render failure stops before label 1, never
// mid-job), then stream them. `line` in a ZebraError is the index in `jobs`.
export async function printDirect(device: any, jobs: ZebraJob[], tpl: LabelTemplate, tune?: ZebraTune, opts?: DirectOpts): Promise<number> {
  const total = jobs.reduce((a, j) => a + Math.max(0, j.copies), 0);
  if (!total) return 0;
  await ensureLabelFont(tpl);
  const deps = { styleTag: await fontStyleTag(tpl), logoData: tpl.logoUrl ? await inlineLogo(tpl.logoUrl) : "" };
  const formats: Format[] = [];
  let ready = 0;
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    if (j.copies <= 0) continue;
    if (opts?.shouldStop?.()) throw new ZebraError("Stopped.", 0, undefined, "stopped");
    try {
      formats.push(...formatsFor(i, await labelToZplBitmap(tpl, j.item, tune, deps), j.copies));
    } catch (e: any) {
      throw new ZebraError(`Couldn't draw the label for “${j.item.title}” (${e?.message || e}). Nothing was sent.`, 0, undefined, "render");
    }
    ready += j.copies;
    opts?.onProgress?.({ phase: "render", done: ready, total });
  }
  return sendFormats(device, formats, tpl.heightMm, opts);
}

/** Ready-made label SVGs (Label maker) straight to the Zebra. One design per
 *  label with all its copies (^PQ, up to 500 a write) — the printer repeats
 *  it itself, so there's nothing to pace or resume. */
export async function printSvgsDirect(device: any, labels: { svg: string; copies: number }[], size: { widthMm: number; heightMm: number }, tune?: ZebraTune, opts?: DirectOpts): Promise<number> {
  const formats: Format[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i].copies <= 0) continue;
    formats.push(...formatsFor(i, await svgToZplBitmap(labels[i].svg, size, tune), labels[i].copies, 500));
  }
  return formats.length ? sendFormats(device, formats, size.heightMm, opts) : 0;
}

/** A direct print that stopped. `sent` labels were accepted by the printer
 *  (they print once it's ready — unless it's switched off); `at` is the first
 *  design not confirmed: line `at.line`, from its copy `at.copyStart`. */
export class ZebraError extends Error {
  constructor(message: string, public sent: number, public at?: { line: number; copyStart: number; copies: number }, public kind: ZebraStop = "agent") { super(message); }
}
