import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarize } from '../pipeline.js';

/**
 * Exports:
 *   json        invoices.json (all results + summary) and json/<file>.json per invoice
 *   xlsx        invoices.xlsx: Summary, Invoices, Line Items, Taxes, Checks (filters, frozen headers, colours)
 *   csv         invoices.csv + line-items.csv (UTF-8 BOM so Excel opens accents correctly)
 *   xero        xero-bills.csv      (Xero > Bills to pay > Import)
 *   quickbooks  quickbooks-bills.csv (QuickBooks Online > Import data > Bills)
 * Accounting files only contain invoices whose status is in `accountingStatuses` (default: ok),
 * so nothing unverified lands in the books.
 */

export const FORMATS = ['json', 'xlsx', 'csv', 'xero', 'quickbooks'];

const failedChecks = (r) => (r.validation?.checks || []).filter((c) => !c.ok && c.level !== 'info');
const issues = (r) => failedChecks(r).map((c) => c.message).join(' | ');
const safeName = (f) => basename(f, extname(f)).replace(/[^\w.-]+/g, '_');

function fmtDate(iso, pattern) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return pattern.replace('YYYY', y).replace('MM', m).replace('DD', d);
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [columns.map((c) => esc(c.header)).join(','), ...rows.map((r) => columns.map((c) => esc(c.value(r))).join(','))].join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------- row builders */

export function invoiceRows(results) {
  return results.map((r) => {
    const i = r.invoice || {};
    const t = i.totals || {};
    const v = i.vendor || {};
    const c = i.customer || {};
    return {
      file: r.file,
      path: r.path,
      status: r.validation?.status,
      confidence: r.validation?.confidence,
      documentType: i.documentType,
      invoiceNumber: i.invoiceNumber,
      invoiceDate: i.invoiceDate,
      dueDate: i.dueDate,
      vendor: v.name,
      vendorTaxId: v.taxId,
      vendorTaxIdType: v.taxIdType,
      vendorTaxIdValid: v.taxIdValid === undefined || v.taxIdValid === null ? '' : v.taxIdValid ? 'yes' : 'NO',
      vendorEmail: v.email,
      vendorIban: v.iban,
      customer: c.name,
      customerTaxId: c.taxId,
      currency: i.currency,
      subtotal: t.subtotal,
      discount: t.discount,
      tax: t.tax,
      shipping: t.shipping,
      total: t.total,
      amountPaid: t.amountPaid,
      amountDue: t.amountDue,
      poNumber: i.poNumber,
      paymentTerms: i.paymentTerms,
      lineCount: i.lineItems?.length ?? 0,
      pages: r.pages,
      source: r.source,
      mode: r.mode,
      model: r.model,
      issues: r.error || issues(r),
    };
  });
}

export function lineRows(results) {
  const out = [];
  for (const r of results) {
    const i = r.invoice;
    if (!i) continue;
    const bad = new Set(r.validation?.checks?.find((c) => c.id === 'math.lineItems')?.lines || []);
    i.lineItems.forEach((l, idx) =>
      out.push({ file: r.file, invoiceNumber: i.invoiceNumber, invoiceDate: i.invoiceDate, vendor: i.vendor.name, currency: i.currency, line: idx + 1, ...l, lineCheck: bad.has(idx + 1) ? 'MISMATCH' : 'ok', status: r.validation.status }),
    );
  }
  return out;
}

