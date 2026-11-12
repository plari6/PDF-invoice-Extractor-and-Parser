import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { readPdf, PdfError } from './pdf/read.js';
import { extractWithRules } from './extract/rules.js';
import { extractWithAi, PROMPT_VERSION } from './extract/ai.js';
import { normalizeInvoice, enrichIds } from './schema.js';
import { validateInvoice, flagDuplicates } from './validate.js';
import { near } from './parse/numbers.js';

/**
 * One PDF in, one validated result out:
 *   read text -> pick text or vision mode -> AI over the fallback chain (cached)
 *   -> rules engine as fallback / gap filler / cross-check -> normalize -> validate
 * Never throws for a bad document: the result carries status "failed" and the reason.
 */
export async function processPdf(buffer, { fileName = 'invoice.pdf', ai = null, useAi = true, vision = 'auto', cache = null, password, today, log = () => {}, signal } = {}) {
  const started = Date.now();
  const base = { file: fileName, extractedAt: new Date().toISOString(), schemaVersion: PROMPT_VERSION };
  let doc;
  try {
    doc = await readPdf(buffer, { password });
  } catch (err) {
    const code = err instanceof PdfError ? err.code : 'error';
    return { ...base, sha256: null, pages: 0, mode: null, source: 'none', error: err.message, errorCode: code, invoice: null, validation: { status: 'failed', confidence: 0, errors: 1, warnings: 0, checks: [{ id: 'read', level: 'error', ok: false, message: err.message }] }, ms: Date.now() - started };
  }

  const hasText = !doc.scanned && doc.chars > 0;
  const rules = hasText ? extractWithRules(doc.text) : null;
  const meta = rules?.meta || { decimal: null, dayFirst: true };
  let mode = vision === 'always' || (vision === 'auto' && (doc.scanned || doc.garbled)) ? 'vision' : 'text';
  if (vision === 'never' && !hasText) mode = 'text';

  let aiData = null;
  let model = null;
  let aiAttempts = [];
  let aiError = null;
  let cached = false;
  const aiReady = useAi && ai && ai.enabledCount > 0;

  if (aiReady && (mode === 'vision' || hasText)) {
    const key = `${doc.sha256}-${PROMPT_VERSION}-${mode}`;
    const hit = cache ? await cache.get(key) : null;
    if (hit) {
      ({ data: aiData, model } = hit);
      cached = true;
    } else {
      const tryMode = async (m) => {
        const r = await extractWithAi(ai, { text: doc.text, pdf: m === 'vision' ? Buffer.from(buffer) : undefined, pages: doc.pages, fileName, vision: m === 'vision', signal });
        aiAttempts = aiAttempts.concat(r.attempts || []);
        return r;
      };
      try {
        const r = await tryMode(mode);
        ({ data: aiData, model } = r);
        if (cache) await cache.set(`${doc.sha256}-${PROMPT_VERSION}-${mode}`, { data: aiData, model, at: new Date().toISOString() });
      } catch (err) {
        aiAttempts = aiAttempts.concat(err.attempts || []);
        aiError = err.message;
        if (mode === 'vision' && hasText) {
          log(`[ai] vision failed for ${fileName} (${err.message}); retrying with the text layer`);
          try {
            mode = 'text';
            ({ data: aiData, model } = await tryMode('text'));
            aiError = null;
          } catch (err2) {
            aiError = err2.message;
          }
        }
      }
    }
  } else if (useAi && !aiReady) aiError = 'No AI provider configured (set GEMINI_API_KEY)';

  let source = aiData ? 'ai' : rules ? 'rules' : 'none';
  const invoice = normalizeInvoice(aiData || rules?.invoice || {}, meta);
  const filledFromRules = [];
  let rulesTotalDisagrees = null;

  if (aiData && rules) {
    const r = normalizeInvoice(rules.invoice, meta);
    const fill = (path) => {
      const [a, b] = path.split('.');
      const tgt = b ? invoice[a] : invoice;
      const src = b ? r[a] : r;
      const k = b || a;
      if ((tgt[k] === null || tgt[k] === undefined) && src[k] !== null && src[k] !== undefined) {
        tgt[k] = src[k];
        filledFromRules.push(path);
      }
    };
    ['invoiceNumber', 'invoiceDate', 'dueDate', 'poNumber', 'currency', 'paymentTerms', 'vendor.name', 'vendor.taxId', 'vendor.email', 'vendor.phone', 'vendor.iban', 'customer.name', 'customer.taxId', 'totals.total', 'totals.subtotal', 'totals.tax'].forEach(fill);
    if (!invoice.lineItems.length && r.lineItems.length) {
      invoice.lineItems = r.lineItems;
      filledFromRules.push('lineItems');
    }
    if (filledFromRules.length) source = 'ai+rules';
    if (invoice.totals.total !== null && r.totals.total !== null && !near(invoice.totals.total, r.totals.total)) rulesTotalDisagrees = r.totals.total;
  }
  enrichIds(invoice);

  const validation = validateInvoice(invoice, { source, mode, text: doc.text, decimal: meta.decimal, today });
  if (rulesTotalDisagrees !== null) {
    validation.checks.push({ id: 'crosscheck.total', level: 'warning', ok: false, message: `AI total ${invoice.totals.total} differs from the total the rules engine read (${rulesTotalDisagrees})` });
    validation.warnings++;
    validation.confidence = Math.max(0, validation.confidence - 8);
    if (validation.confidence < 70 && validation.status === 'ok') validation.status = 'review';
  }
  if (!hasText && !aiData) {
    const why = !useAi ? 'AI is off (--no-ai). Set GEMINI_API_KEY and run without --no-ai.' : !aiReady ? 'Set GEMINI_API_KEY.' : `AI vision is unavailable right now, retry later. ${aiError || ''}`;
    Object.assign(validation, {
      status: 'failed',
      confidence: 0,
      errors: 1,
      warnings: 0,
      checks: [{ id: 'scanned', level: 'error', ok: false, message: `Scanned / image-only PDF: needs AI vision (Gemini). ${why}`.trim() }],
    });
  }

  return {
    ...base,
    sha256: doc.sha256,
    pages: doc.pages,
    bytes: doc.bytes,
    textQuality: doc.quality,
    scanned: doc.scanned,
    mode: aiData ? mode : rules ? 'text' : null,
    source,
    model,
    cached,
    aiAttempts: aiAttempts.filter((a) => !a.ok).map(({ target, kind, error }) => ({ target, kind, error })),
    aiError: aiData ? null : aiError,
    filledFromRules,
    invoice,
    validation,
    ms: Date.now() - started,
  };
}

