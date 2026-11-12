#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.INVOICE_SKIP_DOTENV) {
  const { config } = await import('dotenv');
  for (const p of [join(process.cwd(), '.env'), join(ROOT, '.env')]) if (existsSync(p)) config({ path: p, quiet: true });
}

const { createRouterFromEnv, DEFAULT_CHAIN } = await import('../src/ai/index.js');
const { collectPdfs, processBatch, summarize } = await import('../src/pipeline.js');
const { exportAll, loadResults, FORMATS } = await import('../src/export/index.js');
const { createCache } = await import('../src/cache.js');
const { AI_SHAPE } = await import('../src/schema.js');
const { postWebhook, webhookPayload } = await import('../src/notify.js');

/* ------------------------------------------------------------------ output helpers */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR && !process.argv.includes('--no-color');
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { green: paint(32), yellow: paint(33), red: paint(31), dim: paint(2), bold: paint(1), cyan: paint(36) };
const STATUS = { ok: c.green('OK    '), review: c.yellow('REVIEW'), failed: c.red('FAILED') };
const money = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pad = (s, n) => {
  s = String(s ?? '-');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
};

function makeAi(opts, { quiet = false } = {}) {
  const simulate = String(opts.simulateOutage || '').split(',').filter(Boolean);
  return createRouterFromEnv(process.env, {
    simulate,
    onEvent: (e) => {
      if (quiet) return;
      if (e.type === 'failure') console.error(c.dim(`  [ai] ${e.target} ${e.kind}${e.status ? ` ${e.status}` : ''} -> next model`));
      if (e.type === 'hedge') console.error(c.dim(`  [ai] slow answer, also asking ${e.targets.at(-1)}`));
    },
  });
}

function printResult(r, { verbose }) {
  const i = r.invoice;
  const v = r.validation;
  const who = r.model ? `${r.source} ${r.model}` : r.source;
  console.log(`${STATUS[v.status]} ${pad(r.file, 34)} ${pad(i?.invoiceNumber, 18)} ${pad(i?.vendor?.name, 26)} ${money(i?.totals?.total).padStart(13)} ${pad(i?.currency || '', 4)} ${String(v.confidence).padStart(3)}%  ${c.dim(who + (r.cached ? ' (cached)' : ''))}`);
  const failed = v.checks.filter((x) => !x.ok && (x.level !== 'info' || verbose));
  for (const x of failed) console.log(`       ${x.level === 'error' ? c.red('✗') : c.yellow('!')} ${x.message}`);
  if (r.aiError && r.source !== 'ai' && verbose) console.log(c.dim(`       AI: ${r.aiError}`));
}

function printSummary(results, written, outDir) {
  const s = summarize(results);
  console.log('');
  console.log(c.bold(`${s.files} file(s): ${c.green(`${s.ok} ok`)}, ${c.yellow(`${s.review} to review`)}, ${c.red(`${s.failed} failed`)}`));
  for (const [cur, b] of Object.entries(s.byCurrency)) console.log(`  ${cur}: ${b.invoices} invoice(s), net ${money(b.net)}, tax ${money(b.tax)}, total ${money(b.total)}`);
  if (written.length) {
    console.log(c.dim(`Output in ${outDir}:`));
    for (const w of written) console.log(c.dim(`  ${relative(process.cwd(), w) || w}`));
  }
}

const parseList = (v) => String(v).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

/* ------------------------------------------------------------------ commands */
const program = new Command();
program
  .name('invoice-extractor')
  .description('Turn messy PDF invoices into validated JSON, Excel and accounting CSV (line items, tax IDs, VAT, totals).')
  .version('1.0.0')
  .option('--no-color', 'plain output');

const commonExtract = (cmd) =>
  cmd
    .option('-o, --out <dir>', 'output folder', 'output')
    .option('-f, --format <list>', `comma list: ${FORMATS.join(', ')}`, 'json,xlsx,csv')
    .option('--no-ai', 'rules engine only (offline, instant, no API key)')
    .addOption(new Option('--vision <mode>', 'send the PDF itself to Gemini: auto = scanned/garbled only').choices(['auto', 'always', 'never']).default('auto'))
    .option('-c, --concurrency <n>', 'PDFs processed in parallel', (v) => Math.max(1, Number(v) || 3), 3)
    .option('--no-cache', 'ignore the AI result cache')
    .option('--cache-dir <dir>', 'AI cache folder', '.invoice-cache')
    .option('--password <pw>', 'password for protected PDFs')
    .option('--accounting <statuses>', 'statuses exported to xero/quickbooks files', 'ok')
    .option('--webhook <url>', 'POST each result as JSON (or WEBHOOK_URL)')
    .option('--simulate-outage <providers>', 'make providers fail (demo the fallback), e.g. gemini')
    .option('-v, --verbose', 'show info checks and AI errors');