const INVOICE_COLUMNS = [
  ['File', 'file', 28],
  ['Status', 'status', 9],
  ['Confidence', 'confidence', 11],
  ['Type', 'documentType', 11],
  ['Invoice No', 'invoiceNumber', 18],
  ['Invoice Date', 'invoiceDate', 12],
  ['Due Date', 'dueDate', 12],
  ['Vendor', 'vendor', 30],
  ['Vendor Tax ID', 'vendorTaxId', 20],
  ['ID Type', 'vendorTaxIdType', 8],
  ['ID Valid', 'vendorTaxIdValid', 8],
  ['Customer', 'customer', 28],
  ['Customer Tax ID', 'customerTaxId', 20],
  ['Currency', 'currency', 9],
  ['Subtotal', 'subtotal', 13, 'money'],
  ['Discount', 'discount', 11, 'money'],
  ['Tax', 'tax', 12, 'money'],
  ['Shipping', 'shipping', 11, 'money'],
  ['Total', 'total', 14, 'money'],
  ['Paid', 'amountPaid', 12, 'money'],
  ['Amount Due', 'amountDue', 14, 'money'],
  ['PO Number', 'poNumber', 14],
  ['Payment Terms', 'paymentTerms', 16],
  ['Vendor IBAN', 'vendorIban', 30],
  ['Vendor Email', 'vendorEmail', 26],
  ['Lines', 'lineCount', 7],
  ['Pages', 'pages', 7],
  ['Source', 'source', 9],
  ['Mode', 'mode', 8],
  ['AI Model', 'model', 26],
  ['Issues', 'issues', 80],
];
const LINE_COLUMNS = [
  ['File', 'file', 28],
  ['Invoice No', 'invoiceNumber', 18],
  ['Invoice Date', 'invoiceDate', 12],
  ['Vendor', 'vendor', 26],
  ['#', 'line', 5],
  ['SKU', 'sku', 14],
  ['Description', 'description', 50],
  ['Qty', 'quantity', 9, 'qty'],
  ['Unit', 'unit', 8],
  ['Unit Price', 'unitPrice', 13, 'money'],
  ['Discount', 'discount', 11, 'money'],
  ['Tax %', 'taxRate', 8, 'qty'],
  ['Amount', 'amount', 14, 'money'],
  ['Currency', 'currency', 9],
  ['Line Check', 'lineCheck', 11],
  ['Invoice Status', 'status', 13],
];

/* ------------------------------------------------------------- writers */

export async function writeJson(results, outDir) {
  const dir = join(outDir, 'json');
  await mkdir(dir, { recursive: true });
  for (const r of results) await writeFile(join(dir, `${safeName(r.file)}.json`), JSON.stringify(r, null, 2));
  const file = join(outDir, 'invoices.json');
  await writeFile(file, JSON.stringify({ generatedAt: new Date().toISOString(), summary: summarize(results), invoices: results }, null, 2));
  return [file, dir];
}

export async function writeCsv(results, outDir) {
  const inv = join(outDir, 'invoices.csv');
  const lines = join(outDir, 'line-items.csv');
  await writeFile(inv, toCsv(invoiceRows(results), INVOICE_COLUMNS.map(([header, key]) => ({ header, value: (r) => r[key] }))));
  await writeFile(lines, toCsv(lineRows(results), LINE_COLUMNS.map(([header, key]) => ({ header, value: (r) => r[key] }))));
  return [inv, lines];
}

function accountingLines(results, statuses) {
  const out = [];
  for (const r of results) {
    if (!r.invoice || !statuses.includes(r.validation.status)) continue;
    const i = r.invoice;
    const sign = i.documentType === 'credit_note' ? -1 : 1;
    const lines = i.lineItems.length
      ? [...i.lineItems] // copy: discount/shipping lines below must not leak into the result
      : [{ description: `Invoice ${i.invoiceNumber || r.file}`, quantity: 1, unitPrice: i.totals.subtotal ?? i.totals.total, amount: i.totals.subtotal ?? i.totals.total, taxRate: null }];
    // Document-level discount and shipping become their own lines so the imported bill
    // totals match the PDF.
    if (i.lineItems.length && i.totals.discount) lines.push({ description: 'Discount', quantity: 1, unitPrice: -i.totals.discount, amount: -i.totals.discount, taxRate: null });
    if (i.lineItems.length && i.totals.shipping) lines.push({ description: 'Shipping', quantity: 1, unitPrice: i.totals.shipping, amount: i.totals.shipping, taxRate: null });
    for (const l of lines) {
      const qty = l.quantity ?? 1;
      const unit = l.unitPrice ?? (l.amount !== null ? Math.round((l.amount / (qty || 1)) * 100) / 100 : null);
      out.push({ r, i, l, qty, unit: unit === null ? null : unit * (qty < 0 ? 1 : sign), amount: l.amount === null ? null : l.amount * sign });
    }
  }
  return out;
}

