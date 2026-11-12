import { DATE_PATTERN, detectCurrency, detectDecimalSeparator, findAmounts, guessDayFirst, parseDate, round2, near } from '../parse/numbers.js';
import { findIbans, findTaxIds } from '../parse/taxid.js';
import { emptyInvoice } from '../schema.js';

/**
 * Rule-based invoice extraction: no AI, no network, instant.
 * It is the last-resort fallback when every model is down, the "--no-ai" mode, and a second
 * opinion used to fill gaps the AI left and to cross-check its totals.
 * Multilingual labels: EN, DE, FR, ES, IT, NL.
 */

const TOTAL_LABELS = [
  ['amountDue', /\b(amount due|balance due|total due|amount payable|balance|zu zahlen(?:der betrag)?|zahlbetrag|offener betrag|reste à payer|net à payer|solde|importe a pagar|saldo|da pagare|te betalen)\b/i],
  ['amountPaid', /\b(amount paid|paid|payments? received|less payments?|deposit|bezahlt|anzahlung|déjà (?:payé|réglé)|acompte|pagado|anticipo)\b/i],
  ['subtotal', /\b(sub[\s-]?total|net (?:amount|total|value)|total net|total (?:excl|ex|before tax|hors taxes?)\.?|nettobetrag|netto(?:summe|betrag)?|summe netto|zwischensumme|gesamt netto|total h\.?t\.?|montant h\.?t\.?|base imponible|imponibile|taxable (?:value|amount)|totaal excl)\b/i],
  ['total', /\b(total (?:incl|inc|including|gross)\.?|total ttc|montant ttc|gesamt(?:betrag)? brutto|bruttobetrag|summe brutto|total con iva|totaal incl)\b/i],
  ['shipping', /\b(shipping(?: & handling)?|freight|delivery charges?|postage|versand(?:kosten)?|fracht|frais de (?:port|livraison)|gastos de envío|envío|spedizione|verzendkosten)\b/i],
  ['discount', /\b(discount|rabatt|nachlass|skonto|remise|descuento|sconto|korting)\b/i],
  ['tax', /\b(vat|tax|gst|hst|pst|qst|cgst|sgst|igst|utgst|mwst|ust|umsatzsteuer|mehrwertsteuer|tva|iva|btw|moms|sales tax)\b/i],
  ['total', /\b(grand total|total amount|invoice total|amount total|total|gesamt(?:betrag|summe)?|rechnungsbetrag|endbetrag|summe|montant total|importe total|totale|totaal)\b/i],
];
const TAX_ID_LABEL = /\b(vat|tax|gst|tva|iva|btw)\s*(reg|registration|no|number|id|#|nr|intra)|ust-?id|uid|gstin|steuernummer|tax id|ein\b|abn\b|trn\b/i;
const HEADER_WORDS =
  /\b(description|item|items|product|service|services|article|details|bezeichnung|beschreibung|artikel|leistung|désignation|description|libellé|descripción|concepto|descrizione|omschrijving|qty|quantity|menge|anzahl|qté|quantité|cantidad|quantità|aantal|unit price|price|rate|preis|einzelpreis|prix|precio|prezzo|prijs|amount|total|betrag|gesamt|montant|importe|importo|bedrag|vat|tax|mwst|ust|tva|iva)\b/gi;
const UNITS = /^(pcs?|pc\.|pieces?|units?|ea|each|hrs?|hours?|h|std|stk|stück|st|days?|tage?|jours?|kg|g|m|m2|m²|l|lbs?|x|months?|mo|licen[cs]es?|seats?|users?)\.?$/i;
const DATE_RE = new RegExp(DATE_PATTERN, 'gi');

const lineWithoutNoise = (line) =>
  line
    .replace(DATE_RE, ' ')
    .replace(/\d+(?:[.,]\d+)?\s?%/g, ' ')
    .replace(/\b[A-Za-z]+[-/#]?\d[\w\-/]*/g, ' ') // INV-2026-01, SKU123, DE123456789
    .replace(/\+?\(?\d{2,4}\)?[\s-]\d{3,4}[\s-]\d{3,5}\b/g, ' '); // phone-like

function amountsOf(line, decimal) {
  return findAmounts(lineWithoutNoise(line), { decimal }).filter((a) => !/^\d{4}$/.test(a.raw) || a.raw.includes('.'));
}

function percentOf(line) {
  const m = line.match(/(\d{1,2}(?:[.,]\d{1,4})?)\s?%/);
  return m ? Number(m[1].replace(',', '.')) : null;
}

function classifyTotalLine(line) {
  if (TAX_ID_LABEL.test(line)) return null;
  for (const [key, re] of TOTAL_LABELS) if (re.test(line)) return key;
  return null;
}

function detectLanguage(text) {
  const t = text.toLowerCase();
  const score = {
    en: (t.match(/\b(invoice|total|amount|due|quantity|price|bill to|subtotal)\b/g) || []).length,
    de: (t.match(/\b(rechnung|betrag|mwst|ust|datum|menge|preis|gesamt|netto|brutto|zahlbar)\b/g) || []).length,
    fr: (t.match(/\b(facture|montant|tva|date|quantité|prix|ttc|ht|échéance)\b/g) || []).length,
    es: (t.match(/\b(factura|importe|iva|fecha|cantidad|precio|vencimiento)\b/g) || []).length,
    it: (t.match(/\b(fattura|importo|iva|data|quantità|prezzo|totale|scadenza)\b/g) || []).length,
    nl: (t.match(/\b(factuur|bedrag|btw|datum|aantal|prijs|totaal)\b/g) || []).length,
  };
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : null;
}

function findLabeledDate(lines, labelRe, { skip, dayFirst }) {
  const re = new RegExp(`(?:${labelRe.source})\\s*[:.]?\\s*(${DATE_PATTERN})`, 'i');
  for (const [i, line] of lines.entries()) {
    if (skip && skip.test(line)) continue;
    const m = line.match(re);
    if (m) return parseDate(m.at(-1), { dayFirst });
    if (labelRe.test(line) && !new RegExp(DATE_PATTERN, 'i').test(line) && lines[i + 1]) {
      const n = lines[i + 1].match(new RegExp(`^\\s*(${DATE_PATTERN})`, 'i'));
      if (n) return parseDate(n[1], { dayFirst });
    }
  }
  return null;
}

/** Parse the trailing numbers of a table row into quantity / unit price / amount. */
export function parseItemRow(line, decimal) {
  let body = line.replace(/^\s*\d{1,3}[.)]?\s+(?=\D)/, ''); // leading position number
  const taxRate = percentOf(body);
  const tokens = body.split(/\s+/);
  const nums = [];
  let unit = null;
  let cut = tokens.length;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (/^[-−(]?[€$£¥₹]?\d[\d.,']*[-)]?$|^\d+(?:[.,]\d+)?%$|^[A-Z]{3}$|^[€$£₹]$/.test(t) && !(i === 0)) {
      if (!/%$/.test(t) && !/^[A-Z]{3}$|^[€$£₹]$/.test(t)) {
        const a = findAmounts(t, { decimal })[0];
        if (a) nums.unshift(a.value);
      }
      cut = i;
      continue;
    }
    if (UNITS.test(t) && nums.length) {
      unit = unit || t.replace(/\.$/, '');
      cut = i;
      continue;
    }
    break;
  }
  const description = tokens.slice(0, cut).join(' ').trim();
  if (!description || !/[A-Za-zÀ-ÿ]{2}/.test(description) || !nums.length) return null;

  const item = { description, sku: null, quantity: null, unit, unitPrice: null, discount: null, taxRate, amount: nums.at(-1) };
  const skuMatch = description.match(/^([A-Z0-9]+(?:[-_/.][A-Z0-9]+)*)\s+(.+)$/);
  if (skuMatch && (/\d/.test(skuMatch[1]) || (/^[A-Z]+(?:-[A-Z]+)+$/.test(skuMatch[1]) && skuMatch[1].length >= 6)))Object.assign(item, { sku: skuMatch[1], description: skuMatch[2] });

  if (nums.length >= 3) {
    // Try the usual layouts: qty price amount | qty price disc amount | price qty amount
    const [a, b] = nums;
    const amount = nums.at(-1);
    if (near(round2(a * b), amount)) Object.assign(item, { quantity: a, unitPrice: b });
    else if (near(round2(a * nums.at(-2)), amount)) Object.assign(item, { quantity: a, unitPrice: nums.at(-2) });
    else if (nums.length >= 4 && near(round2(a * b - nums[2]), amount)) Object.assign(item, { quantity: a, unitPrice: b, discount: nums[2] });
    else if (taxRate !== null && near(round2(a * b * (1 + taxRate / 100)), amount)) Object.assign(item, { quantity: a, unitPrice: b });
    else Object.assign(item, { quantity: a, unitPrice: b });
  } else if (nums.length === 2) {
    const [a, amount] = nums;
    if (near(a, amount)) Object.assign(item, { quantity: 1, unitPrice: a });
    else if (Number.isInteger(a) && a > 0 && a <= 10000 && Math.abs(amount) >= a) Object.assign(item, { quantity: a, unitPrice: round2(amount / a) });
    else item.unitPrice = a;
  }
  return item;
}

/**
 * @param {string} text   full document text (pages joined with \n)
 * @returns {{ invoice: object, meta: { decimal, dayFirst } }}
 */
export function extractWithRules(text) {
  const inv = emptyInvoice();
  const src = String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  const lines = src.split('\n').map((l) => l.trim()).filter(Boolean);
  const decimal = detectDecimalSeparator(src);
  inv.currency = detectCurrency(src);
  const dayFirst = guessDayFirst({ currency: inv.currency, text: src });
  inv.language = detectLanguage(src);

  const head = lines.slice(0, 15).join(' ');
  if (/\b(credit note|credit memo|gutschrift|avoir|nota de cr[ée]dito|nota di credito|creditnota)\b/i.test(head)) inv.documentType = 'credit_note';
  else if (/\bpro[\s-]?forma\b/i.test(head)) inv.documentType = 'proforma';
  else if (/\b(receipt|quittung|reçu|recibo|ricevuta)\b/i.test(head) && !/\binvoice\b/i.test(head)) inv.documentType = 'receipt';
  else if (/^(quote|quotation|angebot|devis|presupuesto|offerte)\b/i.test(lines[0] || '')) inv.documentType = 'quote';

  // --- invoice number
  const numRe =
    /(?:(?:tax\s+)?invoice|inv|rechnung|facture|factura|fattura|factuur|bill|receipt|credit note|gutschrift|avoir)[\s-]*(?:no\.?|number|num(?:ber|éro|ero)?\.?|nr\.?|nummer|#|n[°º]\.?)\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-/_.]*\d[A-Z0-9\-/_]*)|(?:rechnungsnummer|rechnungs-nr\.?|belegnummer|invoice\s*:)\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-/_.]*\d[A-Z0-9\-/_]*)/i;
  for (const [i, line] of lines.entries()) {
    const m = line.match(numRe);
    if (m) {
      inv.invoiceNumber = (m[1] || m[2]).replace(/[.,]$/, '');
      break;
    }
    if (/^(invoice|rechnung|facture|factura) (no\.?|number|nr\.?|#)\s*:?$/i.test(line) && lines[i + 1]?.match(/^[A-Z0-9][\w\-/]*\d/)) {
      inv.invoiceNumber = lines[i + 1].split(' ')[0];
      break;
    }
  }

  // --- dates
  const DUE = /(due date|payment due|due on|due by|pay by|fällig(?:keit)?(?:sdatum)?(?: am)?|zahlbar bis|zahlungsziel|date d'échéance|échéance|fecha de vencimiento|vencimiento|scadenza|vervaldatum)/i;
  inv.dueDate = findLabeledDate(lines, DUE, { dayFirst });
  inv.invoiceDate =
    findLabeledDate(
      lines,
      /(invoice date|date of issue|issue date|issued on|issued|tax point|rechnungsdatum|belegdatum|datum|date de (?:la )?facture|date d'émission|fecha de emisión|fecha de factura|fecha|data fattura|data|factuurdatum|date)/i,
      { skip: DUE, dayFirst },
    ) || (src.match(DATE_RE) ? parseDate(src.match(DATE_RE)[0], { dayFirst }) : null);

  const po = src.match(/(?:P\.?O\.?\s*(?:number|no\.?|#)?|purchase order(?: no\.?| number)?|bestellnummer|bestell-nr\.?|ihre bestellung|bon de commande|your order(?: no\.?)?|order (?:no\.?|number|#))\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-/]*\d[A-Z0-9\-/]*)/i);
  if (po) inv.poNumber = po[1];
  const terms = src.match(/(?:payment terms?|terms|zahlungsbedingungen|conditions de paiement|condiciones de pago)\s*[:.]?\s*([^\n]{3,60})/i) || src.match(/\b(net\s?\d{1,3}(?: days)?|due on receipt|\d{1,3} (?:days|tage|jours|días) (?:net|netto)?)\b/i);
  if (terms) inv.paymentTerms = terms[1].trim();

  // --- parties
  const billIdx = lines.findIndex((l) => /^(bill(?:ed)? to|invoice to|sold to|customer|client|kunde|rechnungsempfänger|rechnungsadresse|an:|factur[ée] à|adresse de facturation|facturar a|cliente|ship to)\b/i.test(l));
  const customerLines = new Set();
  if (billIdx >= 0) {
    const label = lines[billIdx].match(/^(bill(?:ed)? to|invoice to|sold to|customer|client|kunde|rechnungsempfänger|rechnungsadresse|an:|factur[ée] à|adresse de facturation|facturar a|cliente|ship to)\s*:?\s*/i);
    const rest = lines[billIdx].slice(label[0].length).trim();
    const block = [];
    if (rest && /[A-Za-z]{2}/.test(rest)) block.push(rest);
    for (let j = billIdx + 1; j < Math.min(lines.length, billIdx + 6) && block.length < 4; j++) {
      if (HEADER_WORDS.test(lines[j]) && (lines[j].match(HEADER_WORDS) || []).length >= 2) break;
      HEADER_WORDS.lastIndex = 0;
      block.push(lines[j]);
    }
    HEADER_WORDS.lastIndex = 0;
    for (let j = billIdx; j <= billIdx + block.length; j++) customerLines.add(j);
    const blockClean = block.filter((l) => !/@|^(vat|tax|ust|tva|gstin|abn)/i.test(l) && !new RegExp(DATE_PATTERN, 'i').test(l));
    inv.customer.name = blockClean[0]?.replace(/\s{2,}.*/, '') || null;
    inv.customer.address = blockClean.slice(1, 3).join(', ') || null;
    const email = block.join(' ').match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (email) inv.customer.email = email[0].toLowerCase();
  }

  const titleWord = /\b(tax invoice|invoice|rechnung|facture|factura|fattura|factuur|credit note|gutschrift|receipt|pro[\s-]?forma)\b/gi;
  const companyRe = /\b(GmbH|AG|Ltd\.?|Limited|LLC|L\.L\.C\.|Inc\.?|Corp\.?|Co\.|S\.?A\.?S?|SARL|SRL|S\.?r\.?l\.?|B\.?V\.?|N\.?V\.?|Pty|Pvt\.?|PLC|LLP|KG|OHG|e\.K\.|S\.L\.|FZ-?LLC|FZE)\b/;
  const candidates = lines
    .slice(0, 12)
    .map((l, i) => ({ i, l: l.replace(titleWord, '').replace(/\s{2,}/g, ' ').trim() }))
    .filter(({ i, l }) => !customerLines.has(i) && l.length >= 3 && /[A-Za-zÀ-ÿ]{3}/.test(l) && !/[:@]|^(date|no\.?|page|www\.)/i.test(l) && !new RegExp(DATE_PATTERN, 'i').test(l));
  const vendorLine = candidates.find((c) => companyRe.test(c.l)) || candidates[0];
  if (vendorLine) inv.vendor.name = vendorLine.l.replace(/\s+(No\.?|#).*$/i, '').trim();
  if (vendorLine) {
    const addr = [];
    for (let j = vendorLine.i + 1; j < Math.min(lines.length, vendorLine.i + 4); j++) {
      if (customerLines.has(j) || /[:@]|invoice|rechnung|facture/i.test(lines[j])) break;
      addr.push(lines[j].replace(titleWord, '').trim());
    }
    if (addr.length) inv.vendor.address = addr.filter(Boolean).join(', ') || null;
  }

  const emails = [...src.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+\w/g)].map((m) => m[0].toLowerCase());
  inv.vendor.email = emails.find((e) => e !== inv.customer.email) || null;
  const phone = src.match(/(?:tel|phone|telefon|tél|ph|fon)\.?\s*[:.]?\s*(\+?\d[\d\s()/.-]{6,}\d)/i);
  if (phone) inv.vendor.phone = phone[1].trim();
  const web = src.match(/\b(?:https?:\/\/)?www\.[a-z0-9-]+(?:\.[a-z]{2,})+\b/i);
  if (web) inv.vendor.website = web[0];
  const iban = findIbans(src)[0];
  if (iban) inv.vendor.iban = iban.value;

  // Tax IDs: inside the bill-to block -> customer, otherwise the first one is the vendor's.
  const lineStart = [];
  {
    let pos = 0;
    for (const l of src.split('\n')) {
      lineStart.push(pos);
      pos += l.length + 1;
    }
  }
  const rawLines = src.split('\n').map((l) => l.trim());
  const custText = [...customerLines].map((i) => lines[i]).join('\n');
  for (const id of findTaxIds(src)) {
    const rawLineIdx = lineStart.findLastIndex((p) => p <= id.index);
    const inCustomer = custText && rawLines[rawLineIdx] && custText.includes(rawLines[rawLineIdx]);
    if (inCustomer && !inv.customer.taxId) inv.customer.taxId = id.value;
    else if (!inCustomer && !inv.vendor.taxId) inv.vendor.taxId = id.value;
  }

  // --- totals
  const taxes = [];
  const seenTotals = {};
  const firstTotalIdx = lines.findIndex((l) => {
    const k = classifyTotalLine(l);
    return (k === 'subtotal' || k === 'total') && amountsOf(l, decimal).length > 0 && amountsOf(l, decimal).length <= 2;
  });
  for (const [i, line] of lines.entries()) {
    const key = classifyTotalLine(line);
    if (!key) continue;
    let amts = amountsOf(line, decimal);
    if (!amts.length && lines[i + 1] && /^[-−(]?\s?[€$£₹]?\s?\d[\d.,\s']*\)?\s?[A-Z€$£]{0,3}$/.test(lines[i + 1])) amts = amountsOf(lines[i + 1], decimal);
    if (!amts.length || amts.length > 3) continue;
    if (key !== 'tax' && firstTotalIdx >= 0 && i < firstTotalIdx && key !== 'amountDue') continue; // line-item rows like "Shipping 1 15.00"
    const value = amts.at(-1).value;
    if (key === 'tax') {
      if (/\b(total|summe|gesamt)\b/i.test(line) && taxes.length) {
        seenTotals.taxTotal = value;
        continue;
      }
      taxes.push({ label: line.replace(/[-−(]?[€$£₹]?\s?\d[\d.,\s']*\)?\s*[A-Z€$£]{0,3}\s*$/, '').trim().slice(0, 40) || 'Tax', rate: percentOf(line), base: amts.length >= 2 ? amts[0].value : null, amount: value });
      continue;
    }
    if (key === 'total') {
      if (seenTotals.total === undefined || Math.abs(value) > Math.abs(seenTotals.total)) seenTotals.total = value;
      continue;
    }
    if (seenTotals[key] === undefined) seenTotals[key] = value;
  }
  inv.taxes = taxes;
  inv.totals.subtotal = seenTotals.subtotal ?? null;
  inv.totals.discount = seenTotals.discount !== undefined ? Math.abs(seenTotals.discount) : null;
  inv.totals.shipping = seenTotals.shipping ?? null;
  inv.totals.amountPaid = seenTotals.amountPaid !== undefined ? Math.abs(seenTotals.amountPaid) : null;
  inv.totals.amountDue = seenTotals.amountDue ?? null;
  inv.totals.tax = seenTotals.taxTotal ?? (taxes.length ? round2(taxes.reduce((s, t) => s + t.amount, 0)) : null);
  inv.totals.total = seenTotals.total ?? null;
  if (inv.totals.total === null && inv.totals.amountDue !== null && !inv.totals.amountPaid) inv.totals.total = inv.totals.amountDue;

  // --- line items: rows between the table header and the first totals line
  const headerIdx = lines.findIndex((l) => {
    const hits = new Set((l.match(HEADER_WORDS) || []).map((w) => w.toLowerCase()));
    return hits.size >= 2 && amountsOf(l, decimal).length === 0;
  });
  if (headerIdx >= 0) {
    const end = firstTotalIdx > headerIdx ? firstTotalIdx : lines.length;
    for (let i = headerIdx + 1; i < end; i++) {
      const line = lines[i];
      if (/^(page|seite|continued|carried forward|übertrag)\b|\b(page|seite|página|pagina)\s+\d+(\s*(of|von|de|sur|\/)\s*\d+)?\s*$/i.test(line)) continue;
      const hits = new Set((line.match(HEADER_WORDS) || []).map((w) => w.toLowerCase()));
      if (hits.size >= 3 && amountsOf(line, decimal).length === 0) continue; // repeated header on page 2
      const item = parseItemRow(line, decimal);
      if (item) inv.lineItems.push(item);
      else if (inv.lineItems.length && /[A-Za-zÀ-ÿ]{3}/.test(line) && !amountsOf(line, decimal).length && !classifyTotalLine(line)) {
        inv.lineItems.at(-1).description += ` ${line}`; // wrapped description
      }
    }
  }

  return { invoice: inv, meta: { decimal, dayFirst } };
}