async function runExtract(inputs, opts, { title } = {}) {
  const paths = await collectPdfs(inputs, { recursive: opts.recursive });
  if (!paths.length) {
    console.error('No PDF files found.');
    process.exitCode = 1;
    return [];
  }
  const ai = opts.ai ? makeAi(opts, { quiet: opts.json }) : null;
  if (opts.ai && !ai.enabledCount && !opts.json) console.error(c.yellow('No AI key set (GEMINI_API_KEY...): using the rules engine only. Scanned PDFs need AI vision.'));
  const formats = parseList(opts.format);
  const outDir = resolve(opts.out);
  const webhook = opts.webhook || process.env.WEBHOOK_URL;
  if (!opts.json) {
    if (title) console.log(c.bold(title));
    console.log(c.dim(`${paths.length} PDF(s) · AI: ${opts.ai ? (ai.enabledCount ? `${ai.enabledCount} model(s) in chain` : 'none') : 'off'} · vision: ${opts.vision}\n`));
  }
  const results = await processBatch(paths, {
    ai,
    useAi: opts.ai,
    vision: opts.vision,
    concurrency: opts.concurrency,
    password: opts.password,
    cache: opts.cache ? createCache(resolve(opts.cacheDir)) : null,
    log: (m) => !opts.json && console.error(c.dim(m)),
  });
  // processBatch flags duplicates after all files finish, so print afterwards in input order.
  if (!opts.json) for (const r of results) printResult(r, opts);
  if (webhook) {
    for (const r of results) {
      const w = await postWebhook(webhook, webhookPayload(r), { secret: process.env.WEBHOOK_SECRET });
      if (!w.ok && !opts.json) console.error(c.yellow(`webhook failed for ${r.file}: ${w.status || w.error}`));
    }
  }
  const written = formats.length ? await exportAll(results, outDir, { formats, accountingStatuses: parseList(opts.accounting) }) : [];
  if (opts.json) process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : results, null, 2) + '\n');
  else printSummary(results, written, outDir);
  if (opts.failOnReview && results.some((r) => r.validation.status !== 'ok')) process.exitCode = 2;
  return results;
}

commonExtract(program.command('extract').argument('<inputs...>', 'PDF files and/or folders').description('extract invoices to JSON / Excel / CSV'))
  .option('-r, --recursive', 'include sub-folders')
  .option('--json', 'print result JSON to stdout (for scripts); still writes --format files')
  .option('--fail-on-review', 'exit code 2 if any invoice is not ok (CI / automation)')
  .action((inputs, opts) => runExtract(inputs, opts));

commonExtract(program.command('demo').description('build 5 sample invoices (US, DE, UK, IN, scanned) and extract them'))
  .option('--dir <dir>', 'where to write the sample PDFs', 'examples/invoices')
  .action(async (opts) => {
    const { writeSamples } = await import('../src/demo/samples.js');
    const dir = resolve(opts.dir);
    await writeSamples(dir);
    if (opts.out === 'output') opts.out = 'output/demo';
    await runExtract([dir], opts, { title: `Demo: 5 sample invoices in ${relative(process.cwd(), dir) || dir}` });
  });

program
  .command('watch')
  .argument('<inbox>', 'folder to watch for new PDFs')
  .description('hot folder: extract every PDF dropped in, rebuild reports, move to processed/<status>/')
  .option('-o, --out <dir>', 'output folder', 'output')
  .option('-f, --format <list>', 'formats', 'json,xlsx,csv')
  .option('--no-ai', 'rules engine only')
  .option('--vision <mode>', 'auto | always | never', 'auto')
  .option('--no-move', 'leave PDFs in the inbox')
  .option('--accounting <statuses>', 'statuses exported to xero/quickbooks', 'ok')
  .option('--webhook <url>', 'POST each result (or WEBHOOK_URL)')
  .option('--cache-dir <dir>', 'AI cache folder', '.invoice-cache')
  .option('--simulate-outage <providers>', 'demo the fallback')
  .action(async (inbox, opts) => {
    const { watchFolder } = await import('../src/watch.js');
    const formats = parseList(opts.format);
    await watchFolder(resolve(inbox), {
      outDir: resolve(opts.out),
      formats: formats.includes('json') ? formats : ['json', ...formats],
      accountingStatuses: parseList(opts.accounting),
      move: opts.move,
      webhook: opts.webhook || process.env.WEBHOOK_URL,
      webhookSecret: process.env.WEBHOOK_SECRET,
      ai: opts.ai ? makeAi(opts) : null,
      useAi: opts.ai,
      vision: opts.vision,
      cache: createCache(resolve(opts.cacheDir)),
    });
  });

