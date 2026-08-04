// Phone-as-scanner pairing over Supabase Realtime BROADCAST — no tables, no
// polling. A desktop station advertises a 6-digit rendezvous code; the phone
// (logged into the POS at /scan) joins that channel and is handed a 128-bit
// scan-channel token. All scans then stream phone → desktop on the token
// channel. Channel names are unguessable capabilities; the 6-digit rendezvous
// only lives for the pairing window. (Future hardening for licensed multi-
// tenant deploys: Realtime private channels + realtime.messages RLS.)
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

const randToken = () => {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
};

// ---------- Desktop (receiving) side ----------

export type HostCallbacks = {
  onCode?: (code6: string) => void;    // show this to the user (pair dialog)
  onPaired?: () => void;               // a phone joined
  onScan: (m: ScanMsg) => void;        // a scan arrived
  onGone?: () => void;                 // the phone ended the session
};

export type HostSession = { token: string; stop: (sayBye?: boolean) => void };

// Subscribe the scan channel for a token (shared by fresh pairings + resumes).
function hostScanChannel(token: string, cb: HostCallbacks): RealtimeChannel {
  const ch = client().channel("tl-scan-" + token);
  ch.on("broadcast", { event: "scan" }, ({ payload }) => cb.onScan(payload as ScanMsg))
    .on("broadcast", { event: "joined" }, () => cb.onPaired?.())
    .on("broadcast", { event: "bye" }, () => cb.onGone?.())
    .subscribe();
  return ch;
}

// Fresh pairing: advertise a 6-digit code, hand the token to the first phone
// that says hello, and stream its scans.
export function hostPairing(cb: HostCallbacks): HostSession {
  const code6 = String(Math.floor(100000 + Math.random() * 900000));
  const token = randToken();
  const c = client();
  let stopped = false;

  const scanCh = hostScanChannel(token, {
    ...cb,
    onPaired: () => { pairCh.unsubscribe(); cb.onPaired?.(); },
  });
  const pairCh = c.channel("tl-pair-" + code6);
  pairCh
    .on("broadcast", { event: "hello" }, () => {
      pairCh.send({ type: "broadcast", event: "token", payload: { token } });
    })
    .subscribe();
  cb.onCode?.(code6);

  return {
    token,
    stop: (sayBye = false) => {
      if (stopped) return;
      stopped = true;
      if (sayBye) { try { scanCh.send({ type: "broadcast", event: "bye", payload: {} }); } catch { /* leaving anyway */ } }
      pairCh.unsubscribe();
      scanCh.unsubscribe();
    },
  };
}

// Resume an existing pairing (page navigation / reload on the desktop).
export function resumeHost(token: string, cb: HostCallbacks): HostSession {
  const ch = hostScanChannel(token, cb);
  return { token, stop: () => ch.unsubscribe() };
}

// ---------- Phone (scanning) side ----------

export type ScannerCallbacks = {
  onReady: (send: (m: ScanMsg) => void, token: string) => void;
  onFail?: (msg: string) => void;
  onHostGone?: () => void;
};

export type ScannerSession = { stop: (sayBye?: boolean) => void };

function scannerScanChannel(token: string, cb: ScannerCallbacks): RealtimeChannel {
  const ch = client().channel("tl-scan-" + token);
  ch.on("broadcast", { event: "bye" }, () => cb.onHostGone?.())
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        ch.send({ type: "broadcast", event: "joined", payload: {} });
        cb.onReady((m) => ch.send({ type: "broadcast", event: "scan", payload: m }), token);
      }
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
    if (sayBye && scanCh) { try { scanCh.send({ type: "broadcast", event: "bye", payload: {} }); } catch { /* leaving anyway */ } }
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
      if (status === "SUBSCRIBED") pairCh.send({ type: "broadcast", event: "hello", payload: {} });
    });
  return { stop };
}

// Resume a scanner session after a reload (token from sessionStorage).
export function resumeScanner(token: string, cb: ScannerCallbacks): ScannerSession {
  const ch = scannerScanChannel(token, cb);
  return { stop: (sayBye = false) => { if (sayBye) { try { ch.send({ type: "broadcast", event: "bye", payload: {} }); } catch { /* leaving */ } } ch.unsubscribe(); } };
}
