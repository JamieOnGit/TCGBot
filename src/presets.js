// Quick-add templates for popular releases. They are keyword searches rather
// than fixed SKUs, so they also catch products that aren't listed yet — the
// bot finds the listing as soon as a retailer publishes it.
//
// Keyword syntax: comma = AND, | = OR. Exclusions stop accessories matching.

const ACCESSORIES = 'sleeve, sleeves, binder, playmat, deck box, portfolio, toploader, storage, figure, plush, single card';

export const PRESETS = [
  {
    id: 'pkm-upc-30th',
    game: 'Pokémon',
    name: 'Pokémon TCG — 30th Anniversary Ultra-Premium Collection',
    keywords: 'pokemon, ultra premium|ultra-premium|upc, 30th|anniversary',
    exclude: ACCESSORIES,
    searchQuery: 'pokemon ultra premium collection',
  },
  {
    id: 'op-18-box',
    game: 'One Piece',
    name: 'One Piece Card Game — OP-18 Booster Box',
    keywords: 'one piece, op-18|op18|op 18, booster box|booster display|display|24 packs|24 pack',
    exclude: `${ACCESSORIES}, case of`,
    searchQuery: 'one piece op-18',
  },
  {
    id: 'pkm-etb',
    game: 'Pokémon',
    name: 'Pokémon TCG — Elite Trainer Box (edit the set name)',
    keywords: 'pokemon, elite trainer box|etb, SET NAME',
    exclude: ACCESSORIES,
    searchQuery: 'pokemon elite trainer box',
  },
  {
    id: 'pkm-booster-bundle',
    game: 'Pokémon',
    name: 'Pokémon TCG — Booster Bundle (edit the set name)',
    keywords: 'pokemon, booster bundle, SET NAME',
    exclude: ACCESSORIES,
    searchQuery: 'pokemon booster bundle',
  },
  {
    id: 'pkm-booster-box',
    game: 'Pokémon',
    name: 'Pokémon TCG — Booster Box / Display (edit the set name)',
    keywords: 'pokemon, booster box|booster display|36 packs, SET NAME',
    exclude: ACCESSORIES,
    searchQuery: 'pokemon booster box',
  },
  {
    id: 'op-booster-box',
    game: 'One Piece',
    name: 'One Piece Card Game — Booster Box (edit the set code, e.g. OP-19)',
    keywords: 'one piece, booster box|booster display|display, OP-XX',
    exclude: ACCESSORIES,
    searchQuery: 'one piece booster box',
  },
  {
    id: 'op-premium',
    game: 'One Piece',
    name: 'One Piece Card Game — Premium Booster (PRB)',
    keywords: 'one piece, premium booster|prb',
    exclude: ACCESSORIES,
    searchQuery: 'one piece premium booster',
  },
  {
    id: 'op-starter',
    game: 'One Piece',
    name: 'One Piece Card Game — Starter Deck (edit the deck code, e.g. ST-29)',
    keywords: 'one piece, starter deck, ST-XX',
    exclude: ACCESSORIES,
    searchQuery: 'one piece starter deck',
  },
];
