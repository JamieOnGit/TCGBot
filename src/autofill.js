// Fills checkout forms from your saved profile (and card, if the vault is
// unlocked). Field detection runs in the page (pagescripts.js); deciding what
// each field is and what to type happens here so it can be unit-tested.

import { pageScanFields } from './pagescripts.js';
import { AU_STATES } from './schema.js';

const AUTOCOMPLETE = {
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'given-name': 'firstName',
  'family-name': 'lastName',
  name: 'fullName',
  'address-line1': 'address1',
  'street-address': 'address1',
  'address-line2': 'address2',
  'address-level2': 'suburb',
  'address-level1': 'state',
  'postal-code': 'postcode',
  country: 'country',
  'country-name': 'country',
  'cc-number': 'cardNumber',
  'cc-name': 'cardName',
  'cc-exp': 'cardExpiry',
  'cc-exp-month': 'cardExpMonth',
  'cc-exp-year': 'cardExpYear',
  'cc-csc': 'cardCvc',
};

// Order matters: the first rule that matches wins.
export const FIELD_RULES = [
  ['addressLookup', /(start typing|search|find|look ?up|lookup|enter).{0,25}address|address.{0,15}(search|finder|lookup|look ?up|autocomplete|autofill)/],
  [null, /company|business|organi[sz]ation|\babn\b|gift|message|instruction|comment|\bnote|coupon|promo|voucher|discount|referral|username|date of birth|\bdob\b|birthday|po number|reference/],
  ['cardNumber', /card.?number|cardnumber|cc.?num|encryptedcardnumber|credit.?card.?(no|num)|\bpan\b|card no\b/],
  ['cardCvc', /\bcvv|\bcvc|\bcsc\b|security.?code|verification.?value|encryptedsecuritycode|card.?code|\bcvn\b/],
  ['cardExpMonth', /exp\w*.?month|cc.?month|expirymonth|encryptedexpirymonth|card.?month/],
  ['cardExpYear', /exp\w*.?year|cc.?year|expiryyear|encryptedexpiryyear|card.?year/],
  ['cardExpiry', /expir|exp.?date|mm\s*\/\s*yy|encryptedexpirydate|valid.?(thru|until)|\bexp\b/],
  ['cardName', /name.?on.?card|card.?holder|cardholder|holder.?name|cc.?name|card.?name|nameoncard/],
  ['email', /e-?mail/],
  ['phone', /phone|mobile|\btel\b|telephone|contact.?number/],
  ['firstName', /first.?name|given.?name|\bfname\b|firstname/],
  ['lastName', /last.?name|surname|family.?name|\blname\b|lastname/],
  ['address2', /address.?(line)?.?2|addr(ess)?2|apartment|\bunit\b|suite|\bapt\b|line ?2/],
  ['address1', /address.?(line)?.?1|addr(ess)?1|street|\baddress\b|line ?1/],
  ['suburb', /suburb|city|town|locality/],
  ['postcode', /post.?code|postal|\bzip\b/],
  ['country', /country/],
  ['state', /\bstate\b|province|region|territory/],
  ['fullName', /full.?name|\bname\b|recipient/],
];

export const CARD_KINDS = new Set(['cardNumber', 'cardCvc', 'cardExpMonth', 'cardExpYear', 'cardExpiry', 'cardName']);

/** Work out what a form field is for. Returns a kind (e.g. "email") or null. */
export function classifyField(rec) {
  if (rec.type === 'checkbox' || rec.type === 'radio') return null;
  const tokens = (rec.autocomplete || '').split(/\s+/).filter(Boolean);
  const last = tokens[tokens.length - 1];
  const desc = rec.desc || '';
  if (last && AUTOCOMPLETE[last]) {
    const k = AUTOCOMPLETE[last];
    // autocomplete="name" on a card form is the card holder.
    if (k === 'fullName' && /card|holder/.test(desc)) return 'cardName';
    return k;
  }
  if (rec.type === 'email') return 'email';
  if (rec.type === 'tel' && !/card|cvv|cvc|security/.test(desc)) return 'phone';
  for (const [kind, re] of FIELD_RULES) {
    if (re.test(desc)) return kind;
  }
  return null;
}

