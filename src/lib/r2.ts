// Cloudflare R2 over its S3 API — just the calls the image bucket needs (put,
// copy, delete, list), signed with AWS Signature V4 so no SDK is needed.
// Kept to plain, type-strippable TypeScript with no project imports so Node
// scripts can import it directly (scripts/move-images-to-r2.mjs).
import { createHash, createHmac } from "node:crypto";

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string; // where the bucket is served, e.g. https://img.timelag.co
};

type Send = { query?: Record<string, string>; body?: Uint8Array; headers?: Record<string, string> };

// RFC 3986 encoding, as SigV4 wants it (encodeURIComponent leaves !'()* alone).
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const encKey = (key: string) => key.split("/").map(enc).join("/");
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s).digest();
const xmlText = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tags = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);

export function r2Configured(cfg: Partial<R2Config>): cfg is R2Config {
  return !!(cfg.accountId && cfg.accessKeyId && cfg.secretAccessKey && cfg.bucket && cfg.publicUrl);
}

/** The SigV4 Authorization header. `signed` = host + the x-amz-* headers (lowercase names). */
export function sigV4(p: {
  method: string; path: string; query: Record<string, string>; signed: Record<string, string>;
  payloadHash: string; amzDate: string; region: string; accessKeyId: string; secretAccessKey: string;
}): string {
  const day = p.amzDate.slice(0, 8);
  const qs = Object.keys(p.query).sort().map((k) => `${enc(k)}=${enc(p.query[k])}`).join("&");
  const names = Object.keys(p.signed).sort();
  const canonical = [p.method, p.path, qs, names.map((n) => `${n}:${p.signed[n].trim()}\n`).join(""), names.join(";"), p.payloadHash].join("\n");
  const scope = `${day}/${p.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", p.amzDate, scope, sha256(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + p.secretAccessKey, day), p.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${p.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
}

export function r2(cfg: R2Config) {
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const base = cfg.publicUrl.replace(/\/+$/, "");

  async function send(method: string, key: string, opts: Send = {}): Promise<Response> {
    const query = opts.query ?? {};
    const body = opts.body ?? new Uint8Array(0);
    const path = `/${cfg.bucket}${key ? "/" + encKey(key) : ""}`;
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20261027T120000Z
    const payloadHash = sha256(body);
    const amz: Record<string, string> = { "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    for (const [k, v] of Object.entries(opts.headers ?? {})) if (/^x-amz-/i.test(k)) amz[k.toLowerCase()] = v;
    const authorization = sigV4({
      method, path, query, signed: { host, ...amz }, payloadHash, amzDate,
      region: "auto", accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
    });
    const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join("&");
    const hasBody = method === "PUT" || method === "POST";
    // (fetch sets Host from the URL.)
    return fetch(`https://${host}${path}${qs ? "?" + qs : ""}`, {
      method, headers: { ...opts.headers, ...amz, authorization }, body: hasBody ? (body as BodyInit) : undefined,
    });
  }

  const fail = async (what: string, res: Response) => {
    const text = await res.text().catch(() => "");
    const code = tags(text, "Code")[0] || res.statusText;
    return new Error(`R2 ${what}: ${res.status} ${code}`);
  };

  return {
    publicUrl: (key: string) => `${base}/${encKey(key)}`,

    /** The object key when `url` is a file served from this bucket, else null. */
    keyOf(url: string): string | null {
      if (!url.startsWith(base + "/")) return null;
      try { return decodeURIComponent(url.slice(base.length + 1).split(/[?#]/)[0]); } catch { return null; }
    },

    async put(key: string, bytes: Uint8Array, contentType: string, cacheControl: string): Promise<void> {
      const res = await send("PUT", key, { body: bytes, headers: { "content-type": contentType, "cache-control": cacheControl } });
      if (!res.ok) throw await fail(`put ${key}`, res);
    },

    async copy(from: string, to: string): Promise<void> {
      const res = await send("PUT", to, { headers: { "x-amz-copy-source": `/${cfg.bucket}/${encKey(from)}` } });
      // A copy can fail after a 200, with the error in the body.
      const text = await res.text().catch(() => "");
      if (!res.ok || text.includes("<Error>")) throw new Error(`R2 copy ${from} → ${to}: ${res.status} ${tags(text, "Code")[0] ?? ""}`.trim());
    },

    async remove(key: string): Promise<void> {
      const res = await send("DELETE", key);
      if (!res.ok && res.status !== 404) throw await fail(`delete ${key}`, res);
    },

    async exists(key: string): Promise<boolean> {
      const res = await send("HEAD", key);
      if (res.status === 404) return false;
      if (!res.ok) throw await fail(`head ${key}`, res);
      return true;
    },

    /** Keys and sub-folders under `prefix` (one level when `delimiter` is "/"). */
    async list(prefix: string, opts: { delimiter?: string; max?: number } = {}): Promise<{ keys: { key: string; size: number }[]; prefixes: string[] }> {
      const keys: { key: string; size: number }[] = [];
      const prefixes: string[] = [];
      const max = opts.max ?? Infinity;
      let token = "";
      do {
        const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": String(Math.min(1000, max - keys.length)) };
        if (opts.delimiter) query.delimiter = opts.delimiter;
        if (token) query["continuation-token"] = token;
        const res = await send("GET", "", { query });
        if (!res.ok) throw await fail(`list ${prefix || "/"}`, res);
        const xml = await res.text();
        for (const c of tags(xml, "Contents")) {
          keys.push({ key: xmlText(tags(c, "Key")[0] ?? ""), size: Number(tags(c, "Size")[0] ?? 0) });
        }
        for (const p of tags(xml, "CommonPrefixes")) prefixes.push(xmlText(tags(p, "Prefix")[0] ?? ""));
        token = tags(xml, "IsTruncated")[0] === "true" ? xmlText(tags(xml, "NextContinuationToken")[0] ?? "") : "";
      } while (token && keys.length < max);
      return { keys, prefixes };
    },
  };
}

export type R2 = ReturnType<typeof r2>;
