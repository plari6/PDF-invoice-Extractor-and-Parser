import { mkdir, writeFile } from 'node:fs/promises';
import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPdf, layoutPage } from '../pdf/write.js';
import { deCheckDigit, gbCheckDigits, gstinCheckChar, makeIban } from '../parse/taxid.js';

/**
 * Five demo invoices that cover what makes real invoices hard:
 *  1. US SaaS invoice: month-first dates, EIN, sales tax, document discount
 *  2. German invoice: 1.234,56 numbers, 19 % + 7 % VAT split, USt-IdNr with checksum, IBAN
 *  3. UK invoice over 2 pages: repeated table header, wrapped descriptions, partial payment
 *     and a deliberate arithmetic error in the printed total (the validator must flag it)
 *  4. Indian GST invoice: lakh grouping (2,22,000.00), CGST + SGST, GSTIN checksums
 *  5. Scanned French invoice (examples/scanned-facture-FA-2026-1187.pdf): an image only, no text
 *     layer, slightly rotated - needs AI vision (Gemini reads the PDF itself)
 */

const DE_VENDOR = `DE81234567${deCheckDigit('81234567')}`;
const DE_CUSTOMER = `DE29876543${deCheckDigit('29876543')}`;
const GB_VAT = `GB 123 4567 ${gbCheckDigits('1234567')}`;
const GSTIN_V = `27AAACS1234F1Z${gstinCheckChar('27AAACS1234F1Z')}`;
const GSTIN_C = `27AABCL5678K1Z${gstinCheckChar('27AABCL5678K1Z')}`;
const IBAN_DE = makeIban('DE', '370400440532013000').replace(/(.{4})/g, '$1 ').trim();
const IBAN_GB = makeIban('GB', 'NWBK60161331926819').replace(/(.{4})/g, '$1 ').trim();

export const SCAN_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'scanned-facture-FA-2026-1187.pdf');

const B = { bold: true };
const H = (size) => ({ bold: true, size });

export const SAMPLE_EXPECTED = {
  'acme-cloud-INV-2026-0142.pdf': { invoiceNumber: 'INV-2026-0142', invoiceDate: '2026-10-03', dueDate: '2026-11-02', currency: 'USD', total: 4487.9, subtotal: 4349, tax: 356.35, lines: 5, vendorTaxId: '94-3218765', status: 'ok' },
  'mueller-RE-2026-0815.pdf': { invoiceNumber: 'RE-2026-0815', invoiceDate: '2026-10-15', dueDate: '2026-11-14', currency: 'EUR', total: 4173.62, subtotal: 3517.3, tax: 656.32, lines: 4, vendorTaxId: DE_VENDOR, customerTaxId: DE_CUSTOMER, status: 'ok' },
  'techparts-uk-TP-24-00917.pdf': { invoiceNumber: 'TP/24/00917', invoiceDate: '2026-10-28', dueDate: '2026-11-27', currency: 'GBP', total: 3251.53, subtotal: 2982.9, tax: 536.92, lines: 5, vendorTaxId: GB_VAT.replace(/\s/g, ''), status: 'review' },
  'shree-ganesh-gst-0458.pdf': { invoiceNumber: 'SGT/2026-27/0458', invoiceDate: '2026-11-05', currency: 'INR', total: 409500, subtotal: 390000, tax: 19500, lines: 2, vendorTaxId: GSTIN_V, customerTaxId: GSTIN_C, status: 'ok' },
  'scanned-facture-FA-2026-1187.pdf': { invoiceNumber: 'FA-2026-1187', invoiceDate: '2026-10-21', dueDate: '2026-11-20', currency: 'EUR', total: 8162.4, subtotal: 6802, tax: 1360.4, lines: 3, vendorTaxId: 'FR44732829320', scanned: true, status: 'ok' },
};