export async function processFile(path, opts = {}) {
  const buffer = await readFile(path);
  const result = await processPdf(buffer, { ...opts, fileName: basename(path) });
  result.path = resolve(path);
  return result;
}

/** Expand files and folders into a sorted list of PDF paths. */
export async function collectPdfs(inputs, { recursive = false } = {}) {
  const out = [];
  const walk = async (dir, depth) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && recursive && !e.name.startsWith('.') && e.name !== 'node_modules') await walk(p, depth + 1);
      else if (e.isFile() && extname(e.name).toLowerCase() === '.pdf') out.push(p);
    }
  };
  for (const input of inputs) {
    const s = await stat(input).catch(() => null);
    if (!s) throw new Error(`Not found: ${input}`);
    if (s.isDirectory()) await walk(input, 0);
    else out.push(input);
  }
  return [...new Set(out.map((p) => resolve(p)))].sort();
}

/** Process many PDFs with a concurrency limit, then flag duplicates across the batch. */
export async function processBatch(paths, { concurrency = 3, onResult = () => {}, ...opts } = {}) {
  const results = new Array(paths.length);
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const i = next++;
      try {
        results[i] = await processFile(paths[i], opts);
      } catch (err) {
        results[i] = { file: basename(paths[i]), path: resolve(paths[i]), error: err.message, invoice: null, source: 'none', validation: { status: 'failed', confidence: 0, errors: 1, warnings: 0, checks: [{ id: 'read', level: 'error', ok: false, message: err.message }] } };
      }
      onResult(results[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, paths.length)) }, worker));
  return flagDuplicates(results);
}

/** Totals per status and per currency, for the CLI summary and the Excel Summary sheet. */
export function summarize(results) {
  const s = { files: results.length, ok: 0, review: 0, failed: 0, byCurrency: {}, aiModels: {}, sources: {} };
  for (const r of results) {
    s[r.validation?.status || 'failed']++;
    s.sources[r.source] = (s.sources[r.source] || 0) + 1;
    if (r.model) s.aiModels[r.model] = (s.aiModels[r.model] || 0) + 1;
    const inv = r.invoice;
    if (!inv || inv.totals.total === null) continue;
    const c = inv.currency || '???';
    const b = (s.byCurrency[c] ||= { invoices: 0, net: 0, tax: 0, total: 0 });
    b.invoices++;
    b.net = Math.round((b.net + (inv.totals.subtotal ?? 0)) * 100) / 100;
    b.tax = Math.round((b.tax + (inv.totals.tax ?? 0)) * 100) / 100;
    b.total = Math.round((b.total + inv.totals.total) * 100) / 100;
  }
  return s;
}
