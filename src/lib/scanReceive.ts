// Desktop side of the phone scanner: pair dialog + floating "connected" chip +
// scan routing. Self-contained (renders its own DOM, styled via CSS vars) so
// any POS page can adopt it with two calls — initScanReceiver() on load and
// openPairDialog() from a 📱 button. Pairing survives page navigation via
// sessionStorage; scans land in the page's active input (or its default
// target) exactly like a wedge scanner: value + input event + Enter.
import { hostPairing, resumeHost, type HostSession, type ScanMsg } from "./scanChannel";

export type ReceiverOpts = {
  target: () => HTMLInputElement | null; // page's default scan input
};

let session: HostSession | null = null;
let opts: ReceiverOpts | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

function route(m: ScanMsg) {
  const active = document.activeElement as HTMLElement | null;
  let input: HTMLInputElement | null = null;
  if (active && active.tagName === "INPUT" && ["text", "search", "number", ""].includes((active as HTMLInputElement).type || "text")) {
    input = active as HTMLInputElement;
  }
  if (!input || input.readOnly || input.disabled) input = opts?.target() ?? null;
  if (!input) return;
  input.focus();
  input.value = m.code;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  pulseChip();
}

// ---------- Floating chip ----------
function chip(): HTMLElement {
  let el = document.getElementById("scanrx-chip");
  if (el) return el;
  el = document.createElement("div");
  el.id = "scanrx-chip";
  el.style.cssText = "position:fixed;right:1rem;bottom:1rem;z-index:1500;display:flex;align-items:center;gap:0.5rem;padding:0.45rem 0.8rem;background:var(--panel,#111);border:1px solid var(--green,#80ff72);color:var(--text,#eee);font-size:0.82rem;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.45);transition:box-shadow .15s ease;";
  el.innerHTML = `📱 Phone scanner connected <button type="button" title="Disconnect the phone" style="background:none;border:none;color:var(--magenta,#ff49d0);cursor:pointer;font:inherit;padding:0 0 0 0.2rem;">✕</button>`;
  el.querySelector("button")!.addEventListener("click", () => stopReceiver(true));
  document.body.appendChild(el);
  return el;
}
function pulseChip() {
  const el = document.getElementById("scanrx-chip");
  if (!el) return;
  el.style.boxShadow = "0 0 0 3px var(--green, #80ff72)";
  setTimeout(() => (el.style.boxShadow = "0 8px 24px rgba(0,0,0,.45)"), 220);
}
function removeChip() { document.getElementById("scanrx-chip")?.remove(); }

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
  session = resumeHost(token, { onScan: route, onGone: () => stopReceiver(false) });
  chip();
}
