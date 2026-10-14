// Australian retailers that stock Pokémon TCG and One Piece Card Game.
//
// Each entry is plain data so it is easy to fix when a retailer changes its
// site. URL patterns follow each retailer's public product URLs. If a retailer
// changes them, edit the regexes here — or paste a product link into
// "Test a link" in the dashboard to see what the bot reads from it.
//
//   productPath  pathname regex that identifies a product page (used to pick
//                product links out of search results)
//   skuFromPath  regex with one capture group: the retailer's product code
//   searchPath   search page; {q} is replaced with the query
//   cartPath / checkoutPath / loginPath  used by checkout assist

const BROWSER_NOTE = 'Uses bot protection. If checks show "Blocked by site", the bot automatically switches to the Browser method (a real browser window).';

export const RETAILER_SPECS = [
  {
    id: 'ebgames',
    name: 'EB Games',
    base: 'https://www.ebgames.com.au',
    group: 'major',
    productPath: /^\/product\/[^/]+\/\d+/,
    skuFromPath: /^\/product\/[^/]+\/(\d+)/,
    searchPath: '/search?q={q}',
    cartPath: '/cart',
    checkoutPath: '/checkout',
    loginPath: '/',
    notes: 'Product codes are the number in the link (…/product/toys-and-collectibles/123456-…). Pre-orders often need an EB account — log in once via Settings → Retailer logins.',
  },
  {
    id: 'zing',
    name: 'Zing Pop Culture',
    base: 'https://www.zingpopculture.com.au',
    group: 'major',
    productPath: /^\/product\/[^/]+\/\d+/,
    skuFromPath: /^\/product\/[^/]+\/(\d+)/,
    searchPath: '/search?q={q}',
    cartPath: '/cart',
    checkoutPath: '/checkout',
    notes: 'Same platform as EB Games.',
  },
  {
    id: 'jbhifi',
    name: 'JB Hi-Fi',
    base: 'https://www.jbhifi.com.au',
    group: 'major',
    platform: 'shopify',
    searchPath: '/search?query={q}',
    notes: 'Shopify storefront: checks use the fast product JSON when available and fall back to the page.',
  },
  {
    id: 'kmart',
    name: 'Kmart',
    base: 'https://www.kmart.com.au',
    group: 'major',
    productPath: /^\/product\/[^/]*-\d{6,10}\/?$/,
    skuFromPath: /-(\d{6,10})\/?$/,
    searchPath: '/search/?searchTerm={q}',
    cartPath: '/cart',
    checkoutPath: '/checkout',
    notes: `Keycode = the number at the end of the link. "In-store only" counts as out of stock. ${BROWSER_NOTE}`,
  },
  {
    id: 'target',
    name: 'Target',
    base: 'https://www.target.com.au',
    group: 'major',
    productPath: /^\/p\/[^/]+\/[A-Za-z0-9_-]+\/?$/,
    skuFromPath: /^\/p\/[^/]+\/([A-Za-z0-9_-]+)/,
    searchPath: '/search?text={q}',
    cartPath: '/basket',
    checkoutPath: '/checkout',
    notes: BROWSER_NOTE,
  },
  {
    id: 'bigw',
    name: 'BIG W',
    base: 'https://www.bigw.com.au',
    group: 'major',
    productPath: /^\/product\/[^/]+\/p\/\d+/,
    skuFromPath: /\/p\/(\d+)/,
    searchPath: '/search?text={q}',
    cartPath: '/cart',
    checkoutPath: '/checkout',
    notes: BROWSER_NOTE,
  },
  {
    id: 'toysrus',
    name: 'Toys"R"Us',
    base: 'https://www.toysrus.com.au',
    group: 'major',
    platform: 'shopify',
    notes: 'Shopify storefront.',
  },
  {
    id: 'amazon',
    name: 'Amazon AU',
    base: 'https://www.amazon.com.au',
    group: 'major',
    productPath: /\/(dp|gp\/product)\/[A-Z0-9]{10}/,
    skuFromPath: /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/,
    searchPath: '/s?k={q}',
    productPathFromSku: '/dp/{sku}',
    cartPath: '/gp/cart/view.html',
    checkoutPath: null,
    minGapSeconds: 10,
    hints: { availabilityRe: /(^|[\s_-])(availability|outOfStock)([\s_-]|$)/i },
    notes: 'SKU = the 10-character ASIN. Only "Ships from/sold by Amazon" listings are reliable. Amazon rate-limits aggressively, so it is checked at most every 10s.',
  },
];
