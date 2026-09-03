// Phone-as-scanner pairing over Supabase Realtime BROADCAST — no tables, no
// polling. A desktop station advertises a 6-digit rendezvous code; the phone
// (logged into the POS at /scan) joins that channel and is handed a 128-bit
// scan-channel token. All scans then stream phone → desktop on the token
// channel, and the desktop answers each one with an "ack" saying what it
// matched (so the phone can show "✓ Mario Kart 64 · CIB" instead of hoping).
// Channel names are unguessable capabilities; the 6-digit rendezvous only
// lives for the pairing window. (Future hardening for licensed multi-tenant
// deploys: Realtime private channels + realtime.messages RLS.)
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";

let sb: SupabaseClient | null = null;
function client(): SupabaseClient {
  if (!sb) {
    sb = createClient(import.meta.env.PUBLIC_SUPABASE_URL, import.meta.env.PUBLIC_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return sb;
}

export type ScanMsg = { code: string; format?: string; at: number };
// Desktop → phone: what the scan at `at` resolved to. `page` names the station
// page that looked it up; when it's absent the page had no catalog to check,
// so hit=null means "delivered" there rather than "no match".
export type ScanAck = { at: number; code: string; hit: string | null; page?: string };
// Realtime subscription health, surfaced on both ends.
export type LinkStatus = "connecting" | "live" | "reconnecting" | "error";

const randToken = () => {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const statusOf = (s: string): LinkStatus =>
  s === "SUBSCRIBED" ? "live" : s === "CHANNEL_ERROR" ? "error" : s === "TIMED_OUT" || s === "CLOSED" ? "reconnecting" : "connecting";

// ---------- Desktop (receiving) side ----------

export type HostCallbacks = {
  onCode?: (code6: string) => void;    // show this to the user (pair dialog)
  onPaired?: () => void;               // a phone joined
  onScan: (m: ScanMsg) => void;        // a scan arrived
  onGone?: () => void;                 // the phone ended the session
  onStatus?: (s: LinkStatus) => void;  // realtime link health
};

export type HostSession = {
  token: string;
  ack: (a: ScanAck) => void;           // tell the phone what a scan matched
  stop: (sayBye?: boolean) => void;
};

// Subscribe the scan channel for a token (shared by fresh pairings + resumes).
function hostScanChannel(token: string, cb: HostCallbacks): RealtimeChannel {
  const ch = client().channel("tl-scan-" + token);
  ch.on("broadcast", { event: "scan" }, ({ payload }) => cb.onScan(payload as ScanMsg))
    .on("broadcast", { event: "joined" }, () => cb.onPaired?.())
    .on("broadcast", { event: "bye" }, () => cb.onGone?.())
    .subscribe((status) => cb.onStatus?.(statusOf(status)));
  return ch;
}

const sendOn = (ch: RealtimeChannel, event: string, payload: object) => {
  try { ch.send({ type: "broadcast", event, payload }); } catch { /* channel closing */ }
};

// Fresh pairing: advertise a 6-digit code, hand the token to the first phone
// that says hello, and stream its scans.
export function hostPairing(cb: HostCallbacks): HostSession {
  const code6 = String(Math.floor(100000 + Math.random() * 900000));
  const token = randToken();
  const c = client();
  let stopped = false;
  let paired = false;

  const scanCh = hostScanChannel(token, {
    ...cb,
    onPaired: () => {
      // Realtime re-subscribes after a network blip, which replays "joined" —
      // only the first one is a new pairing.
      if (paired) return;
      paired = true;
      pairCh.unsubscribe();
      cb.onPaired?.();
    },
  });
  const pairCh = c.channel("tl-pair-" + code6);
  pairCh
    .on("broadcast", { event: "hello" }, () => {
      if (!paired) sendOn(pairCh, "token", { token });
    })
    .subscribe();
  cb.onCode?.(code6);

  return {
    token,
    ack: (a) => sendOn(scanCh, "ack", a),
    stop: (sayBye = false) => {
      if (stopped) return;
      stopped = true;
      if (sayBye) sendOn(scanCh, "bye", {});
      pairCh.unsubscribe();
      scanCh.unsubscribe();
    },
  };
}

// Resume an existing pairing (page navigation / reload on the desktop).
export function resumeHost(token: string, cb: HostCallbacks): HostSession {
  const ch = hostScanChannel(token, cb);
  return {
    token,
    ack: (a) => sendOn(ch, "ack", a),
    stop: (sayBye = false) => { if (sayBye) sendOn(ch, "bye", {}); ch.unsubscribe(); },
  };
}

// ---------- Phone (scanning) side ----------

export type ScannerCallbacks = {
  onReady: (send: (m: ScanMsg) => void, token: string) => void; // fires once per session
  onFail?: (msg: string) => void;
  onHostGone?: () => void;
  onAck?: (a: ScanAck) => void;
  onStatus?: (s: LinkStatus) => void;
};

export type ScannerSession = { stop: (sayBye?: boolean) => void };

function scannerScanChannel(token: string, cb: ScannerCallbacks): RealtimeChannel {
  const ch = client().channel("tl-scan-" + token);
  let ready = false;
  ch.on("broadcast", { event: "bye" }, () => cb.onHostGone?.())
    .on("broadcast", { event: "ack" }, ({ payload }) => cb.onAck?.(payload as ScanAck))
    .subscribe((status) => {
      cb.onStatus?.(statusOf(status));
      if (status === "CHANNEL_ERROR" && !ready) {
        // Never got going — don't leave the phone stuck on a disabled Pair button.
        ch.unsubscribe();
        cb.onFail?.("Lost the realtime connection before the scanner was ready — check the phone's signal and pair again.");
        return;
      }
      if (status !== "SUBSCRIBED") return;
      // Every (re)subscribe announces itself so the desktop knows we're back;
      // the page-level ready hook (camera, UI) must only run the first time.
      sendOn(ch, "joined", {});
      if (ready) return;
      ready = true;
      cb.onReady((m) => sendOn(ch, "scan", m), token);
    });
  return ch;
}

// Join with the code shown on the desktop. Resolves to the scan channel.
export function joinPairing(code6: string, cb: ScannerCallbacks): ScannerSession {
  const c = client();
  let scanCh: RealtimeChannel | null = null;
  let done = false;
  const pairCh = c.channel("tl-pair-" + code6.replace(/\D/g, ""));
  const timer = setTimeout(() => {
    if (!done) { cb.onFail?.("No station responded — check the code (it's on the desktop's pair window) and try again."); stop(); }
  }, 9000);
  const stop = (sayBye = false) => {
    clearTimeout(timer);
    if (sayBye && scanCh) sendOn(scanCh, "bye", {});
    pairCh.unsubscribe();
    scanCh?.unsubscribe();
  };
  pairCh
    .on("broadcast", { event: "token" }, ({ payload }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      scanCh = scannerScanChannel((payload as any).token, cb);
      pairCh.unsubscribe();
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") sendOn(pairCh, "hello", {});
      else if (status === "CHANNEL_ERROR" && !done) { done = true; clearTimeout(timer); cb.onFail?.("Couldn't reach the realtime service — check the phone's connection and try again."); pairCh.unsubscribe(); }
    });
  return { stop };
}

// Resume a scanner session after a reload (token from sessionStorage).
export function resumeScanner(token: string, cb: ScannerCallbacks): ScannerSession {
  const ch = scannerScanChannel(token, cb);
  return { stop: (sayBye = false) => { if (sayBye) sendOn(ch, "bye", {}); ch.unsubscribe(); } };
}
