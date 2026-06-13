import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // Canonical site URL — used for canonical links, the sitemap, and Open Graph tags.
  site: 'https://timelag.co',

  // The site is static by default; only the contact endpoint runs as a Vercel
  // serverless function (it sets `export const prerender = false`).
  adapter: vercel(),

  // Astro 5 turns on a CSRF "origin check" for on-demand POSTs by default, which
  // rejects our same-origin form submissions behind Vercel's proxy with a 403.
  // The public forms only send email (honeypot-protected), so disable it.
  security: { checkOrigin: false },

  integrations: [sitemap()],
});