export async function writeXero(results, outDir, { statuses = ['ok'], env = process.env } = {}) {
  const fmt = env.XERO_DATE_FORMAT || 'DD/MM/YYYY';
  const cols = [
    ['*ContactName', (x) => x.i.vendor.name],
    ['EmailAddress', (x) => x.i.vendor.email],
    ['*InvoiceNumber', (x) => x.i.invoiceNumber],
    ['Reference', (x) => x.i.poNumber],
    ['*InvoiceDate', (x) => fmtDate(x.i.invoiceDate, fmt)],
    ['*DueDate', (x) => fmtDate(x.i.dueDate || x.i.invoiceDate, fmt)],
    ['InventoryItemCode', (x) => x.l.sku],
    ['*Description', (x) => x.l.description],
    ['*Quantity', (x) => x.qty],
    ['*UnitAmount', (x) => x.unit],
    ['Discount', (x) => x.l.discount],
    ['*AccountCode', () => env.XERO_ACCOUNT_CODE || '429'],
    ['*TaxType', (x) => (x.l.taxRate === 0 ? env.XERO_TAX_TYPE_ZERO || 'No VAT' : env.XERO_TAX_TYPE || 'Tax on Purchases')],
    ['Currency', (x) => x.i.currency],
  ];
  const file = join(outDir, 'xero-bills.csv');
  await writeFile(file, toCsv(accountingLines(results, statuses), cols.map(([header, value]) => ({ header, value }))));
  return [file];
}

export async function writeQuickBooks(results, outDir, { statuses = ['ok'], env = process.env } = {}) {
  const fmt = env.QB_DATE_FORMAT || 'MM/DD/YYYY';
  const cols = [
    ['Bill No', (x) => x.i.invoiceNumber],
    ['Supplier', (x) => x.i.vendor.name],
    ['Bill Date', (x) => fmtDate(x.i.invoiceDate, fmt)],
    ['Due Date', (x) => fmtDate(x.i.dueDate || x.i.invoiceDate, fmt)],
    ['Terms', (x) => x.i.paymentTerms],
    ['Memo', (x) => [x.i.poNumber && `PO ${x.i.poNumber}`, x.r.file].filter(Boolean).join(' / ')],
    ['Account', () => env.QB_ACCOUNT || 'Office Expenses'],
    ['Line Description', (x) => x.l.description],
    ['Line Amount', (x) => x.amount],
    ['Line Tax Code', (x) => (x.l.taxRate !== null && x.l.taxRate !== undefined ? `${x.l.taxRate}%` : '')],
    ['Currency', (x) => x.i.currency],
  ];
  const file = join(outDir, 'quickbooks-bills.csv');
  await writeFile(file, toCsv(accountingLines(results, statuses), cols.map(([header, value]) => ({ header, value }))));
  return [file];
}

const STATUS_FILL = { ok: 'FFC6EFCE', review: 'FFFFEB9C', failed: 'FFFFC7CE' };

