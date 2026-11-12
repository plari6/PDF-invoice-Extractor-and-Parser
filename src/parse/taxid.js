/**
 * Tax / company ID detection and validation.
 *
 * Checksums are verified where the algorithm is public (DE, GB, FR, IT, BE, ES-partial, IN GSTIN,
 * AU ABN, CH UID, CA BN, IBAN); other formats get a format check. `valid` is true / false, or null
 * when only the shape could be checked. A failed checksum usually means an OCR/AI misread or a typo
 * on the invoice - exactly what an AP clerk wants flagged before paying.
 */

const EU_VAT = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-HJ-NP-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^\d{7}[A-W][A-I]?$|^\d[A-Z+*]\d{5}[A-W]$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
  XI: /^\d{9}$|^\d{12}$/,
  GB: /^\d{9}$|^\d{12}$|^GD\d{3}$|^HA\d{3}$/,
  NO: /^\d{9}(MVA)?$/,
};

const digits = (s) => [...s].map(Number);

/* ---------- checksum helpers (exported so tests and the demo can build valid IDs) ---------- */

export function deCheckDigit(first8) {
  let product = 10;
  for (const d of digits(first8)) {
    let sum = (d + product) % 10;
    if (sum === 0) sum = 10;
    product = (2 * sum) % 11;
  }
  const check = 11 - product;
  return check === 10 ? 0 : check;
}

function gbValid(n) {
  const d = digits(n.slice(0, 9));
  const total = d.slice(0, 7).reduce((s, x, i) => s + x * (8 - i), 0) + Number(n.slice(7, 9));
  return total % 97 === 0 || (total + 55) % 97 === 0;
}
/** Last two digits that make a 7-digit GB VAT base valid (mod 97 scheme). */
export function gbCheckDigits(first7) {
  const sum = digits(first7).reduce((s, x, i) => s + x * (8 - i), 0);
  const check = (97 - (sum % 97)) % 97;
  return String(check).padStart(2, '0');
}

export function frKey(siren) {
  return String((12 + 3 * (Number(siren) % 97)) % 97).padStart(2, '0');
}

export function luhnValid(num) {
  let sum = 0;
  const d = digits(num).reverse();
  d.forEach((x, i) => {
    if (i % 2 === 1) {
      x *= 2;
      if (x > 9) x -= 9;
    }
    sum += x;
  });
  return sum % 10 === 0;
}

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function gstinCheckChar(first14) {
  let sum = 0;
  [...first14].forEach((c, i) => {
    const prod = GST_CHARS.indexOf(c) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  });
  return GST_CHARS[(36 - (sum % 36)) % 36];
}

export function abnValid(n) {
  if (!/^\d{11}$/.test(n)) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const d = digits(n);
  d[0] -= 1;
  return d.reduce((s, x, i) => s + x * w[i], 0) % 89 === 0;
}

function cheValid(n9) {
  const w = [5, 4, 3, 2, 7, 6, 5, 4];
  const d = digits(n9);
  const sum = d.slice(0, 8).reduce((s, x, i) => s + x * w[i], 0);
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  return check !== 10 && check === d[8];
}

export function ibanValid(raw) {
  const s = String(raw || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const moved = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of moved) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}
