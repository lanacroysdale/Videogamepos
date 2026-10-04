// Browser side of "what game is this UPC?" — shared by Inventory (receiving +
// search) and Trade-In. The server (/api/pos/upc identify) asks eBay's catalog
// and matches our game database; one request per code per page.
import { canonicalUpc } from "./upcMatch";

/** A scanned/typed code that is a valid UPC/EAN (check digit and all). */
export const upcLike = (q: string) => /^\d{12,14}$/.test(String(q ?? "").trim()) && !!canonicalUpc(String(q).trim());

const lookups = new Map<string, Promise<any>>();
export function identifyUpc(code: string): Promise<any> {
  const k = canonicalUpc(String(code ?? "").trim()) || String(code ?? "").trim();
  if (!lookups.has(k)) {
    lookups.set(k, fetch("/api/pos/upc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "identify", upc: k }) })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        // A failed request (signed out, server error) is NOT "eBay doesn't know it".
        if (!r.ok || !j.ok) return { ok: false, found: false, error: true, upc: k, evidence: r.status === 401 ? "You're signed out — sign in again" : j.error || `Lookup failed (${r.status})` };
        return j;
      })
      .then((j) => { if (j.error) lookups.delete(k); return j; }) // a failure may be retried
      .catch(() => { lookups.delete(k); return { ok: false, found: false, error: true, upc: k, evidence: "Couldn't reach the server" }; }));
  }
  return lookups.get(k)!;
}
