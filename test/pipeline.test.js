import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { samplePdfs, SAMPLE_EXPECTED, SCAN_FIXTURE } from '../src/demo/samples.js';
import { buildPdf, layoutPage } from '../src/pdf/write.js';
import { processPdf, summarize } from '../src/pipeline.js';
import { flagDuplicates, validateInvoice } from '../src/validate.js';
import { normalizeInvoice, enrichIds } from '../src/schema.js';
import { createLLMRouter, createGeminiProvider, createOpenAICompatibleProvider } from '../src/ai/index.js';
import { createCache } from '../src/cache.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PDFS = samplePdfs();
const TODAY = new Date('2026-11-12T12:00:00Z');

/** Router over fake providers: each entry is (request) => text | throws. */
function fakeRouter(...handlers) {
  const providers = {};
  const chain = handlers.map((h, i) => {
    providers[`p${i}`] = { configured: true, calls: [], async complete(req) { this.calls.push(req); return { text: await h(req) }; } };
    return { provider: `p${i}`, model: `m${i}` };
  });
  const router = createLLMRouter({ chain, providers, timeoutMs: 2000, totalBudgetMs: 5000 });
  return { router, providers };
}

const acmeAiJson = {
  documentType: 'invoice',
  invoiceNumber: 'INV-2026-0142',
  invoiceDate: '2026-10-03',
  dueDate: '2026-11-02',
  currency: 'USD',
  poNumber: 'PO-7781',
  paymentTerms: 'Net 30',
  vendor: { name: 'Acme Cloud Services, Inc.', taxId: '94-3218765', email: 'billing@acmecloud.example', phone: '+1 415 555 0142' },
  customer: { name: 'Northwind Traders LLC' },
  lineItems: [
    { description: 'Cloud Hosting - Pro Plan (October)', quantity: 1, unitPrice: 1200, amount: 1200 },
    { description: 'Additional storage 500 GB', quantity: 5, unitPrice: 40, amount: 200 },
    { description: 'Premium support hours', quantity: 12, unitPrice: 150, amount: 1800 },
    { description: 'Onboarding workshop', quantity: 2, unitPrice: 450, amount: 900 },
    { description: 'SSL certificate - wildcard', quantity: 1, unitPrice: 249, amount: 249 },
  ],
  taxes: [{ label: 'Sales Tax 8.625%', rate: 8.625, amount: 356.35 }],
  totals: { subtotal: 4349, discount: 217.45, tax: 356.35, shipping: 0, total: 4487.9, amountDue: 4487.9 },
};

for (const [name, want] of Object.entries(SAMPLE_EXPECTED)) {
  if (want.scanned) continue;
  test(`rules engine (no AI) extracts ${name}`, async () => {
    const r = await processPdf(PDFS[name], { fileName: name, useAi: false, today: TODAY });
    const i = r.invoice;
    assert.equal(r.source, 'rules');
    assert.equal(i.invoiceNumber, want.invoiceNumber);
    assert.equal(i.invoiceDate, want.invoiceDate);
    if (want.dueDate) assert.equal(i.dueDate, want.dueDate);
    assert.equal(i.currency, want.currency);
    assert.equal(i.totals.total, want.total);
    assert.equal(i.totals.subtotal, want.subtotal);
    assert.equal(i.totals.tax, want.tax);
    assert.equal(i.lineItems.length, want.lines);
    assert.equal(i.vendor.taxId.replace(/\s/g, ''), want.vendorTaxId.replace(/\s/g, ''));
    if (want.customerTaxId) assert.equal(i.customer.taxId, want.customerTaxId);
    assert.equal(i.vendor.taxIdValid, true, 'vendor tax ID checksum');
    assert.equal(r.validation.status, want.status, JSON.stringify(r.validation.checks.filter((c) => !c.ok)));
  });
}

test('UK invoice: the deliberate £30 error in the printed total is flagged', async () => {
  const r = await processPdf(PDFS['techparts-uk-TP-24-00917.pdf'], { fileName: 'tp.pdf', useAi: false, today: TODAY });
  const c = r.validation.checks.find((x) => x.id === 'math.total');
  assert.equal(c.ok, false);
  assert.equal(c.expected, 3221.53);
  assert.match(c.message, /difference 30/);
  // wrapped description lines are merged into the item above
  assert.match(r.invoice.lineItems[1].description, /includes HDMI/);
  assert.equal(r.invoice.totals.amountPaid, 1000);
});