export async function writeExcel(results, outDir) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'pdf-invoice-extractor';
  wb.created = new Date();
  const s = summarize(results);

  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 28 }, { width: 14 }, { width: 16 }, { width: 16 }, { width: 18 }];
  sum.addRow(['PDF Invoice Extraction Report']).font = { bold: true, size: 14 };
  sum.addRow([`Generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`]);
  sum.addRow([]);
  for (const [k, label] of [
    ['files', 'Files processed'],
    ['ok', 'OK (ready to import)'],
    ['review', 'Needs review'],
    ['failed', 'Failed'],
  ]) {
    const row = sum.addRow([label, s[k]]);
    if (STATUS_FILL[k]) row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL[k] } };
  }
  sum.addRow([]);
  const hdr = sum.addRow(['Currency', 'Invoices', 'Net', 'Tax', 'Gross total']);
  hdr.font = { bold: true };
  for (const [cur, b] of Object.entries(s.byCurrency)) {
    const row = sum.addRow([cur, b.invoices, b.net, b.tax, b.total]);
    for (const c of [3, 4, 5]) row.getCell(c).numFmt = '#,##0.00';
  }
  sum.addRow([]);
  sum.addRow(['Extraction source', 'Files']).font = { bold: true };
  for (const [k, n] of Object.entries(s.sources)) sum.addRow([k, n]);
  if (Object.keys(s.aiModels).length) {
    sum.addRow([]);
    sum.addRow(['AI model', 'Invoices']).font = { bold: true };
    for (const [k, n] of Object.entries(s.aiModels)) sum.addRow([k, n]);
  }

  const addTable = (name, columns, rows, { statusKey, linkKey } = {}) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns.map(([header, key, width]) => ({ header, key, width }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    for (const r of rows) {
      const row = ws.addRow(Object.fromEntries(columns.map(([, key]) => [key, r[key] ?? null])));
      columns.forEach(([, key, , kind], idx) => {
        const cell = row.getCell(idx + 1);
        if (kind === 'money') cell.numFmt = '#,##0.00';
        if (kind === 'qty') cell.numFmt = '#,##0.###';
        if (key === statusKey && STATUS_FILL[r[key]]) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL[r[key]] } };
        if (key === linkKey && r.path) cell.value = { text: r[key], hyperlink: pathToFileURL(r.path).href };
        if (key === 'lineCheck' && r[key] === 'MISMATCH') cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL.review } };
      });
    }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    return ws;
  };

  addTable('Invoices', INVOICE_COLUMNS, invoiceRows(results), { statusKey: 'status', linkKey: 'file' });
  addTable('Line Items', LINE_COLUMNS, lineRows(results), { statusKey: 'status' });
  const taxRows = [];
  for (const r of results) for (const t of r.invoice?.taxes || []) taxRows.push({ file: r.file, invoiceNumber: r.invoice.invoiceNumber, currency: r.invoice.currency, ...t });
  addTable(
    'Taxes',
    [
      ['File', 'file', 28],
      ['Invoice No', 'invoiceNumber', 18],
      ['Tax', 'label', 24],
      ['Rate %', 'rate', 8, 'qty'],
      ['Base', 'base', 14, 'money'],
      ['Amount', 'amount', 14, 'money'],
      ['Currency', 'currency', 9],
    ],
    taxRows,
  );
  const checkRows = [];
  for (const r of results) for (const c of failedChecks(r)) checkRows.push({ file: r.file, invoiceNumber: r.invoice?.invoiceNumber, status: r.validation.status, level: c.level, check: c.id, message: c.message });
  addTable(
    'Checks',
    [
      ['File', 'file', 28],
      ['Invoice No', 'invoiceNumber', 18],
      ['Status', 'status', 9],
      ['Level', 'level', 9],
      ['Check', 'check', 20],
      ['Message', 'message', 100],
    ],
    checkRows,
    { statusKey: 'status' },
  );

  const file = join(outDir, 'invoices.xlsx');
  await wb.xlsx.writeFile(file);
  return [file];
}

export async function exportAll(results, outDir, { formats = ['json', 'xlsx', 'csv'], accountingStatuses = ['ok'], env } = {}) {
  await mkdir(outDir, { recursive: true });
  const written = [];
  for (const f of formats) {
    if (f === 'json') written.push(...(await writeJson(results, outDir)));
    else if (f === 'xlsx' || f === 'excel') written.push(...(await writeExcel(results, outDir)));
    else if (f === 'csv') written.push(...(await writeCsv(results, outDir)));
    else if (f === 'xero') written.push(...(await writeXero(results, outDir, { statuses: accountingStatuses, env })));
    else if (f === 'quickbooks' || f === 'qbo') written.push(...(await writeQuickBooks(results, outDir, { statuses: accountingStatuses, env })));
    else throw new Error(`Unknown format "${f}" (use ${FORMATS.join(', ')})`);
  }
  return written;
}

/** Re-read json/<file>.json results (used by `export` and `watch` to rebuild reports). */
export async function loadResults(outDir) {
  const dir = join(outDir, 'json');
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  const out = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(await readFile(join(dir, f), 'utf8')));
    } catch {
      /* skip broken file */
    }
  }
  return out;
}
