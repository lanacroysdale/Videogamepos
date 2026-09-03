// Desktop side of the phone scanner: pair dialog + floating "connected" chip +
// scan routing. Self-contained (renders its own DOM, styled via CSS vars) so
// any POS page can adopt it with two calls — initScanReceiver() on load and
// openPairDialog() from a 📱 button. Pairing survives page navigation via
// sessionStorage; scans land in the page's active input (or its default
// target) exactly like a wedge scanner: value + input event + Enter. Pages
// that can look a code up pass `describe` so the phone gets told what it hit.
import { hostPairing, resumeHost, type HostSession, type LinkStatus, type ScanMsg } from "./scanChannel";

export type ReceiverOpts = {
  target: () => HTMLInputElement | null;          // page's default scan input
  describe?: (code: string) => string | null;      // "Mario Kart 64 · CIB" / null = no match
  page?: string;                                   // shown on the phone ("Checkout")
};

let session: HostSession | null = null;
let opts: ReceiverOpts | null = null;
let link: LinkStatus = "connecting";

function route(m: ScanMsg) {
  const active = document.activeElement as HTMLElement | null;
  let input: HTMLInputElement | null = null;
  if (active && active.tagName === "INPUT" && ["text", "search", "number", ""].includes((active as HTMLInputElement).type || "text")) {
    input = active as HTMLInputElement;
  }
  if (!input || input.readOnly || input.disabled) input = opts?.target() ?? null;
  // Look the code up BEFORE dispatching: pages clear the field / mutate their
  // list on an exact hit, and the phone wants to know what that hit was.
  let hit: string | null | undefined;
  try { hit = opts?.describe ? opts.describe(m.code) : undefined; } catch { hit = undefined; }
  if (input) {
    input.focus();
    input.value = m.code;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  // `page` is only set when a lookup actually ran — its absence tells the
  // phone "delivered, but this page can't check it" rather than "no match".
  session?.ack({ at: m.at, code: m.code, hit: hit ?? null, page: opts?.describe ? (opts.page || document.title) : undefined });
  pulseChip(hit === null ? "miss" : "hit");
}

// ---------- Floating chip ----------
const BASE_SHADOW = "0 8px 24px rgba(0,0,0,.45)";
function chip(): HTMLElement {
  let el = document.getElementById("scanrx-chip");
  if (el) return el;
  el = document.createElement("div");
  el.id = "scanrx-chip";
  el.style.cssText = "position:fixed;right:1rem;bottom:1rem;z-index:1500;display:flex;align-items:center;gap:0.5rem;padding:0.45rem 0.8rem;background:var(--panel,#111);border:1px solid var(--green,#80ff72);color:var(--text,#eee);font-size:0.82rem;font-weight:600;box-shadow:" + BASE_SHADOW + ";transition:box-shadow .15s ease,border-color .2s ease;";
  el.innerHTML = `<span id="scanrx-chip-text">📱 Phone scanner connected</span> <button type="button" title="Disconnect the phone" style="background:none;border:none;color:var(--magenta,#ff49d0);cursor:pointer;font:inherit;padding:0 0 0 0.2rem;">✕</button>`;
  el.querySelector("button")!.addEventListener("click", () => stopReceiver(true));
  document.body.appendChild(el);
  paintChip();
  return el;
}
function paintChip() {
  const el = document.getElementById("scanrx-chip");
  const t = document.getElementById("scanrx-chip-text");
  if (!el || !t) return;
  if (link === "live") { el.style.borderColor = "var(--green,#80ff72)"; t.textContent = "📱 Phone scanner connected"; }
  else if (link === "error") { el.style.borderColor = "var(--magenta,#ff49d0)"; t.textContent = "📱 Phone link lost — retrying…"; }
  else { el.style.borderColor = "var(--muted-2,#888)"; t.textContent = "📱 Phone link reconnecting…"; }
}
function pulseChip(kind: "hit" | "miss" = "hit") {
  const el = document.getElementById("scanrx-chip");
  if (!el) return;
  el.style.boxShadow = `0 0 0 3px var(${kind === "miss" ? "--magenta, #ff49d0" : "--green, #80ff72"})`;
  setTimeout(() => (el.style.boxShadow = BASE_SHADOW), 220);
}
function removeChip() { document.getElementById("scanrx-chip")?.remove(); }
function onStatus(s: LinkStatus) { link = s; paintChip(); }

export function stopReceiver(sayBye = false) {
  session?.stop(sayBye);
  session = null;
  try { sessionStorage.removeItem("tl-scan-host"); } catch { /* private mode */ }
  removeChip();
}

// ---------- Pair dialog ----------
export function openPairDialog(o: ReceiverOpts): void {
  opts = o;
  if (session) { chip(); pulseChip(); return; } // already paired — just point at the chip
  document.getElementById("scanrx-dialog")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "scanrx-dialog";
  overlay.style.cssText = "position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.55);display:grid;place-items:center;padding:1rem;";
  overlay.innerHTML = `
    <div style="width:100%;max-width:420px;background:var(--panel,#111);border:1px solid var(--border-strong,#444);padding:1.2rem 1.3rem;color:var(--text,#eee);text-align:center;">
      <h3 style="margin:0 0 0.6rem;">📱 Pair your phone</h3>
      <p style="margin:0 0 1rem;color:var(--muted,#999);font-size:0.88rem;">On your phone, sign into the POS and open <strong>📱 Scan</strong> (pos.timelag.co/scan), then enter:</p>
      <div id="scanrx-code" style="font-family:var(--font-mono,monospace);font-size:2.4rem;letter-spacing:0.3em;color:var(--cyan,#2ce6e0);margin-bottom:1rem;">······</div>
      <p id="scanrx-status" style="margin:0 0 1rem;color:var(--muted-2,#888);font-size:0.82rem;">Waiting for the phone…</p>
      <button id="scanrx-cancel" type="button" style="font:inherit;padding:0.45rem 0.9rem;background:transparent;color:var(--muted,#999);border:1px solid var(--border,#333);cursor:pointer;">Cancel</button>
    </div>`;
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) { close(); if (!chipShown()) cancelPending(); } });
  document.body.appendChild(overlay);

  let paired = false;
  const chipShown = () => paired;
  const pending = hostPairing({
    onCode: (c) => { const el = overlay.querySelector("#scanrx-code"); if (el) el.textContent = c.slice(0, 3) + " " + c.slice(3); },
    onPaired: () => {
      paired = true;
      session = pending;
      try { sessionStorage.setItem("tl-scan-host", pending.token); } catch { /* private mode */ }
      close();
      chip();
      pulseChip();
    },
    onScan: route,
    onGone: () => stopReceiver(false),
    onStatus: (s) => {
      onStatus(s);
      if (s === "error" && !paired) { const st = overlay.querySelector("#scanrx-status"); if (st) st.textContent = "Can't reach the realtime service — check this station's connection."; }
    },
  });
  const cancelPending = () => { if (!paired) pending.stop(); };
  overlay.querySelector("#scanrx-cancel")!.addEventListener("click", () => { close(); cancelPending(); });
}

// ---------- Page adoption ----------
export function initScanReceiver(o: ReceiverOpts): void {
  opts = o;
  if (session) { chip(); return; }
  let token = "";
  try { token = sessionStorage.getItem("tl-scan-host") || ""; } catch { /* private mode */ }
  if (!token) return;
  session = resumeHost(token, { onScan: route, onGone: () => stopReceiver(false), onStatus });
  chip();
}
