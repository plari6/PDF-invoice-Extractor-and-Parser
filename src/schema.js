import { parseAmount, parseDate, round2, ISO_CURRENCIES } from './parse/numbers.js';
import { classifyTaxId, ibanValid } from './parse/taxid.js';

/** Bump when the AI prompt or schema changes: it is part of the cache key. */
export const SCHEMA_VERSION = 3;

export const DOCUMENT_TYPES = ['invoice', 'credit_note', 'proforma', 'receipt', 'purchase_order', 'quote', 'other'];

/** JSON shape the model is asked to fill (also printed by `invoice-extractor schema`). */
export const AI_SHAPE = {
  documentType: 'invoice | credit_note | proforma | receipt | purchase_order | quote | other',
  invoiceNumber: 'string | null',
  invoiceDate: 'YYYY-MM-DD | null',
  dueDate: 'YYYY-MM-DD | null',
  poNumber: 'string | null',
  currency: 'ISO 4217 code, e.g. EUR | null',
  paymentTerms: 'string | null',
  language: 'ISO 639-1 code of the document, e.g. en | null',
  vendor: { name: 'string', address: 'string | null', taxId: 'string | null (exactly as printed)', email: 'string | null', phone: 'string | null', iban: 'string | null', website: 'string | null' },
  customer: { name: 'string | null', address: 'string | null', taxId: 'string | null', email: 'string | null' },
  lineItems: [
    {
      description: 'string',
      sku: 'string | null',
      quantity: 'number | null',
      unit: 'string | null',
      unitPrice: 'number | null',
      discount: 'number | null (money, not %)',
      taxRate: 'number | null (percent, 20 not 0.2)',
      amount: 'number | null (line total as printed)',
    },
  ],
  taxes: [{ label: 'string e.g. VAT 20% / CGST 9%', rate: 'number | null', base: 'number | null', amount: 'number' }],
  totals: {
    subtotal: 'number | null (net, before tax)',
    discount: 'number | null (document-level, positive number)',
    tax: 'number | null (total tax)',
    shipping: 'number | null',
    total: 'number | null (gross invoice total)',
    amountPaid: 'number | null',
    amountDue: 'number | null',
  },
  notes: 'string | null (short: payment instructions, reverse charge mention...)',
};

const str = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s && !/^(null|n\/a|none|undefined|-)$/i.test(s) ? s : null;
};

export function emptyInvoice() {
  return {
    documentType: 'invoice',
    invoiceNumber: null,
    invoiceDate: null,
    dueDate: null,
    poNumber: null,
    currency: null,
    paymentTerms: null,
    language: null,
    vendor: { name: null, address: null, taxId: null, email: null, phone: null, iban: null, website: null },
    customer: { name: null, address: null, taxId: null, email: null },
    lineItems: [],
    taxes: [],
    totals: { subtotal: null, discount: null, tax: null, shipping: null, total: null, amountPaid: null, amountDue: null },
    notes: null,
  };
}

/**
 * Coerce any loosely shaped invoice (AI JSON, rules output, hand-edited JSON) into the canonical
 * shape: numbers as Numbers (messy strings parsed), dates ISO, currency ISO, tax IDs classified.
 */