program
  .command('serve')
  .description('HTTP API: POST /api/extract (raw PDF or {base64}), GET /health')
  .option('-p, --port <n>', 'port', process.env.PORT || '3000')
  .option('--host <host>', 'host', process.env.HOST || '127.0.0.1')
  .option('--cache-dir <dir>', 'AI cache folder', '.invoice-cache')
  .option('--simulate-outage <providers>', 'demo the fallback')
  .action(async (opts) => {
    const { createApp } = await import('../src/server.js');
    const ai = makeAi(opts);
    const app = createApp({ ai, cache: createCache(resolve(opts.cacheDir)), apiKey: process.env.API_KEY, log: (m) => console.log(m) });
    app.listen(Number(opts.port), opts.host, () => {
      console.log(`Invoice API on http://${opts.host}:${opts.port}  (AI models: ${ai.enabledCount}, API key: ${process.env.API_KEY ? 'required' : 'OFF - set API_KEY before exposing it'})`);
      console.log(c.dim(`  curl -X POST --data-binary @invoice.pdf -H "content-type: application/pdf" http://${opts.host}:${opts.port}/api/extract`));
    });
  });

program
  .command('export')
  .description('rebuild Excel / CSV / accounting files from <out>/json (after hand-fixing a JSON)')
  .option('-o, --out <dir>', 'output folder holding json/', 'output')
  .option('-f, --format <list>', 'formats', 'xlsx,csv')
  .option('--accounting <statuses>', 'statuses exported to xero/quickbooks', 'ok')
  .action(async (opts) => {
    const outDir = resolve(opts.out);
    const results = await loadResults(outDir);
    if (!results.length) return console.error(`No results in ${join(outDir, 'json')}`);
    const written = await exportAll(results, outDir, { formats: parseList(opts.format), accountingStatuses: parseList(opts.accounting) });
    printSummary(results, written, outDir);
  });

program
  .command('doctor')
  .description('show the AI model chain and (with --ping) test each configured model')
  .option('--ping', 'send a tiny request to every configured model')
  .option('--simulate-outage <providers>', 'demo the fallback')
  .action(async (opts) => {
    const ai = makeAi(opts, { quiet: true });
    console.log(c.bold('AI chain') + c.dim(` (AI_CHAIN or default: ${DEFAULT_CHAIN.length} entries)`));
    for (const t of ai.status()) {
      let line = `  ${t.enabled ? c.green('●') : c.dim('○')} ${pad(t.id, 48)} ${t.enabled ? '' : c.dim(t.disabledReason)}`;
      if (opts.ping && t.enabled) {
        try {
          const r = await ai.generate({ only: t.id, messages: [{ role: 'user', content: 'Reply with the JSON {"ok":true}' }], json: true, maxTokens: 1024, parse: (x) => JSON.parse(x.replace(/^```(json)?|```$/g, '')) });
          line += c.green(`ok ${r.ms} ms`);
        } catch (err) {
          line += c.red(`${err.attempts?.[0]?.kind || 'error'}: ${String(err.attempts?.[0]?.error || err.message).slice(0, 80)}`);
        }
      }
      console.log(line);
    }
    if (!ai.enabledCount) console.log(c.yellow('\nNo AI key configured: extraction uses the rules engine (no scanned PDFs). Run `invoice-extractor init` and add GEMINI_API_KEY.'));
  });

program
  .command('init')
  .description('write a .env template in the current folder')
  .action(async () => {
    const target = join(process.cwd(), '.env');
    if (existsSync(target)) return console.log('.env already exists - not overwritten.');
    const { readFile } = await import('node:fs/promises');
    await writeFile(target, await readFile(join(ROOT, '.env.example'), 'utf8'));
    console.log(`Wrote ${target}. Add GEMINI_API_KEY (https://aistudio.google.com/apikey).`);
  });

program
  .command('schema')
  .description('print the JSON shape of an extracted invoice')
  .action(() => console.log(JSON.stringify(AI_SHAPE, null, 2)));

program.parseAsync().catch(async (err) => {
  console.error(c.red(`Error: ${err.message}`));
  process.exitCode = 1;
});