export function samplePdfs() {
  const acme = layoutPage([
    [[50, 'Acme Cloud Services, Inc.', H(16)], [440, 'INVOICE', H(18)]],
    '500 Market Street, Suite 300',
    'San Francisco, CA 94105',
    'Phone: +1 415 555 0142    billing@acmecloud.example',
    'EIN: 94-3218765',
    null,
    [[50, 'Invoice No: INV-2026-0142'], [330, 'PO Number: PO-7781']],
    [[50, 'Invoice Date: Oct 3, 2026'], [330, 'Payment Terms: Net 30']],
    'Due Date: Nov 2, 2026',
    null,
    [[50, 'Bill To:', B]],
    'Northwind Traders LLC',
    '200 Harbor Blvd, Seattle, WA 98101',
    'ap@northwind.example',
    null,
    { hr: true },
    [[50, 'Item', B], [110, 'Description', B], [360, 'Qty', B], [400, 'Unit Price', B], [490, 'Amount', B]],
    [[50, 'CLD-100'], [110, 'Cloud Hosting - Pro Plan (October)'], [360, '1'], [400, '1,200.00'], [490, '1,200.00']],
    [[50, 'CLD-210'], [110, 'Additional storage 500 GB'], [360, '5'], [400, '40.00'], [490, '200.00']],
    [[50, 'SUP-001'], [110, 'Premium support hours'], [360, '12'], [400, '150.00'], [490, '1,800.00']],
    [[50, 'TRN-002'], [110, 'Onboarding workshop (remote, 2 sessions)'], [360, '2'], [400, '450.00'], [490, '900.00']],
    [[50, 'SSL-WC'], [110, 'SSL certificate - wildcard'], [360, '1'], [400, '249.00'], [490, '249.00']],
    { hr: true },
    [[360, 'Subtotal'], [490, '4,349.00']],
    [[360, 'Discount (5% loyalty)'], [490, '-217.45']],
    [[360, 'Sales Tax 8.625%'], [490, '356.35']],
    [[360, 'Shipping'], [490, '0.00']],
    [[360, 'Total USD', B], [490, '4,487.90', B]],
    [[360, 'Amount Due', B], [490, '$4,487.90', B]],
    null,
    'Thank you for your business. Pay by ACH or card at pay.acmecloud.example',
  ]);

  const mueller = layoutPage([
    [[50, 'Müller Maschinenbau GmbH', H(15)], [430, 'RECHNUNG', H(18)]],
    'Industriestraße 12, 70173 Stuttgart',
    'Tel. +49 711 123456 · info@mueller-maschinenbau.example',
    `USt-IdNr.: ${DE_VENDOR}`,
    null,
    [[50, 'Rechnungsnummer: RE-2026-0815'], [330, 'Ihre Bestellung: B-44120']],
    [[50, 'Rechnungsdatum: 15.10.2026'], [330, 'Fällig am: 14.11.2026']],
    null,
    [[50, 'Rechnungsempfänger:', B]],
    'Schneider Logistik AG',
    'Hafenweg 3, 20457 Hamburg',
    `USt-IdNr.: ${DE_CUSTOMER}`,
    null,
    { hr: true },
    [[50, 'Pos', B], [75, 'Beschreibung', B], [300, 'Menge', B], [345, 'Einheit', B], [390, 'Einzelpreis', B], [455, 'MwSt', B], [495, 'Betrag', B]],
    [[50, '1'], [75, 'Wartungsvertrag Hydraulikpresse HP-400'], [300, '1'], [345, 'Stk'], [390, '2.450,00'], [455, '19%'], [495, '2.450,00']],
    [[50, '2'], [75, 'Verschleißteile Satz (Dichtungen, Filter)'], [300, '4'], [345, 'Stk'], [390, '87,50'], [455, '19%'], [495, '350,00']],
    [[50, '3'], [75, 'Servicetechniker Einsatz vor Ort'], [300, '6,5'], [345, 'Std'], [390, '95,00'], [455, '19%'], [495, '617,50']],
    [[50, '4'], [75, 'Fachbuch Hydraulik Grundlagen'], [300, '2'], [345, 'Stk'], [390, '49,90'], [455, '7%'], [495, '99,80']],
    { hr: true },
    [[330, 'Nettobetrag'], [495, '3.517,30 €']],
    [[330, 'MwSt 19% auf 3.417,50'], [495, '649,33 €']],
    [[330, 'MwSt 7% auf 99,80'], [495, '6,99 €']],
    [[330, 'Gesamtbetrag', B], [495, '4.173,62 €', B]],
    null,
    'Zahlbar bis 14.11.2026 ohne Abzug.',
    `Bankverbindung: Volksbank Stuttgart · IBAN: ${IBAN_DE} · BIC: GENODES1VBK`,
  ]);

  const tpHeader = [[50, 'Code', B], [120, 'Description', B], [370, 'Qty', B], [410, 'Price', B], [490, 'Total', B]];
  const tp1 = layoutPage([
    [[50, 'TechParts UK Ltd', H(16)]],
    'Unit 4, Riverside Park, Leeds LS1 4AP',
    `VAT Reg No: ${GB_VAT}`,
    [[400, 'TAX INVOICE', H(16)]],
    [[50, 'Invoice #: TP/24/00917'], [330, 'Date: 28/10/2026']],
    [[50, 'Payment due: 27/11/2026'], [330, 'Terms: 30 days net']],
    null,
    [[50, 'Customer: Brightside Dental Clinics Ltd', B]],
    '45 King Street, Manchester M2 4LQ',
    'accounts@brightside-dental.example',
    null,
    { hr: true },
    tpHeader,
    [[50, 'TP-KB-01'], [120, 'Wireless keyboard and mouse combo'], [370, '10'], [410, '34.99'], [490, '349.90']],
    [[120, 'UK layout, black, 2.4 GHz receiver']],
    [[50, 'TP-MN-27'], [120, '27" 4K monitor with adjustable stand'], [370, '6'], [410, '289.00'], [490, '1,734.00']],
    [[120, 'includes HDMI and USB-C cables']],
    [[50, 'TP-DS-02'], [120, 'USB-C docking station'], [370, '2'], [410, '89.50'], [490, '179.00']],
    null,
    [[440, 'continued on page 2']],
  ]);
  const tp2 = layoutPage([
    [[50, 'TechParts UK Ltd - Invoice TP/24/00917 - page 2']],
    { hr: true },
    tpHeader,
    [[50, 'TP-SV-SETUP'], [120, 'On-site setup & configuration'], [370, '1'], [410, '450.00'], [490, '450.00']],
    [[50, 'TP-WAR-3Y'], [120, 'Extended warranty 3 years (monitors)'], [370, '6'], [410, '45.00'], [490, '270.00']],
    { hr: true },
    [[330, 'Subtotal'], [490, '2,982.90']],
    [[330, 'Trade discount 10%'], [490, '-298.29']],
    [[330, 'VAT @ 20%'], [490, '536.92']],
    [[330, 'Total', B], [490, '£3,251.53', B]],
    [[330, 'Less: paid on account'], [490, '1,000.00']],
    [[330, 'Balance due', B], [490, '£2,251.53', B]],
    null,
    `Pay to: TechParts UK Ltd, IBAN ${IBAN_GB}`,
  ]);

  const gst = layoutPage([
    [[50, 'Shree Ganesh Textiles Pvt. Ltd.', H(15)]],
    'Plot 22, MIDC Bhiwandi, Maharashtra 421302',
    `GSTIN: ${GSTIN_V}`,
    [[420, 'TAX INVOICE', H(16)]],
    [[50, 'Invoice No.: SGT/2026-27/0458'], [330, 'Invoice Date: 05-11-2026']],
    'Place of supply: Maharashtra (27)',
    null,
    [[50, 'Bill To:', B]],
    'Lotus Retail Pvt Ltd',
    'Linking Road, Bandra West, Mumbai 400050',
    `GSTIN: ${GSTIN_C}`,
    null,
    { hr: true },
    [[50, 'HSN', B], [100, 'Description', B], [320, 'Qty', B], [390, 'Rate', B], [480, 'Amount', B]],
    [[50, '5208'], [100, 'Cotton fabric 60s count'], [320, '1,200 m'], [390, '185.00'], [480, '2,22,000.00']],
    [[50, '6006'], [100, 'Knitted jersey fabric'], [320, '800 m'], [390, '210.00'], [480, '1,68,000.00']],
    { hr: true },
    [[330, 'Taxable Value'], [480, '3,90,000.00']],
    [[330, 'CGST @ 2.5%'], [480, '9,750.00']],
    [[330, 'SGST @ 2.5%'], [480, '9,750.00']],
    [[330, 'Total Invoice Value', B], [480, 'Rs. 4,09,500.00', B]],
    null,
    'Amount in words: Rupees Four Lakh Nine Thousand Five Hundred Only',
  ]);

  return {
    'acme-cloud-INV-2026-0142.pdf': buildPdf([acme], { title: 'Invoice INV-2026-0142' }),
    'mueller-RE-2026-0815.pdf': buildPdf([mueller], { title: 'Rechnung RE-2026-0815' }),
    'techparts-uk-TP-24-00917.pdf': buildPdf([tp1, tp2], { title: 'Tax invoice TP/24/00917' }),
    'shree-ganesh-gst-0458.pdf': buildPdf([gst], { title: 'Tax invoice SGT/2026-27/0458' }),
  };
}

export async function writeSamples(dir) {
  await mkdir(dir, { recursive: true });
  const files = samplePdfs();
  for (const [name, buf] of Object.entries(files)) await writeFile(join(dir, name), buf);
  await copyFile(SCAN_FIXTURE, join(dir, 'scanned-facture-FA-2026-1187.pdf'));
  return [...Object.keys(files), 'scanned-facture-FA-2026-1187.pdf'].map((n) => join(dir, n));
}
