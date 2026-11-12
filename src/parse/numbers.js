/**
 * Number, currency and date parsing for messy invoices from many countries.
 *
 *   1,234.56   1.234,56   1 234,56   1'234.50   (1,200.00)   1.200,00-   -€45   12,5 %
 *   2026-10-15   15.10.2026   10/15/2026   15/10/26   3 Oct 2026   October 3, 2026   3. Oktober 2026
 */

const SPACES = /[\s    ']/g;

/**
 * Guess the decimal separator a document uses: ',' for "1.234,56" style, '.' for "1,234.56".
 * Counts money-looking tokens (two decimals at the end of a number).
 */
export function detectDecimalSeparator(text) {
  const s = String(text || '');
  const comma = (s.match(/\d,\d{2}(?![\d,.])/g) || []).length + (s.match(/\d\.\d{3},\d{2}\b/g) || []).length * 2;
  const dot = (s.match(/\d\.\d{2}(?![\d,.])/g) || []).length + (s.match(/\d,\d{3}\.\d{2}\b/g) || []).length * 2;
  if (comma === 0 && dot === 0) return null;
  return comma > dot ? ',' : '.';
}

/**
 * Parse an amount string to a Number (or null). `decimal` (',' | '.') breaks ties like "1.234"
 * or "1,234" where the separator alone is ambiguous.
 */
export function parseAmount(input, { decimal = null } = {}) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  let s = String(input).trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/\d\s*CR\.?$/i.test(s)) negative = true; // accounting "credit" suffix
  // Strip currency symbols / ISO codes and anything that is not part of a number.
  s = s.replace(/[A-Za-z€$£¥₹₩₪₫₦₱₴₸₺₼₽฿﷼]+\.?/g, '').replace(SPACES, '');
  if (/^[-−–]/.test(s)) {
    negative = true;
    s = s.replace(/^[-−–]+/, '');
  }
  if (/[-−–]$/.test(s)) {
    negative = true;
    s = s.replace(/[-−–]+$/, '');
  }
  s = s.replace(/^\+/, '').replace(/%$/, '');
  if (!/^\d[\d.,]*$/.test(s) && !/^[.,]\d+$/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let dec = null;
  if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
  else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const count = s.split(sep).length - 1;
    const after = s.length - s.lastIndexOf(sep) - 1;
    if (count > 1) dec = null; // 1.234.567 -> thousands only
    else if (after === 3 && s.indexOf(sep) > 0) dec = decimal && decimal === sep ? sep : null; // 1,234 -> thousands unless the doc says otherwise
    else dec = sep;
  }
  let clean;
  if (dec === null) clean = s.replace(/[.,]/g, '');
  else {
    const thousands = dec === '.' ? ',' : '.';
    clean = s.split(thousands).join('');
    if (dec === ',') clean = clean.replace(',', '.');
    if ((clean.match(/\./g) || []).length > 1) return null;
  }
  const n = Number(clean);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Every amount-looking token in a string, in order, with its position. */
