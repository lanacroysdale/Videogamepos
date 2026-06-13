// ---------------------------------------------------------------------------
// Single source of truth for site content.
// Edit the values here and they update everywhere across the site.
// Anything marked TODO should be confirmed/updated by Adam.
// ---------------------------------------------------------------------------

export interface NavItem {
  label: string;
  href: string;
}

export interface EbayCategory {
  label: string;
  url: string;
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
  phoneDisplay: '(503) 484-6272',
  phoneHref: 'tel:+15034846272',
  location: 'Portland, OR',
};

export const EBAY = {
  // TODO: replace with your real eBay Store URL,
  // e.g. https://www.ebay.com/str/yourstorename
  storeUrl: 'https://www.ebay.com/str/timelaggaming',

  // Fallback link that searches everything listed under your seller name.
  // TODO: confirm your eBay seller username.
  sellerSearchUrl: 'https://www.ebay.com/sch/i.html?_ssn=timelaggaming',

  // Quick-browse category buttons in the store section; each links straight to
  // that category on the eBay store.
  categories: [
    { label: 'GameCube', url: 'https://www.ebay.com/sch/i.html?_dkr=1&iconV2Request=true&_blrs=recall_filtering&_ssn=timelag&store_name=timelaggaming&_oac=1&_nkw=gamecube' },
    { label: 'Game Boy', url: 'https://www.ebay.com/sch/i.html?_dkr=1&iconV2Request=true&_blrs=recall_filtering&_ssn=timelag&store_name=timelaggaming&_oac=1&_nkw=game_boy' },
    { label: 'DS & 3DS', url: 'https://www.ebay.com/sch/i.html?_dkr=1&iconV2Request=true&_blrs=recall_filtering&_ssn=timelag&store_name=timelaggaming&_oac=1&_nkw=ds&_pgn=2' },
    { label: 'Retro Consoles', url: 'https://www.ebay.com/str/timelaggaming/Video-Game-Consoles/_i.html?_sacat=139971' },
    { label: 'Gaming Accessories', url: 'https://www.ebay.com/str/timelaggaming/Video-Game-Accessories/_i.html?_sacat=54968' },
    { label: 'NES & Famicom', url: 'https://www.ebay.com/sch/i.html?_dkr=1&iconV2Request=true&_blrs=recall_filtering&_ssn=timelag&store_name=timelaggaming&_oac=1&_nkw=nes' },
    { label: 'SNES & Super Famicom', url: 'https://www.ebay.com/sch/i.html?_dkr=1&iconV2Request=true&_blrs=recall_filtering&_ssn=timelag&store_name=timelaggaming&_oac=1&_nkw=snes' },
    { label: 'Nintendo 64', url: 'https://www.ebay.com/sch/i.html?_dkr=1&iconV2Request=true&_blrs=recall_filtering&_ssn=timelag&store_name=timelaggaming&_oac=1&_nkw=n64' },
    { label: 'Pokemon', url: 'https://www.ebay.com/sch/i.html?_dkr=1&iconV2Request=true&_blrs=recall_filtering&_ssn=timelag&store_name=timelaggaming&_oac=1&_nkw=pokemon' },
    { label: 'Playstation', url: 'https://www.ebay.com/sch/i.html?_dkr=1&iconV2Request=true&_blrs=recall_filtering&_ssn=timelag&store_name=timelaggaming&_oac=1&_nkw=playstation' },
    { label: 'Sega Dreamcast', url: 'https://www.ebay.com/sch/i.html?_dkr=1&iconV2Request=true&_blrs=recall_filtering&_ssn=timelag&store_name=timelaggaming&_oac=1&_nkw=dreamcast' },
    { label: 'Sega Saturn', url: 'https://www.ebay.com/sch/i.html?_dkr=1&iconV2Request=true&_blrs=recall_filtering&_ssn=timelag&store_name=timelaggaming&_oac=1&_nkw=sega%20saturn' },
    { label: 'Rare Collectibles', url: 'https://www.ebay.com/str/timelaggaming/Collectibles/_i.html?_sacat=1' },
    { label: 'Authentic Nintendo Merch', url: 'https://www.ebay.com/str/timelaggaming/Video-Game-Merchandise/_i.html?_sacat=38583' },
    { label: 'Retro Video Games', url: 'https://www.ebay.com/str/timelaggaming/Video-Games/_i.html?_sacat=139973' },
  ] as EbayCategory[],
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
