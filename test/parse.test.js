import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parseDate, detectCurrency, detectDecimalSeparator, findAmounts, guessDayFirst } from '../src/parse/numbers.js';
import { classifyTaxId, findTaxIds, findIbans, ibanValid, makeIban, deCheckDigit, gbCheckDigits, gstinCheckChar, frKey, abnValid } from '../src/parse/taxid.js';

test('parseAmount handles international formats', () => {
  const cases = [
    ['1,234.56', 1234.56],
    ['1.234,56', 1234.56],
    ['1 234,56', 1234.56],
    ["1'234.50", 1234.5],
    ['€ 1.200,00', 1200],
    ['$4,487.90', 4487.9],
    ['(1,200.00)', -1200],
    ['1.200,00-', -1200],
    ['-217.45', -217.45],
    ['−45,00 €', -45],
    ['2,22,000.00', 222000],
    ['12,5', 12.5],
    ['0.5', 0.5],
    ['1,234', 1234],
    ['1.234.567', 1234567],
    ['USD 99', 99],
    ['150.00 CR', -150],
    ['abc', null],
    ['', null],
  ];
  for (const [input, want] of cases) assert.equal(parseAmount(input), want, input);
  assert.equal(parseAmount('1.234', { decimal: '.' }), 1.234, 'document says dot is decimal');
  assert.equal(parseAmount('1,234', { decimal: ',' }), 1.234);
});

test('detectDecimalSeparator reads the document convention', () => {
  assert.equal(detectDecimalSeparator('Netto 3.517,30 MwSt 649,33 Gesamt 4.173,62'), ',');
  assert.equal(detectDecimalSeparator('Subtotal 4,349.00 Tax 356.35 Total 4,487.90'), '.');
  assert.equal(detectDecimalSeparator('no numbers here'), null);
});

test('findAmounts: lakh grouping, and spaces only group in comma-decimal docs', () => {
  assert.deepEqual(findAmounts('Total Rs. 4,09,500.00').map((a) => a.value), [409500]);
  assert.deepEqual(findAmounts('Support 12 150.00 1,800.00', { decimal: '.' }).map((a) => a.value), [12, 150, 1800]);
  assert.deepEqual(findAmounts('Total HT 6 802,00 €', { decimal: ',' }).map((a) => a.value), [6802]);
});

test('parseDate: ISO, dotted, slashed (day/month order), month names in 5 languages', () => {
  assert.equal(parseDate('2026-10-15'), '2026-10-15');
  assert.equal(parseDate('15.10.2026'), '2026-10-15');
  assert.equal(parseDate('03/04/2026'), '2026-04-03');
  assert.equal(parseDate('03/04/2026', { dayFirst: false }), '2026-03-04');
  assert.equal(parseDate('10/15/2026'), '2026-10-15', 'impossible month forces month-first');
  assert.equal(parseDate('05-11-26'), '2026-11-05');
  assert.equal(parseDate('Oct 3, 2026'), '2026-10-03');
  assert.equal(parseDate('October 3rd, 2026'), '2026-10-03');
  assert.equal(parseDate('3 March 2026'), '2026-03-03');
  assert.equal(parseDate('3. Oktober 2026'), '2026-10-03');
  assert.equal(parseDate('21 octobre 2026'), '2026-10-21');
  assert.equal(parseDate('5 de mayo de 2026'), '2026-05-05');
  assert.equal(parseDate('12-Mar-26'), '2026-03-12');
  assert.equal(parseDate('31.02.2026'), null, '31 Feb does not exist');
  assert.equal(parseDate('not a date'), null);
});

test('detectCurrency and day-first guess', () => {
  assert.equal(detectCurrency('Total 4.173,62 €'), 'EUR');
  assert.equal(detectCurrency('Total USD 4,487.90 $'), 'USD');
  assert.equal(detectCurrency('Balance due £2,251.53'), 'GBP');
  assert.equal(detectCurrency('Total Rs. 4,09,500.00'), 'INR');
  assert.equal(detectCurrency('Total 500 AED incl VAT'), 'AED');
  assert.equal(guessDayFirst({ currency: 'USD', text: 'Sales Tax' }), false);
  assert.equal(guessDayFirst({ currency: 'GBP', text: 'VAT' }), true);
});

test('tax IDs: checksums for DE, GB, FR, IT, GSTIN, ABN, CH, EIN, TRN', () => {
  const de = `DE81234567${deCheckDigit('81234567')}`;
  assert.deepEqual(classifyTaxId(de), { value: de, type: 'VAT', country: 'DE', valid: true });
  assert.equal(classifyTaxId(de.slice(0, -1) + ((Number(de.at(-1)) + 1) % 10)).valid, false);
  assert.equal(classifyTaxId(`GB 123 4567 ${gbCheckDigits('1234567')}`).valid, true);
  assert.equal(classifyTaxId('GB 123 4567 00').valid, false);
  assert.equal(classifyTaxId(`FR${frKey('732829320')}732829320`).valid, true);
  assert.equal(classifyTaxId('FR00732829320').valid, false);
  assert.equal(classifyTaxId('IT07643520567').valid, true);
  const gstin = `27AAACS1234F1Z${gstinCheckChar('27AAACS1234F1Z')}`;
  assert.equal(classifyTaxId(gstin).type, 'GSTIN');
  assert.equal(classifyTaxId(gstin).valid, true);
  assert.equal(abnValid('51824753556'), true);
  assert.deepEqual(classifyTaxId('51 824 753 556', 'ABN'), { value: '51 824 753 556', type: 'ABN', country: 'AU', valid: true });
  assert.equal(classifyTaxId('CHE-116.281.710 MWST').valid, true);
  assert.equal(classifyTaxId('94-3218765', 'EIN').type, 'EIN');
  assert.equal(classifyTaxId('100234567890003', 'TRN').country, 'AE');
  assert.equal(classifyTaxId('300012345600003').country, 'SA');
  assert.equal(classifyTaxId('NL123456789B01').country, 'NL');
});

test('findTaxIds reads labels in several languages and keeps document order', () => {
  const text = 'Müller GmbH\nUSt-IdNr.: DE812345673\nVAT Reg No: GB 123 4567 82\nN° TVA intracom. : FR44732829320\nGSTIN: 27AAACS1234F1ZS\nABN: 51 824 753 556\nTax ID: 94-3218765';
  const ids = findTaxIds(text).map((x) => [x.type, x.country, x.valid]);
  assert.deepEqual(ids, [
    ['VAT', 'DE', true],
    ['VAT', 'GB', true],
    ['VAT', 'FR', true],
    ['GSTIN', 'IN', true],
    ['ABN', 'AU', true],
    ['EIN', 'US', true],
  ]);
});

test('IBAN mod-97', () => {
  const iban = makeIban('DE', '370400440532013000');
  assert.equal(iban, 'DE89370400440532013000');
  assert.equal(ibanValid('DE89 3704 0044 0532 0130 00'), true);
  assert.equal(ibanValid('DE88 3704 0044 0532 0130 00'), false);
  assert.equal(findIbans('IBAN: GB29 NWBK 6016 1331 9268 19 BIC')[0].valid, true);
});
