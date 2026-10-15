// Stock status vocabulary shared by every part of the bot.

export const STATUS = Object.freeze({
  IN_STOCK: 'in_stock',
  PREORDER: 'preorder',
  OUT_OF_STOCK: 'out_of_stock',
  COMING_SOON: 'coming_soon',
  NOT_LISTED: 'not_listed', // keyword/SKU watch: no matching listing yet
  NOT_FOUND: 'not_found', // product URL returns 404 / removed
  BLOCKED: 'blocked', // retailer refused the request (bot protection / rate limit)
  ERROR: 'error',
  UNKNOWN: 'unknown',
});

export const STATUS_LABEL = Object.freeze({
  in_stock: 'In stock',
  preorder: 'Pre-order open',
  out_of_stock: 'Out of stock',
  coming_soon: 'Coming soon',
  not_listed: 'Not listed yet',
  not_found: 'Page not found',
  blocked: 'Blocked by site',
  error: 'Error',
  unknown: 'Unknown',
});

export function isOrderable(status) {
  return status === STATUS.IN_STOCK || status === STATUS.PREORDER;
}

/** Combine several availability readings for the same product (e.g. variants or offers). */
export function combineStatuses(list) {
  const s = new Set(list.filter(Boolean));
  if (s.has(STATUS.IN_STOCK)) return STATUS.IN_STOCK;
  if (s.has(STATUS.PREORDER)) return STATUS.PREORDER;
  if (s.has(STATUS.COMING_SOON)) return STATUS.COMING_SOON;
  if (s.has(STATUS.OUT_OF_STOCK)) return STATUS.OUT_OF_STOCK;
  return null;
}
