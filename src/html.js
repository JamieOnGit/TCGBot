// Small, dependency-free, error-tolerant HTML parser.
// It builds a light DOM-like tree that is good enough for reading product pages:
// structured data, meta tags, buttons, links and text. It is not a full HTML5
// parser, but it copes with unclosed tags, unquoted attributes, comments and
// raw-text elements such as <script>.

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes']);
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'menu',
  'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);
const AUTO_CLOSE = {
  li: new Set(['li']),
  option: new Set(['option']),
  optgroup: new Set(['optgroup', 'option']),
  tr: new Set(['tr', 'td', 'th']),
  td: new Set(['td', 'th']),
  th: new Set(['td', 'th']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
};

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', trade: '™',
  reg: '®', copy: '©', eacute: 'é', Eacute: 'É', egrave: 'è', times: '×',
  deg: '°', middot: '·', bull: '•', laquo: '«', raquo: '»', euro: '€',
  pound: '£', cent: '¢', frac12: '½', shy: '­', zwj: '‍', zwnj: '‌',
  colon: ':', sol: '/', comma: ',', period: '.', excl: '!', num: '#', dollar: '$', percnt: '%',
  lpar: '(', rpar: ')', plus: '+', equals: '=', quest: '?', commat: '@', lsqb: '[', rsqb: ']',
};

export function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = NAMED_ENTITIES[e] ?? NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const TAG_NAME_RE = /<([a-zA-Z][^\s/>]*)/y;
const CLOSE_TAG_RE = /<\/([a-zA-Z][^\s/>]*)[^>]*>/y;
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/y;
const WS = new Set([' ', '\t', '\n', '\r', '\f']);

function el(tag, attrs, parent) {
  return { type: 1, tag, attrs, children: [], parent };
}

/** Parse an HTML string into a tree. Elements: {type:1, tag, attrs, children, parent, text?}. Text: {type:3, text}. */
export function parseHTML(html) {
  html = String(html ?? '');
  const n = html.length;
  const lower = html.toLowerCase();
  const root = el('#root', {}, null);
  let cur = root;
  let i = 0;

  const addText = (raw) => {
    if (!raw) return;
    const text = decodeEntities(raw);
    const last = cur.children[cur.children.length - 1];
    if (last && last.type === 3) last.text += text;
    else cur.children.push({ type: 3, text, parent: cur });
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { addText(html.slice(i)); break; }
    if (lt > i) addText(html.slice(i, lt));
    i = lt;

    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const next = html[i + 1];
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (next === '/') {
      CLOSE_TAG_RE.lastIndex = i;
      const m = CLOSE_TAG_RE.exec(html);
      if (!m) {
        const end = html.indexOf('>', i);
        i = end === -1 ? n : end + 1;
        continue;
      }
      const tag = m[1].toLowerCase();
      // Pop to the nearest open element with this tag, if any.
      for (let node = cur; node && node !== root; node = node.parent) {
        if (node.tag === tag) { cur = node.parent; break; }
      }
      i = m.index + m[0].length;
      continue;
    }

    TAG_NAME_RE.lastIndex = i;
    const tm = TAG_NAME_RE.exec(html);
    if (!tm) { addText('<'); i += 1; continue; }
    const tag = tm[1].toLowerCase();
    let j = i + tm[0].length;
    const attrs = {};
    let selfClosing = false;
    while (j < n) {
      while (j < n && (WS.has(html[j]) || html[j] === '/')) {
        if (html[j] === '/' && html[j + 1] === '>') selfClosing = true;
        j++;
      }
      if (j >= n) break;
      if (html[j] === '>') { j++; break; }
      ATTR_RE.lastIndex = j;
      const am = ATTR_RE.exec(html);
      if (!am || am[0].length === 0) { j++; continue; }
      const name = am[1].toLowerCase();
      if (!(name in attrs)) attrs[name] = decodeEntities(am[2] ?? am[3] ?? am[4] ?? '');
      j += am[0].length;
    }
    i = j;

    // Implied end tags.
    if (cur.tag === 'p' && CLOSES_P.has(tag)) cur = cur.parent;
    const ac = AUTO_CLOSE[tag];
    if (ac && ac.has(cur.tag)) cur = cur.parent;

    const node = el(tag, attrs, cur);
    cur.children.push(node);

    if (RAW_TEXT.has(tag) && !selfClosing) {
      const closeIdx = lower.indexOf('</' + tag, i);
      const end = closeIdx === -1 ? n : closeIdx;
      const raw = html.slice(i, end);
      node.text = tag === 'textarea' || tag === 'title' ? decodeEntities(raw) : raw;
      if (closeIdx === -1) { i = n; } else {
        const gt = html.indexOf('>', closeIdx);
        i = gt === -1 ? n : gt + 1;
      }
      continue;
    }
    if (VOID.has(tag) || selfClosing) continue;
    cur = node;
  }
  return root;
}

/** Depth-first walk. If visit returns false, the node's children are skipped. */
export function walk(node, visit) {
  const stack = [node];
  while (stack.length) {
    const cur = stack.pop();
    if (cur.type !== 1) continue;
    if (visit(cur) === false) continue;
    for (let k = cur.children.length - 1; k >= 0; k--) stack.push(cur.children[k]);
  }
}

export function findAll(node, pred, skip) {
  const out = [];
  walk(node, (n) => {
    if (n !== node && skip && skip(n)) return false;
    if (pred(n)) out.push(n);
    return true;
  });
  return out;
}

export function findFirst(node, pred, skip) {
  let found = null;
  walk(node, (n) => {
    if (found) return false;
    if (n !== node && skip && skip(n)) return false;
    if (pred(n)) { found = n; return false; }
    return true;
  });
  return found;
}

const NO_TEXT = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'select']);

/** Visible-ish text content with whitespace collapsed. */
export function textContent(node) {
  if (!node) return '';
  if (node.type === 3) return node.text.replace(/\s+/g, ' ').trim();
  if (node.tag === 'title' || node.tag === 'textarea') return (node.text || '').replace(/\s+/g, ' ').trim();
  const parts = [];
  const rec = (n) => {
    if (n.type === 3) { parts.push(n.text); return; }
    if (NO_TEXT.has(n.tag)) return;
    if (n.tag === 'br') { parts.push(' '); return; }
    for (const c of n.children) rec(c);
    if (n.tag !== 'span' && n.tag !== 'a' && n.tag !== 'b' && n.tag !== 'strong' && n.tag !== 'em' && n.tag !== 'i') parts.push(' ');
  };
  rec(node);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export function attr(node, name) {
  return node && node.attrs ? node.attrs[name] : undefined;
}

/** id + class + common test/data attributes joined, for heuristic matching. */
export function identity(node) {
  const a = node.attrs || {};
  return [a.id, a.class, a['data-testid'], a['data-test'], a['data-test-id'], a['data-qa'], a['data-component'], a['data-section-type'], a['aria-label']]
    .filter(Boolean).join(' ');
}

export function ancestors(node) {
  const out = [];
  for (let p = node.parent; p; p = p.parent) out.push(p);
  return out;
}
