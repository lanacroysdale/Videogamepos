import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // Canonical site URL — used for canonical links, the sitemap, and Open Graph tags.
  site: 'https://timelag.co',

  // SSR by default so middleware runs for EVERY request — required to serve the
  // POS at CLEAN root URLs on its own host (pos.timelag.co) via src/middleware.ts
  // (undefined paths would otherwise 404 at the edge before middleware runs).
  // The marketing pages opt back into static with `export const prerender = true`.
  output: 'server',
  adapter: vercel(),

  // Astro 5 turns on a CSRF "origin check" for on-demand POSTs by default, which
  // rejects our same-origin form submissions behind Vercel's proxy with a 403.
  // The public forms only send email (honeypot-protected), so disable it.
  security: { checkOrigin: false },

  // Keep hidden/pre-launch routes (e.g. /shop) out of the generated sitemap.
  integrations: [sitemap({ filter: (page) => !page.includes("/shop") })],
});