export function findAmounts(text, { decimal = null } = {}) {
  const out = [];
  // A plain space only groups thousands in comma-decimal documents ("1 234,56"); elsewhere
  // "12 150.00" is a quantity followed by a price, not 12150.
  const group = decimal === ',' ? "[.,\\s\\u00a0\\u202f'’]" : "[.,\\u00a0\\u202f'’]";
  const re = new RegExp(
    [
      '(?:\\(\\s*)?[-−–]?\\s?(?:[€$£¥₹]\\s?)?\\d{1,2}(?:,\\d{2})+,\\d{3}(?:\\.\\d{1,2})?(?!\\d)(?:\\s*\\))?', // Indian lakh: 2,22,000.00
      `(?:\\(\\s*)?[-−–]?\\s?(?:[€$£¥₹]\\s?)?\\d{1,3}(?:${group}\\d{3})*(?:[.,]\\d{1,4})?(?!\\d)(?:\\s?[-−–](?!\\d))?(?:\\s*\\))?`,
      '(?:\\(\\s*)?[-−–]?(?:[€$£¥₹]\\s?)?\\d+(?:[.,]\\d{1,4})?(?:\\s*\\))?',
    ].join('|'),
    'g',
  );
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0].trim();
    if (!/\d/.test(raw)) continue;
    const value = parseAmount(raw, { decimal });
    if (value !== null) out.push({ raw, value, index: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function round2(n) {
  return n === null || n === undefined || !Number.isFinite(n) ? null : Math.round((n + Number.EPSILON) * 100) / 100;
}

/** a ≈ b within max(absTol, relTol * |b|). */
export function near(a, b, { abs = 0.02, rel = 0 } = {}) {
  // Money checks use cent tolerances, never a % of the amount (0.5 % of 4,500 would hide $22).
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= Math.max(abs, rel * Math.abs(b));
}

/* ------------------------------------------------------------------ currencies */

const SYMBOLS = [
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['₹', 'INR'],
  ['¥', 'JPY'],
  ['₩', 'KRW'],
  ['₺', 'TRY'],
  ['₽', 'RUB'],
  ['₦', 'NGN'],
  ['₱', 'PHP'],
  ['﷼', 'SAR'],
  ['R$', 'BRL'],
  ['A$', 'AUD'],
  ['C$', 'CAD'],
  ['CA$', 'CAD'],
  ['US$', 'USD'],
  ['HK$', 'HKD'],
  ['S$', 'SGD'],
  ['NZ$', 'NZD'],
  ['$', 'USD'],
];
export const ISO_CURRENCIES = new Set(
  'EUR USD GBP CHF CAD AUD NZD JPY CNY HKD SGD INR AED SAR QAR KWD BHD OMR EGP MAD TND DZD ZAR NGN KES SEK NOK DKK PLN CZK HUF RON BGN TRY ILS RUB UAH BRL MXN ARS CLP COP PEN KRW THB MYR IDR PHP VND PKR BDT LKR'.split(
    ' ',
  ),
);
const WORDS = [
  [/\b(dirhams?|AED)\b|د\.إ/i, 'AED'],
  [/\b(riyals?|SAR)\b|ر\.س/i, 'SAR'],
  [/\b(rupees?|Rs\.?)\s?\d/i, 'INR'],
  [/\bfr\.\s?\d|\bCHF\b/i, 'CHF'],
];

/** Most likely ISO currency of a document (ISO codes beat symbols; "$" alone means USD). */
export function detectCurrency(text) {
  const s = String(text || '');
  const counts = new Map();
  const bump = (c, n = 1) => counts.set(c, (counts.get(c) || 0) + n);
  for (const m of s.matchAll(/\b([A-Z]{3})\b/g)) if (ISO_CURRENCIES.has(m[1])) bump(m[1], 2);
  let rest = s;
  for (const [sym, code] of SYMBOLS) {
    const n = rest.split(sym).length - 1;
    if (n) {
      bump(code, n);
      rest = rest.split(sym).join(' ');
    }
  }
  for (const [re, code] of WORDS) if (re.test(s)) bump(code, 1);
  let best = null;
  for (const [c, n] of counts) if (!best || n > best[1]) best = [c, n];
  return best ? best[0] : null;
}

/* ------------------------------------------------------------------ dates */

const MONTHS = {
  jan: 1, january: 1, janv: 1, janvier: 1, januar: 1, jänner: 1, enero: 1, ene: 1, gennaio: 1, gen: 1, januari: 1, jan_: 1,
  feb: 2, february: 2, févr: 2, fevr: 2, février: 2, fevrier: 2, februar: 2, febrero: 2, febbraio: 2, februari: 2,
  mar: 3, march: 3, mars: 3, märz: 3, maerz: 3, marzo: 3, mrz: 3, maart: 3,
  apr: 4, april: 4, avr: 4, avril: 4, abril: 4, abr: 4, aprile: 4,
  may: 5, mai: 5, mayo: 5, maggio: 5, mag: 5, mei: 5,
  jun: 6, june: 6, juin: 6, juni: 6, junio: 6, giugno: 6, giu: 6,
  jul: 7, july: 7, juil: 7, juillet: 7, juli: 7, julio: 7, luglio: 7, lug: 7,
  aug: 8, august: 8, août: 8, aout: 8, agosto: 8, ago: 8, augustus: 8,
  sep: 9, sept: 9, september: 9, septembre: 9, septiembre: 9, settembre: 9, set: 9,
  oct: 10, october: 10, octobre: 10, oktober: 10, octubre: 10, ottobre: 10, okt: 10, ott: 10,
  nov: 11, november: 11, novembre: 11, noviembre: 11,
  dec: 12, december: 12, décembre: 12, decembre: 12, dezember: 12, diciembre: 12, dicembre: 12, dez: 12, dic: 12,
};
const MONTH_RE = Object.keys(MONTHS)
  .filter((k) => !k.endsWith('_'))
  .sort((a, b) => b.length - a.length)
  .join('|');

function iso(y, m, d) {
  y = Number(y);
  m = Number(m);
  d = Number(d);
  if (y < 100) y += y >= 70 ? 1900 : 2000;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1970 && y <= 2100)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // 31 Feb
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Regex source matching one date in any supported format (for searching inside text). */
export const DATE_PATTERN = `(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|\\d{1,2}\\.?[\\s-]*(?:de\\s+)?(?:${MONTH_RE})\\.?[\\s,-]*(?:de\\s+)?\\d{2,4}|(?:${MONTH_RE})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})`;

/**
 * Parse a date to ISO YYYY-MM-DD. `dayFirst` decides 03/04/2026 (true: 3 April; false: March 4);
 * an impossible reading (month 13+) overrides it.
 */
export function parseDate(input, { dayFirst = true } = {}) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[t\s].*)?$/))) return iso(m[1], m[2], m[3]);
  if ((m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return iso(m[1], m[2], m[3]);
  if ((m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/))) return iso(m[3], m[2], m[1]); // dotted = day first everywhere
  if ((m = s.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12) return iso(m[3], b, a);
    if (b > 12) return iso(m[3], a, b);
    return dayFirst ? iso(m[3], b, a) : iso(m[3], a, b);
  }
  const monthRe = new RegExp(`(\\d{1,2})\\.?[\\s-]*(?:de\\s+)?(${MONTH_RE})\\.?[\\s,-]*(?:de\\s+)?(\\d{2,4})`, 'i');
  if ((m = s.match(monthRe))) return iso(m[3], MONTHS[m[2]], m[1]);
  const monthFirst = new RegExp(`(${MONTH_RE})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i');
  if ((m = s.match(monthFirst))) return iso(m[3], MONTHS[m[1]], m[2]);
  return null;
}

/** US-style documents write month first; nearly everyone else writes day first. */
export function guessDayFirst({ currency, text = '' } = {}) {
  if (currency === 'USD' && !/\b(VAT|GST|IVA|TVA|MwSt|USt)\b/i.test(text)) return false;
  if (/\b(EIN|Sales Tax)\b/i.test(text) && !/\bVAT\b/i.test(text)) return false;
  return true;
}
