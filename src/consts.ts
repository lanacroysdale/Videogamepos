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
  name: 'TimeLag Video Games',
  shortName: 'TimeLag',
  tagline: 'Buy. Sell. Chill. Curated retro & modern games in Portland, OR.',
  description:
    'TimeLag Video Games is Portland’s premier inclusive hub to shop, play, eat, and connect. Discover Japanese imports and classic collectibles, sell your games for cash, or level up in our chill lounge. Launching 2027 near PDX.',

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

  // Shown as quick-browse chips in the store section.
  categories: [
    'GameCube',
    'Game Boy',
    'DS & 3DS',
    'Retro Consoles',
    'Gaming Accessories',
    'NES & Famicom',
    'SNES & Super Famicom',
    'Nintendo 64',
    'Pokemon',
    'Playstation',
    'Sega Dreamcast',
    'Sega Saturn',
  ],
};

// Primary navigation shown in the header and footer.
// "Find Us" lives as a standalone location pill in the header (see Header.astro).
export const NAV: NavItem[] = [
  { label: 'Shop', href: '/#shop' },
  { label: 'Sell Games', href: '/#sell' },
  { label: 'About', href: '/#about' },
];

// Anchor target for the "Find Us" header pill (the Eat·Play·Connect section).
export const FIND_US_HREF = '/#journey';

// Used in the "condition" dropdown on the sell/trade form.
export const CONDITIONS = [
  'Complete / Like new',
  'Good / Used',
  'Loose (disc or cart only)',
  'Mixed lot',
  'Not sure',
];

export const YEAR = new Date().getFullYear();