export function normalizeInvoice(raw, { decimal = null, dayFirst = true } = {}) {
  const inv = emptyInvoice();
  if (!raw || typeof raw !== 'object') return inv;
  const num = (v) => {
    const n = parseAmount(v, { decimal });
    return n === null ? null : round2(n) === n ? n : Math.round(n * 10000) / 10000;
  };
  const date = (v) => (v ? parseDate(v, { dayFirst }) : null);
  const pick = (o, ...keys) => {
    for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
    return null;
  };

  const type = str(pick(raw, 'documentType', 'document_type', 'type'))?.toLowerCase().replace(/[\s-]+/g, '_');
  inv.documentType = DOCUMENT_TYPES.includes(type) ? type : type ? 'other' : 'invoice';
  inv.invoiceNumber = str(pick(raw, 'invoiceNumber', 'invoice_number', 'number'));
  inv.invoiceDate = date(pick(raw, 'invoiceDate', 'invoice_date', 'date', 'issueDate'));
  inv.dueDate = date(pick(raw, 'dueDate', 'due_date'));
  inv.poNumber = str(pick(raw, 'poNumber', 'po_number', 'purchaseOrder'));
  const cur = str(pick(raw, 'currency'))?.toUpperCase();
  inv.currency = cur && ISO_CURRENCIES.has(cur) ? cur : cur === '€' ? 'EUR' : cur === '£' ? 'GBP' : cur === '$' ? 'USD' : null;
  inv.paymentTerms = str(pick(raw, 'paymentTerms', 'payment_terms'));
  inv.language = str(pick(raw, 'language'))?.toLowerCase().slice(0, 2) || null;
  inv.notes = str(pick(raw, 'notes'));

  const v = raw.vendor || raw.seller || raw.supplier || {};
  inv.vendor = {
    name: str(pick(v, 'name')),
    address: str(pick(v, 'address')),
    taxId: str(pick(v, 'taxId', 'tax_id', 'vatNumber', 'vat')),
    email: str(pick(v, 'email'))?.toLowerCase() || null,
    phone: str(pick(v, 'phone')),
    iban: str(pick(v, 'iban'))?.toUpperCase().replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim() || null,
    website: str(pick(v, 'website')),
  };
  const c = raw.customer || raw.buyer || raw.billTo || {};
  inv.customer = {
    name: str(pick(c, 'name')),
    address: str(pick(c, 'address')),
    taxId: str(pick(c, 'taxId', 'tax_id', 'vatNumber', 'vat')),
    email: str(pick(c, 'email'))?.toLowerCase() || null,
  };

  const items = Array.isArray(raw.lineItems) ? raw.lineItems : Array.isArray(raw.line_items) ? raw.line_items : [];
  inv.lineItems = items
    .filter((it) => it && typeof it === 'object')
    .map((it) => {
      let rate = num(pick(it, 'taxRate', 'tax_rate', 'vatRate'));
      if (rate !== null && rate > 0 && rate < 1) rate = round2(rate * 100); // 0.2 -> 20
      return {
        description: str(pick(it, 'description', 'name', 'item')) || '',
        sku: str(pick(it, 'sku', 'code', 'itemCode')),
        quantity: num(pick(it, 'quantity', 'qty')),
        unit: str(pick(it, 'unit', 'uom')),
        unitPrice: num(pick(it, 'unitPrice', 'unit_price', 'price', 'rate')),
        discount: num(pick(it, 'discount')),
        taxRate: rate,
        amount: num(pick(it, 'amount', 'total', 'lineTotal', 'net')),
      };
    })
    .filter((it) => it.description || it.amount !== null);

  const taxes = Array.isArray(raw.taxes) ? raw.taxes : Array.isArray(raw.tax_breakdown) ? raw.tax_breakdown : [];
  inv.taxes = taxes
    .filter((t) => t && typeof t === 'object')
    .map((t) => {
      let rate = num(pick(t, 'rate'));
      if (rate !== null && rate > 0 && rate < 1) rate = round2(rate * 100);
      return { label: str(pick(t, 'label', 'name')), rate, base: num(pick(t, 'base', 'taxable')), amount: num(pick(t, 'amount', 'tax')) };
    })
    .filter((t) => t.amount !== null);

  const t = raw.totals || {};
  inv.totals = {
    subtotal: num(pick(t, 'subtotal', 'net', 'netTotal')),
    discount: num(pick(t, 'discount')),
    tax: num(pick(t, 'tax', 'taxTotal', 'tax_total', 'vat')),
    shipping: num(pick(t, 'shipping', 'freight')),
    total: num(pick(t, 'total', 'grandTotal', 'gross')),
    amountPaid: num(pick(t, 'amountPaid', 'amount_paid', 'paid')),
    amountDue: num(pick(t, 'amountDue', 'amount_due', 'balanceDue')),
  };
  if (inv.totals.discount !== null) inv.totals.discount = Math.abs(inv.totals.discount);
  return inv;
}

/** Add tax-ID / IBAN metadata (type, country, checksum) next to the raw values. */
export function enrichIds(inv) {
  for (const party of [inv.vendor, inv.customer]) {
    if (!party.taxId) continue;
    const r = classifyTaxId(party.taxId, /^\s*(\d{2}-\d{7})\s*$/.test(party.taxId) ? 'EIN' : 'VAT');
    party.taxIdType = r?.type || 'TAX_ID';
    party.taxIdCountry = r?.country || null;
    party.taxIdValid = r ? r.valid : null;
    if (r && r.type !== 'TAX_ID') party.taxIdNormalized = r.value;
  }
  if (inv.vendor.iban) inv.vendor.ibanValid = ibanValid(inv.vendor.iban);
  return inv;
}
