import { findAmounts, near, round2 } from './parse/numbers.js';

/**
 * Validation = the reason a finance team can trust the output.
 * Every invoice gets arithmetic checks (lines, subtotal, tax, total, balance), ID checksums,
 * date sanity and, for AI results on text PDFs, a grounding check: the totals the model
 * returned must actually be printed on the document (catches hallucinated / calculated values).
 *
 * status:  ok      -> safe to import automatically
 *          review  -> a human should look (math does not add up, checksum failed, duplicate...)
 *          failed  -> nothing usable (no total and no line items, unreadable PDF)
 */

const sum = (arr) => round2(arr.reduce((s, x) => s + (x || 0), 0));

function check(list, id, level, ok, message, extra = {}) {
  list.push({ id, level, ok: Boolean(ok), message, ...extra });
}

/** Amounts printed in the text, for grounding checks. */
export function amountIndex(text, decimal) {
  const set = new Set();
  for (const a of findAmounts(text || '', { decimal })) set.add(round2(Math.abs(a.value)));
  return set;
}

const compact = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function validateInvoice(inv, { source = 'ai', mode = 'text', text = '', decimal = null, today = new Date() } = {}) {
  const checks = [];
  const t = inv.totals;
  const lines = inv.lineItems;
  const credit = inv.documentType === 'credit_note';

  // --- required fields
  check(checks, 'required.total', 'error', t.total !== null || t.amountDue !== null, 'Invoice total found');
  check(checks, 'required.invoiceNumber', 'warning', inv.invoiceNumber, 'Invoice number found');
  check(checks, 'required.invoiceDate', 'warning', inv.invoiceDate, 'Invoice date found');
  check(checks, 'required.vendor', 'warning', inv.vendor.name, 'Vendor name found');
  check(checks, 'required.currency', 'warning', inv.currency, 'Currency detected');
  check(checks, 'required.lineItems', 'warning', lines.length > 0, 'Line items found');

  // --- line arithmetic: qty x price (- discount) = amount, net or gross
  const badLines = [];
  lines.forEach((l, i) => {
    if (l.quantity === null || l.unitPrice === null || l.amount === null) return;
    const net = round2(l.quantity * l.unitPrice - (l.discount || 0));
    const gross = l.taxRate ? round2(net * (1 + l.taxRate / 100)) : null;
    const tol = { abs: 0.02 + Math.abs(l.quantity) * 0.005, rel: 0.0005 }; // unit prices often hide a 3rd decimal
    if (!near(net, l.amount, tol) && !(gross !== null && near(gross, l.amount, tol)) && !near(-net, l.amount, tol)) badLines.push(i + 1);
  });
  if (lines.some((l) => l.quantity !== null && l.unitPrice !== null && l.amount !== null)) {
    check(checks, 'math.lineItems', 'warning', !badLines.length, badLines.length ? `Quantity x unit price does not match the amount on line(s) ${badLines.join(', ')}` : 'Every line: quantity x unit price = amount', badLines.length ? { lines: badLines } : {});
  }

  // --- lines vs subtotal / total
  const linesSum = lines.length ? sum(lines.map((l) => l.amount)) : null;
  if (linesSum !== null && lines.every((l) => l.amount !== null)) {
    const targets = [t.subtotal, t.total, t.subtotal !== null && t.discount ? round2(t.subtotal - t.discount) : null].filter((x) => x !== null);
    if (targets.length) {
      const sumTol = { abs: 0.01 * (lines.length + 1) }; // one cent of rounding per line
      const ok = targets.some((x) => near(linesSum, x, sumTol) || near(linesSum, -x, sumTol));
      check(checks, 'math.linesSum', 'error', ok, ok ? `Line items add up (${linesSum})` : `Line items add up to ${linesSum}, but the ${t.subtotal !== null ? `subtotal is ${t.subtotal}` : `total is ${t.total}`} (difference ${round2(linesSum - (t.subtotal ?? t.total))}) - a line may be missing or misread`, { expected: t.subtotal ?? t.total, actual: linesSum });
    }
  }

  // --- subtotal - discount + tax + shipping = total
  const net = t.subtotal ?? (linesSum !== null && lines.every((l) => l.amount !== null) ? linesSum : null);
  if (net !== null && t.total !== null && (t.tax !== null || t.subtotal !== null)) {
    const tax = t.tax || 0;
    const ship = t.shipping || 0;
    const disc = t.discount || 0;
    const variants = [net - disc + tax + ship, net + tax + ship, net - disc + tax, net + tax].map(round2);
    const totTol = { abs: 0.01 * (Math.max(inv.taxes.length, 1) + 2) };
    const ok = variants.some((v) => near(v, t.total, totTol) || near(-v, t.total, totTol));
    const expected = variants[0];
    check(checks, 'math.total', 'error', ok, ok ? 'Subtotal - discount + tax + shipping = total' : `Total printed ${t.total} but subtotal ${net}${disc ? ` - discount ${disc}` : ''} + tax ${tax}${ship ? ` + shipping ${ship}` : ''} = ${expected} (difference ${round2(t.total - expected)})`, {
      expected,
      actual: t.total,
    });
  }

  // --- tax breakdown
  if (inv.taxes.length && t.tax !== null) {
    const taxSum = sum(inv.taxes.map((x) => x.amount));
    check(checks, 'math.taxSum', 'warning', near(taxSum, t.tax, { abs: 0.03 }), near(taxSum, t.tax, { abs: 0.03 }) ? 'Tax lines add up to the tax total' : `Tax lines add up to ${taxSum} but tax total is ${t.tax}`);
  }
  const badRates = inv.taxes.filter((x) => x.rate !== null && x.base !== null && !near(round2((x.base * x.rate) / 100), x.amount, { abs: 0.05 }));
  if (inv.taxes.some((x) => x.rate !== null && x.base !== null)) {
    check(checks, 'math.taxRate', 'warning', !badRates.length, badRates.length ? `Tax amount does not match rate x base for: ${badRates.map((x) => x.label || `${x.rate}%`).join(', ')}` : 'Tax = rate x base');
  }
  if (t.total !== null && t.amountPaid !== null && t.amountDue !== null) {
    const ok = near(round2(t.total - t.amountPaid), t.amountDue);
    check(checks, 'math.amountDue', 'warning', ok, ok ? 'Total - paid = amount due' : `Total ${t.total} - paid ${t.amountPaid} != amount due ${t.amountDue}`);
  }
  if (credit && t.total !== null) check(checks, 'doc.creditNote', 'info', true, 'Credit note: amounts reduce what you owe this vendor');

  // --- dates
  if (inv.invoiceDate && inv.dueDate) {
    check(checks, 'dates.order', 'warning', inv.dueDate >= inv.invoiceDate, inv.dueDate >= inv.invoiceDate ? 'Due date is on/after invoice date' : `Due date ${inv.dueDate} is before invoice date ${inv.invoiceDate} (day/month swapped?)`);
  }
  if (inv.invoiceDate) {
    const ahead = (Date.parse(inv.invoiceDate) - today.getTime()) / 86_400_000;
    if (ahead > 3) check(checks, 'dates.future', 'warning', false, `Invoice date ${inv.invoiceDate} is in the future (day/month swapped or typo?)`);
    if (ahead < -730) check(checks, 'dates.old', 'info', false, `Invoice is more than 2 years old (${inv.invoiceDate})`);
  }

  // --- IDs
  for (const [who, party] of [
    ['vendor', inv.vendor],
    ['customer', inv.customer],
  ]) {
    if (party.taxId && party.taxIdValid === false) check(checks, `taxId.${who}`, 'warning', false, `${who === 'vendor' ? 'Vendor' : 'Customer'} ${party.taxIdType || 'tax ID'} ${party.taxId} fails its checksum/format - misread or wrong number`);
    else if (party.taxId && party.taxIdValid === true) check(checks, `taxId.${who}`, 'info', true, `${who === 'vendor' ? 'Vendor' : 'Customer'} ${party.taxIdType} checksum valid (${party.taxIdCountry})`);
  }
  const vatCurrency = inv.currency && inv.currency !== 'USD';
  if (!inv.vendor.taxId && (t.tax || 0) !== 0 && vatCurrency) {
    check(checks, 'taxId.vendorMissing', 'warning', false, 'Tax is charged but no supplier VAT/GST number was found - input tax may not be deductible');
  }
  if (inv.vendor.iban) check(checks, 'iban', 'warning', inv.vendor.ibanValid !== false, inv.vendor.ibanValid === false ? `IBAN ${inv.vendor.iban} fails the mod-97 check - do not pay before confirming` : 'IBAN checksum valid');
  if (/reverse[\s-]charge|steuerschuldnerschaft des leistungsempf|autoliquidation|inversión del sujeto pasivo|inversione contabile/i.test(text)) {
    check(checks, 'tax.reverseCharge', 'info', true, 'Reverse charge mentioned: the buyer accounts for VAT');
  }

  // --- grounding: AI totals must be printed on a text PDF
  if (source !== 'rules' && mode === 'text' && text) {
    const printed = amountIndex(text, decimal);
    const missing = [];
    for (const [k, v] of Object.entries({ total: t.total, subtotal: t.subtotal, tax: t.tax, amountDue: t.amountDue })) {
      if (v === null || v === 0) continue;
      if (!printed.has(round2(Math.abs(v)))) missing.push(`${k} ${v}`);
    }
    if (inv.taxes.length > 1 && t.tax !== null) {
      const idx = missing.findIndex((m) => m.startsWith('tax '));
      if (idx >= 0) missing.splice(idx, 1); // a summed tax total is fine when only the lines are printed
    }
    check(checks, 'grounding.totals', 'warning', !missing.length, missing.length ? `Not printed on the document (AI may have calculated or misread): ${missing.join(', ')}` : 'All totals are printed on the document');
    const ct = compact(text);
    if (inv.invoiceNumber && !ct.includes(compact(inv.invoiceNumber))) check(checks, 'grounding.invoiceNumber', 'warning', false, `Invoice number ${inv.invoiceNumber} is not in the document text`);
    if (inv.vendor.taxId && !ct.includes(compact(inv.vendor.taxId)) && !ct.includes(compact(inv.vendor.taxId).replace(/^[A-Z]{2}/, ''))) {
      check(checks, 'grounding.vendorTaxId', 'warning', false, `Vendor tax ID ${inv.vendor.taxId} is not in the document text`);
    }
  }

  // --- score
  const failed = checks.filter((c) => !c.ok);
  const errors = failed.filter((c) => c.level === 'error').length;
  const warnings = failed.filter((c) => c.level === 'warning').length;
  let confidence = 100 - errors * 25 - warnings * 8 - (source === 'rules' ? 10 : 0) - (mode === 'vision' ? 5 : 0);
  confidence = Math.max(0, Math.min(100, confidence));
  const usable = t.total !== null || t.amountDue !== null || lines.length > 0;
  const status = !usable ? 'failed' : errors || confidence < 70 ? 'review' : 'ok';
  return { status, confidence, errors, warnings, checks };
}

/** Flag the same vendor + invoice number (or same file content) appearing twice in a batch. */
export function flagDuplicates(results) {
  const key = (r) => (r.invoice?.invoiceNumber ? `${compact(r.invoice.vendor?.taxId || r.invoice.vendor?.name)}|${compact(r.invoice.invoiceNumber)}` : null);
  const seen = new Map();
  for (const r of results) {
    if (!r.invoice) continue;
    const k = key(r);
    const keys = [k, `sha:${r.sha256}`].filter(Boolean);
    const first = keys.map((x) => seen.get(x)).find(Boolean);
    if (first) {
      const msg = `Possible duplicate of ${first.file} (${first.invoice.invoiceNumber || 'same file content'})`;
      r.validation.checks.push({ id: 'duplicate', level: 'error', ok: false, message: msg, duplicateOf: first.file });
      r.validation.errors++;
      r.validation.status = r.validation.status === 'failed' ? 'failed' : 'review';
      r.validation.confidence = Math.max(0, r.validation.confidence - 25);
    } else for (const x of keys) seen.set(x, r);
  }
  return results;
}