test('AI path: valid JSON from the first model -> source ai, grounded, ok', async () => {
  const { router } = fakeRouter(() => JSON.stringify(acmeAiJson));
  const r = await processPdf(PDFS['acme-cloud-INV-2026-0142.pdf'], { fileName: 'acme.pdf', ai: router, today: TODAY });
  assert.equal(r.source, 'ai');
  assert.equal(r.mode, 'text');
  assert.equal(r.model, 'p0:m0');
  assert.equal(r.validation.status, 'ok');
  assert.equal(r.validation.checks.find((c) => c.id === 'grounding.totals').ok, true);
});

test('AI path: garbage from model 1 -> model 2 answers (fallback on bad output)', async () => {
  const { router, providers } = fakeRouter(
    () => 'Sure! Here is the invoice: total is 4487.90',
    () => '```json\n' + JSON.stringify(acmeAiJson) + '\n```',
  );
  const r = await processPdf(PDFS['acme-cloud-INV-2026-0142.pdf'], { fileName: 'acme.pdf', ai: router, today: TODAY });
  assert.equal(r.model, 'p1:m1');
  assert.equal(r.aiAttempts[0].kind, 'bad_output');
  assert.equal(providers.p0.calls.length, 1);
});

test('AI hallucinated total is caught by grounding + math + rules cross-check', async () => {
  const bad = structuredClone(acmeAiJson);
  bad.totals.total = 4500; // not printed anywhere, does not add up
  const { router } = fakeRouter(() => JSON.stringify(bad));
  const r = await processPdf(PDFS['acme-cloud-INV-2026-0142.pdf'], { fileName: 'acme.pdf', ai: router, today: TODAY });
  const failed = r.validation.checks.filter((c) => !c.ok).map((c) => c.id);
  assert.ok(failed.includes('grounding.totals'));
  assert.ok(failed.includes('math.total'));
  assert.ok(failed.includes('crosscheck.total'));
  assert.equal(r.validation.status, 'review');
});

test('fields the AI left empty are filled from the rules engine', async () => {
  const partial = structuredClone(acmeAiJson);
  partial.vendor.taxId = null;
  partial.dueDate = null;
  const { router } = fakeRouter(() => JSON.stringify(partial));
  const r = await processPdf(PDFS['acme-cloud-INV-2026-0142.pdf'], { fileName: 'acme.pdf', ai: router, today: TODAY });
  assert.equal(r.source, 'ai+rules');
  assert.deepEqual(r.filledFromRules.sort(), ['dueDate', 'vendor.taxId']);
  assert.equal(r.invoice.vendor.taxId, '94-3218765');
});

test('every AI model down -> rules engine answers, service never stops', async () => {
  const down = () => {
    throw Object.assign(new Error('503 overloaded'), { kind: 'overloaded' });
  };
  const { router } = fakeRouter(down, down);
  const r = await processPdf(PDFS['mueller-RE-2026-0815.pdf'], { fileName: 'm.pdf', ai: router, today: TODAY });
  assert.equal(r.source, 'rules');
  assert.equal(r.invoice.totals.total, 4173.62);
  assert.match(r.aiError, /All AI providers failed/);
});

test('scanned PDF goes to Gemini as a file; OpenAI-compatible providers refuse files without a network call', async () => {
  const scan = await readFile(SCAN_FIXTURE);
  let groqFetches = 0;
  let geminiBody = null;
  const groq = createOpenAICompatibleProvider({ name: 'groq', apiKey: 'x', baseURL: 'https://example.invalid/v1', fetchImpl: async () => (groqFetches++, new Response('{}')) });
  const gemini = createGeminiProvider({
    apiKey: 'k',
    fetchImpl: async (url, init) => {
      geminiBody = JSON.parse(init.body);
      const answer = { invoiceNumber: 'FA-2026-1187', currency: 'EUR', vendor: { name: 'Atelier Lumière SARL', taxId: 'FR44732829320' }, lineItems: [], totals: { subtotal: 6802, tax: 1360.4, total: 8162.4 } };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }), { status: 200 });
    },
  });
  const router = createLLMRouter({ chain: [{ provider: 'groq', model: 'llama' }, { provider: 'gemini', model: 'gemini-x' }], providers: { groq, gemini }, timeoutMs: 2000 });
  const r = await processPdf(scan, { fileName: 'scan.pdf', ai: router, today: TODAY });
  assert.equal(r.scanned, true);
  assert.equal(r.mode, 'vision');
  assert.equal(groqFetches, 0);
  const part = geminiBody.contents[0].parts.find((p) => p.inlineData);
  assert.equal(part.inlineData.mimeType, 'application/pdf');
  assert.equal(r.invoice.totals.total, 8162.4);
  assert.equal(r.invoice.vendor.taxIdValid, true);
  assert.equal(r.validation.status, 'ok');
});