/** The values we can type, from the profile and (optionally) the unlocked card. */
export function profileValues(profile = {}, card = null) {
  const v = {
    email: profile.email || '',
    phone: profile.phone || '',
    firstName: profile.firstName || '',
    lastName: profile.lastName || '',
    fullName: [profile.firstName, profile.lastName].filter(Boolean).join(' '),
    address1: profile.address1 || '',
    address2: profile.address2 || '',
    suburb: profile.suburb || '',
    state: profile.state || '',
    postcode: profile.postcode || '',
    country: 'Australia',
  };
  if (card) {
    v.cardNumber = card.number;
    v.cardName = card.name;
    v.cardExpMonth = card.expMonth;
    v.cardExpYear = card.expYear;
    v.cardExpiry = `${card.expMonth}/${card.expYear.slice(-2)}`;
    v.cardCvc = card.cvc || '';
  }
  return v;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PLACEHOLDER_OPTION_RE = /^(-+|select|choose|please|pick|state|country|month|year|mm|yy|yyyy)\b/i;

/** Choose the <option> value to select for a field kind. */
export function chooseOption(kind, options, values) {
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const opts = (options || []).filter((o) => o.value !== '' || o.text);
  const exact = (cands) => {
    for (const c of cands.filter(Boolean).map(norm)) {
      const o = opts.find((x) => norm(x.value) === c || norm(x.text) === c);
      if (o) return o.value;
    }
    return null;
  };
  switch (kind) {
    case 'state': {
      const abbr = String(values.state || '').toUpperCase();
      const full = AU_STATES[abbr];
      if (!abbr) return null;
      return exact([abbr, full]) ?? opts.find((o) => full && norm(o.text).includes(norm(full)))?.value ?? null;
    }
    case 'country':
      return exact(['AU', 'AUS', 'Australia']) ?? opts.find((o) => /australia/i.test(o.text))?.value ?? null;
    case 'cardExpMonth': {
      const m = parseInt(values.cardExpMonth, 10);
      if (!m) return null;
      return opts.find((o) => parseInt(o.value, 10) === m || parseInt(o.text, 10) === m || norm(o.text).startsWith(MONTHS[m - 1]))?.value ?? null;
    }
    case 'cardExpYear': {
      const y = parseInt(values.cardExpYear, 10);
      if (!y) return null;
      return opts.find((o) => [o.value, o.text].some((x) => { const n = parseInt(x, 10); return n === y || n === y % 100; }))?.value ?? null;
    }
    default: {
      const v = values[kind];
      return v ? exact([v]) : null;
    }
  }
}

/** Value for a single expiry input, matching its expected format. */
export function expiryText(rec, values) {
  const mm = values.cardExpMonth;
  const yyyy = values.cardExpYear;
  const ph = `${rec.placeholder || ''} ${rec.desc || ''}`.toLowerCase();
  if (rec.maxLength === 4) return `${mm}${yyyy.slice(-2)}`;
  if (/yyyy/.test(ph) || (rec.maxLength && rec.maxLength >= 7 && !/yy\b/.test(ph))) return `${mm}/${yyyy}`;
  return `${mm}/${yyyy.slice(-2)}`;
}

export function selectNeedsValue(rec) {
  if (!rec.value) return true;
  return PLACEHOLDER_OPTION_RE.test(rec.selectedText || '');
}

/** Decide what to do with each scanned field. Pure function — unit tested. */
export function planFill(recs, values) {
  const actions = [];
  const unknownRequired = [];
  const kinds = new Set();
  let addressLookup = false;
  for (const rec of recs) {
    if (rec.type === 'checkbox' || rec.type === 'radio') continue;
    const kind = classifyField(rec);
    if (kind) kinds.add(kind);
    if (kind === 'addressLookup') { addressLookup = true; continue; }
    if (!kind) {
      if (rec.required && !rec.value) unknownRequired.push(rec.desc.split(' | ').slice(-1)[0] || rec.name || rec.key);
      continue;
    }
    if (rec.tag === 'select') {
      if (!selectNeedsValue(rec)) continue;
      const v = chooseOption(kind, rec.options, values);
      if (v !== null && v !== undefined) actions.push({ key: rec.key, kind, action: 'select', value: v });
      else if (rec.required) unknownRequired.push(rec.desc.split(' | ').slice(-1)[0] || rec.name);
      continue;
    }
    if (rec.value) continue; // never overwrite what's already there (e.g. saved account details)
    let v = values[kind];
    if (kind === 'cardExpiry' && values.cardExpMonth) v = expiryText(rec, values);
    if (!v) {
      if (rec.required) unknownRequired.push(rec.desc.split(' | ').slice(-1)[0] || rec.name);
      continue;
    }
    actions.push({ key: rec.key, kind, action: 'fill', value: v, rec });
  }

  // Radio groups: pick home delivery, and card payment when we have a card.
  const groups = new Map();
  for (const rec of recs) {
    if (rec.type !== 'radio') continue;
    const g = rec.name || rec.key;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(rec);
  }
  for (const list of groups.values()) {
    if (list.some((r) => r.checked)) continue;
    const labels = list.map((r) => (r.label || '').toLowerCase());
    const isPayment = labels.some((l) => /paypal|afterpay|zip|klarna|apple pay|google pay|credit|debit/.test(l));
    const isDelivery = labels.some((l) => /deliver|shipping|post|courier|express|standard|collect|pick ?up/.test(l));
    let pick = null;
    if (isPayment && values.cardNumber) pick = list.find((r) => /credit|debit|card|visa|mastercard/.test((r.label || '').toLowerCase()));
    else if (isDelivery && !isPayment) {
      pick = list.find((r) => /standard|home delivery|deliver to|delivery|shipping|post/.test((r.label || '').toLowerCase()) && !/collect|pick ?up|in-?store|click/.test((r.label || '').toLowerCase()));
    }
    if (pick) actions.push({ key: pick.key, kind: 'radio', action: 'click', value: pick.label });
  }

  // "I agree to the terms" boxes (never marketing opt-ins).
  for (const rec of recs) {
    if (rec.type !== 'checkbox' || rec.checked) continue;
    const l = `${rec.label || ''} ${rec.desc || ''}`.toLowerCase();
    if (/agree|terms|conditions|t\s?&\s?c/.test(l) && !/newsletter|marketing|subscribe|offers|promotion|news\b|sms|email me|updates/.test(l)) {
      actions.push({ key: rec.key, kind: 'terms', action: 'click', value: true });
    }
  }
  return { actions, unknownRequired, kinds, addressLookup };
}

async function fillOne(frame, a) {
  const loc = frame.locator(`[data-tcgbot-f="${a.key}"]`);
  if (a.action === 'select') {
    await loc.selectOption(a.value, { timeout: 3000 });
    return;
  }
  if (a.action === 'click') {
    await loc.evaluate((el) => el.click());
    return;
  }
  await loc.fill(a.value, { timeout: 3000 });
  if (CARD_KINDS.has(a.kind) && a.kind !== 'cardName') {
    // Payment widgets often reformat as you type; if a plain fill didn't stick, type it.
    const got = (await loc.inputValue().catch(() => '')).replace(/\D/g, '');
    const want = a.value.replace(/\D/g, '');
    if (got !== want) {
      await loc.fill('').catch(() => {});
      await loc.pressSequentially(a.kind === 'cardExpiry' ? want : a.value, { delay: 15 });
    }
  }
}

/** Fill every frame of the page. Returns a summary of what happened. */
export async function autofillPage(page, values) {
  const summary = { filled: [], unknownRequired: [], kinds: new Set(), addressLookup: false, errors: [] };
  for (const frame of page.frames()) {
    let recs;
    try {
      recs = await frame.evaluate(pageScanFields);
    } catch {
      continue; // frame navigated away or is not scriptable
    }
    if (!recs.length) continue;
    const plan = planFill(recs, values);
    plan.kinds.forEach((k) => summary.kinds.add(k));
    summary.unknownRequired.push(...plan.unknownRequired);
    if (plan.addressLookup) summary.addressLookup = true;
    for (const a of plan.actions) {
      try {
        await fillOne(frame, a);
        summary.filled.push(a.kind);
      } catch (e) {
        summary.errors.push(`${a.kind}: ${e.message.split('\n')[0]}`);
      }
    }
  }
  return summary;
}