/** Build a valid IBAN from country + BBAN (used by the demo invoices). */
export function makeIban(country, bban) {
  const moved = (bban + country + '00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of moved) rem = (rem * 10 + Number(ch)) % 97;
  return `${country}${String(98 - rem).padStart(2, '0')}${bban}`;
}

const EIN_BAD_PREFIX = new Set(['00', '07', '08', '09', '17', '18', '19', '28', '29', '49', '69', '70', '78', '79', '89', '96', '97']);

/* ---------- classification ---------- */

/**
 * Classify one candidate ID. `label` is the text printed before it ("VAT No", "ABN", "GSTIN"...).
 * @returns {{ value, type, country, valid } | null}
 */
export function classifyTaxId(raw, label = '') {
  if (!raw) return null;
  const printed = String(raw).trim();
  const c = printed.toUpperCase().replace(/[\s.\-/]/g, '');
  const lab = String(label).toUpperCase();
  if (c.length < 6) return null;

  // India GSTIN: 2-digit state + PAN + entity + Z + checksum
  if (/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(c)) {
    return { value: c, type: 'GSTIN', country: 'IN', valid: gstinCheckChar(c.slice(0, 14)) === c[14] };
  }
  // Swiss UID (CHE-123.456.789 MWST)
  let m = c.match(/^CHE(\d{9})(MWST|TVA|IVA|VAT)?$/);
  if (m) return { value: `CHE-${m[1].slice(0, 3)}.${m[1].slice(3, 6)}.${m[1].slice(6)}`, type: 'UID', country: 'CH', valid: cheValid(m[1]) };

  // EU-style VAT with country prefix (also GB, XI, NO)
  m = c.match(/^([A-Z]{2})([0-9A-Z+*]{2,13})$/);
  if (m && EU_VAT[m[1]] && !/IBAN/.test(lab)) {
    const [, cc, num] = m;
    if (!EU_VAT[cc].test(num)) return { value: c, type: 'VAT', country: cc === 'EL' ? 'GR' : cc, valid: false };
    let valid = null;
    if (cc === 'DE') valid = deCheckDigit(num.slice(0, 8)) === Number(num[8]);
    else if (cc === 'GB' || cc === 'XI') valid = /^\d/.test(num) ? gbValid(num) : null;
    else if (cc === 'FR') valid = /^\d{2}/.test(num) ? frKey(num.slice(2)) === num.slice(0, 2) : null;
    else if (cc === 'IT') valid = luhnValid(num);
    else if (cc === 'BE') valid = 97 - (Number(num.slice(0, 8)) % 97) === Number(num.slice(8));
    return { value: c, type: 'VAT', country: cc === 'EL' ? 'GR' : cc, valid };
  }

  const only = c.replace(/[^0-9]/g, '');
  const isDigits = /^\d+$/.test(c);

  if (/ABN/.test(lab) || (isDigits && c.length === 11 && /^\d{2} \d{3} \d{3} \d{3}$/.test(printed))) {
    if (isDigits && c.length === 11) return { value: `${c.slice(0, 2)} ${c.slice(2, 5)} ${c.slice(5, 8)} ${c.slice(8)}`, type: 'ABN', country: 'AU', valid: abnValid(c) };
  }
  if (isDigits && c.length === 15) {
    if (/^3\d{13}3$/.test(c) && !/TRN/.test(lab)) return { value: c, type: 'VAT', country: 'SA', valid: true };
    if (/^100\d{12}$/.test(c) || /TRN/.test(lab)) return { value: c, type: 'TRN', country: 'AE', valid: /^100\d{12}$/.test(c) };
  }
  if (/\bEIN\b|FEIN|FEDERAL TAX|TAX ID|TIN/.test(lab) && /^\d{2}-?\d{7}$/.test(printed.replace(/\s/g, ''))) {
    return { value: `${only.slice(0, 2)}-${only.slice(2)}`, type: 'EIN', country: 'US', valid: !EIN_BAD_PREFIX.has(only.slice(0, 2)) };
  }
  m = c.match(/^(\d{9})(RT\d{4})?$/);
  if (m && (/\bBN\b|BUSINESS NUMBER|GST|HST|QST/.test(lab) || m[2])) {
    return { value: m[2] ? `${m[1]} ${m[2]}` : m[1], type: 'BN', country: 'CA', valid: luhnValid(m[1]) };
  }
  if (/^\d{2}-\d{7}$/.test(printed.replace(/\s/g, ''))) {
    return { value: `${only.slice(0, 2)}-${only.slice(2)}`, type: 'EIN', country: 'US', valid: !EIN_BAD_PREFIX.has(only.slice(0, 2)) };
  }
  // Labelled VAT without a country prefix (e.g. "VAT No: 123 4567 89" on a UK invoice)
  if (isDigits && c.length === 9 && /VAT/.test(lab) && gbValid(c)) return { value: `GB${c}`, type: 'VAT', country: 'GB', valid: true };
  if (/^[0-9A-Z]{6,20}$/.test(c) && /\d{4}/.test(c)) return { value: printed.replace(/\s+/g, ' '), type: 'TAX_ID', country: null, valid: null };
  return null;
}

const LABEL_RE =
  /(VAT\s*(?:Reg(?:istration)?\.?\s*)?(?:No\.?|Number|ID|#)?|USt[.-]?\s*Id(?:Nr|\.?\s*Nr)?\.?|UID(?:-Nr\.?)?|N[°ºo]\.?\s*(?:de\s+)?TVA(?:\s+intracom(?:munautaire)?)?|TVA(?:\s+intracom(?:munautaire)?)?|NIF|CIF|NIPC|P\.?\s*IVA|Partita\s+IVA|BTW(?:-?nr\.?)?|Mwst[.-]?Nr\.?|GSTIN|GST\s*(?:Reg(?:istration)?\.?\s*)?(?:No\.?|Number|#)?|HST\s*(?:No\.?|#)?|ABN|TRN|FEIN|EIN|Federal\s+Tax\s+ID|Tax\s*(?:ID|No\.?|Number|Reg(?:istration)?\.?(?:\s*No\.?)?)|TIN|Business\s+Number|\bBN)\s*[.:#]?\s*/gi;

/** Group tokens after a label into one ID ("GB 123 4567 89" -> one candidate; stop at words). */
function takeCandidate(after) {
  const tokens = after.split(/[ \t]+/);
  const picked = [];
  for (const t of tokens) {
    if (!t) continue;
    const clean = t.replace(/[,;)]+$/, '');
    if (!picked.length) {
      if (!/^[A-Z0-9][A-Z0-9.\-/]*$/i.test(clean) || (/^[a-z]+$/i.test(clean) && clean.length > 3)) break;
    } else if (!/\d/.test(clean) && !/^(B\d{2}|RT\d{4}|MWST|TVA|IVA|MVA)$/i.test(clean)) break;
    picked.push(clean);
    if (/[,;)]$/.test(t) || picked.join('').length >= 22) break;
  }
  return picked.join(' ');
}

/**
 * Find tax IDs in text, in document order. Labelled IDs first, then unlabelled
 * EU VAT / GSTIN / Swiss UID patterns.
 */
export function findTaxIds(text) {
  const s = String(text || '');
  const found = [];
  const seen = new Set();
  const push = (r, index, label) => {
    if (!r || seen.has(r.value.replace(/[\s.-]/g, ''))) return;
    seen.add(r.value.replace(/[\s.-]/g, ''));
    found.push({ ...r, index, label: label.trim() });
  };
  for (const m of s.matchAll(LABEL_RE)) {
    const label = m[1];
    if (/^TIN$/i.test(label.trim()) && !/\bTIN\b/.test(s.slice(m.index, m.index + 4))) continue;
    const start = m.index + m[0].length;
    const line = s.slice(start, start + 40).split('\n')[0];
    const cand = takeCandidate(line);
    if (cand) push(classifyTaxId(cand, label), m.index, label);
  }
  const patterns = [
    /\b(?:ATU\d{8}|BE[01]\d{9}|DE\d{9}|FR[A-HJ-NP-Z0-9]{2}\d{9}|IT\d{11}|ES[A-Z0-9]\d{7}[A-Z0-9]|NL\d{9}B\d{2}|PL\d{10}|SE\d{12}|DK\d{8}|PT\d{9}|IE\d{7}[A-W][A-I]?|GB\d{9}(?:\d{3})?)\b/g,
    /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g,
    /\bCHE[-\s]?\d{3}\.?\d{3}\.?\d{3}\b/g,
  ];
  for (const re of patterns) for (const m of s.matchAll(re)) push(classifyTaxId(m[0]), m.index, '');
  return found.sort((a, b) => a.index - b.index);
}

/** IBANs printed on the document (bank details of the vendor). */
export function findIbans(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g)) {
    const compact = m[0].replace(/\s/g, '');
    if (compact.length < 15) continue;
    out.push({ value: compact.replace(/(.{4})/g, '$1 ').trim(), valid: ibanValid(compact), index: m.index });
  }
  return out;
}