test('scanned PDF without AI -> failed with a clear reason', async () => {
  const blank = buildPdf([{ items: [{ rect: [50, 50, 400, 600] }] }]);
  const r = await processPdf(blank, { fileName: 'blank.pdf', useAi: false });
  assert.equal(r.validation.status, 'failed');
  assert.match(r.validation.checks[0].message, /Scanned/);
});

test('not a PDF / corrupt PDF -> failed result, no throw', async () => {
  const r = await processPdf(Buffer.from('hello world'), { fileName: 'x.pdf', useAi: false });
  assert.equal(r.validation.status, 'failed');
  assert.equal(r.errorCode, 'not_pdf');
  const r2 = await processPdf(Buffer.from('%PDF-1.4\ngarbage'), { fileName: 'y.pdf', useAi: false });
  assert.equal(r2.validation.status, 'failed');
});

test('AI results are cached by PDF hash: the second run makes no AI call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inv-cache-'));
  const cache = createCache(dir);
  const { router, providers } = fakeRouter(() => JSON.stringify(acmeAiJson));
  await processPdf(PDFS['acme-cloud-INV-2026-0142.pdf'], { fileName: 'a.pdf', ai: router, cache, today: TODAY });
  const r2 = await processPdf(PDFS['acme-cloud-INV-2026-0142.pdf'], { fileName: 'a.pdf', ai: router, cache, today: TODAY });
  assert.equal(providers.p0.calls.length, 1);
  assert.equal(r2.cached, true);
  assert.equal(r2.invoice.totals.total, 4487.9);
});

test('duplicates in a batch (same vendor + number) are flagged for review', async () => {
  const a = await processPdf(PDFS['mueller-RE-2026-0815.pdf'], { fileName: 'a.pdf', useAi: false, today: TODAY });
  const b = await processPdf(PDFS['mueller-RE-2026-0815.pdf'], { fileName: 'b.pdf', useAi: false, today: TODAY });
  flagDuplicates([a, b]);
  assert.equal(a.validation.status, 'ok');
  assert.equal(b.validation.status, 'review');
  assert.match(b.validation.checks.at(-1).message, /duplicate of a\.pdf/);
  assert.equal(summarize([a, b]).review, 1);
});

test('validator: swapped dates, bad line math, missing VAT number, bad IBAN', () => {
  const inv = enrichIds(
    normalizeInvoice({
      invoiceNumber: 'X1',
      invoiceDate: '2026-10-20',
      dueDate: '2026-10-05',
      currency: 'EUR',
      vendor: { name: 'V', iban: 'DE88 3704 0044 0532 0130 00' },
      lineItems: [{ description: 'a', quantity: 3, unitPrice: 10, amount: 40 }],
      totals: { subtotal: 40, tax: 7.6, total: 47.6 },
    }),
  );
  const v = validateInvoice(inv, { source: 'ai', mode: 'vision', today: TODAY });
  const failed = Object.fromEntries(v.checks.filter((c) => !c.ok).map((c) => [c.id, c]));
  assert.ok(failed['dates.order']);
  assert.deepEqual(failed['math.lineItems'].lines, [1]);
  assert.ok(failed['taxId.vendorMissing']);
  assert.ok(failed['iban']);
  assert.ok(!failed['math.total']);
});

test('normalizeInvoice coerces messy AI values', () => {
  const inv = normalizeInvoice({ invoice_number: ' 42 ', date: '15.10.2026', currency: '€', totals: { total: '1.234,56 €', discount: -10 }, lineItems: [{ description: 'x', qty: '2', price: '5,00', vatRate: 0.19 }] }, { decimal: ',' });
  assert.equal(inv.invoiceNumber, '42');
  assert.equal(inv.invoiceDate, '2026-10-15');
  assert.equal(inv.currency, 'EUR');
  assert.equal(inv.totals.total, 1234.56);
  assert.equal(inv.totals.discount, 10);
  assert.equal(inv.lineItems[0].taxRate, 19);
  assert.equal(inv.lineItems[0].unitPrice, 5);
});
