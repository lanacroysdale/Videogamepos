import type { APIRoute } from "astro";
import { MARKETING_HOSTS, SITE } from "../consts";

export const prerender = false;

// robots.txt per host (a static public/robots.txt is the same on every host).
// Marketing hosts: crawlable. Any other host is the POS (pos.timelag.co, the
// vercel.app alias, a licensee domain) — keep every crawler off it entirely.
const MARKETING = `User-agent: *
Allow: /
# Hidden / pre-launch pages
Disallow: /shop

Sitemap: ${SITE.url}/sitemap-index.xml
`;

const POS = `# Internal point-of-sale — not for crawling.
User-agent: *
Disallow: /
`;

export const GET: APIRoute = ({ request, url }) => {
  // Same host test as src/middleware.ts (Vercel puts the real domain in x-forwarded-host).
  const host = (request.headers.get("x-forwarded-host") ?? url.hostname).split(":")[0].toLowerCase();
  return new Response(MARKETING_HOSTS.includes(host) ? MARKETING : POS, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
};
