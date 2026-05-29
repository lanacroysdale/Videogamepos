// ---------------------------------------------------------------------------
// Single source of truth for site content.
// Edit the values here and they update everywhere across the site.
// Anything marked TODO should be confirmed/updated by Adam.
// ---------------------------------------------------------------------------

export interface NavItem {
  label: string;
  href: string;
}

export const SITE = {
  name: 'Time Lag Gaming',
  shortName: 'Time Lag',
  tagline: 'Buy. Sell. Trade. Retro and modern games in Portland.',
  description:
    'Time Lag Gaming buys, sells, and trades retro and modern video games, consoles, and accessories in Portland, OR. Shop our eBay store or sell your collection for fast cash or store credit.',

  // TODO: update once your domain is registered (Cloudflare) and live on Vercel.
  url: 'https://timelaggaming.com',

  owner: 'Adam',
  email: 'timelaggaming@gmail.com',
  phoneDisplay: '(360) 521-2101',
  phoneHref: 'tel:+13605212101',
  location: 'Portland, OR',
};

export const EBAY = {
  // TODO: replace with your real eBay Store URL,
  // e.g. https://www.ebay.com/str/yourstorename
  storeUrl: 'https://www.ebay.com/str/timelaggaming',

  // Fallback link that searches everything listed under your seller name.
  // TODO: confirm your eBay seller username.
  sellerSearchUrl: 'https://www.ebay.com/sch/i.html?_ssn=timelaggaming',

  // Shown as quick-browse chips in the eBay section.
  categories: [
    'Retro Consoles',
    'NES & SNES',
    'Nintendo 64',
    'PlayStation',
    'GameCube & Wii',
    'Pokémon',
    'Game Boy & DS',
    'Accessories',
  ],
};

export const NAV: NavItem[] = [
  { label: 'Home', href: '/' },
  { label: 'Sell Games', href: '/sell' },
  { label: 'eBay Store', href: '/#ebay' },
  { label: 'Contact', href: '/#contact' },
];

// Used in the "condition" dropdown on the sell/trade form.
export const CONDITIONS = [
  'Complete / Like new',
  'Good / Used',
  'Loose (disc or cart only)',
  'Mixed lot',
  'Not sure',
];

export const YEAR = new Date().getFullYear();
