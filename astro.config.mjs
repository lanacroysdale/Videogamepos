import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // TODO: change this to your real domain once it's registered (Cloudflare) and
  // live on Vercel. It is used for canonical URLs, the sitemap, and Open Graph tags.
  site: 'https://timelaggaming.com',

  // The site is static by default; only the contact endpoint runs as a Vercel
  // serverless function (it sets `export const prerender = false`).
  adapter: vercel(),

  integrations: [sitemap()],
});
