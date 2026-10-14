// Keyword matching for finding listings (including products that are not
// released or not listed yet).
//
// Syntax:   comma  = AND (every group must match)
//           |      = OR  (any alternative in a group)
// Example:  "one piece, op-18|op18, booster box|display"
//
// Matching ignores case, accents (Pokémon == pokemon) and punctuation/spaces
// between letters and digits, so "op-18", "OP18" and "op 18" are all equal,
// but "op-1" does NOT match "op-18".

export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ');
}

function tokens(term) {
  return normalize(term)
    .split(/[^a-z0-9]+/)
    .flatMap((t) => t.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/))
    .filter(Boolean);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function termRegex(term) {
  const toks = tokens(term);
  if (!toks.length) return null;
  const first = toks[0];
  const last = toks[toks.length - 1];
  const lead = /^\d/.test(first) ? '(?<![0-9])' : '(?<![a-z])';
  const plural = /[a-z]$/.test(last) && last.length > 2 ? '(?:e?s)?' : '';
  const trail = /\d$/.test(last) ? '(?![0-9])' : '(?![a-z])';
  return new RegExp(lead + toks.map(escapeRe).join('[^a-z0-9]*') + plural + trail);
}

export function parseKeywords(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input.join(',') : String(input);
  return raw
    .split(/[,;\n]+/)
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) => {
      const alts = g.split('|').map((a) => a.trim()).filter(Boolean)
        .map((a) => ({ raw: a, re: termRegex(a) }))
        .filter((a) => a.re);
      return { raw: g, alts };
    })
    .filter((g) => g.alts.length);
}

/** Does `text` satisfy the keyword groups and avoid every excluded term? */
export function matchText(text, keywords, exclude) {
  const groups = Array.isArray(keywords) ? keywords : parseKeywords(keywords);
  const excl = Array.isArray(exclude) ? exclude : parseKeywords(exclude);
  const t = normalize(text);
  const matched = [];
  const missing = [];
  for (const g of groups) {
    const hit = g.alts.find((a) => a.re.test(t));
    if (hit) matched.push(hit.raw); else missing.push(g.raw);
  }
  const excluded = [];
  for (const g of excl) for (const a of g.alts) if (a.re.test(t)) excluded.push(a.raw);
  return { ok: groups.length > 0 && missing.length === 0 && excluded.length === 0, matched, missing, excluded };
}

/** A search query to type into a retailer's search box: the first alternative of each group. */
export function searchQueryFor(keywords) {
  return parseKeywords(keywords).map((g) => g.alts[0].raw).join(' ').trim();
}

/** Rank search hits against keywords; best first. Hits are {url, name, slug}. */
export function rankHits(hits, keywords, exclude) {
  const groups = parseKeywords(keywords);
  const excl = parseKeywords(exclude);
  const out = [];
  for (const h of hits) {
    const text = `${h.name || ''} ${h.slug || ''}`;
    const m = matchText(text, groups, excl);
    if (!m.ok) continue;
    // Prefer shorter, more specific titles (e.g. "Booster Box" over "Booster Box Case Bundle").
    const words = normalize(h.name || h.slug || '').split(/\s+/).filter(Boolean).length;
    out.push({ ...h, score: 100 - words });
  }
  return out.sort((a, b) => b.score - a.score);
}
