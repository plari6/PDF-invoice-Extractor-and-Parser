import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ExcelJS from 'exceljs';
import { samplePdfs } from '../src/demo/samples.js';
import { processPdf } from '../src/pipeline.js';
import { exportAll, toCsv, loadResults } from '../src/export/index.js';
import { createApp } from '../src/server.js';
import { watchFolder } from '../src/watch.js';
import { postWebhook } from '../src/notify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'invoice-extractor.js');
const PDFS = samplePdfs();
const TODAY = new Date('2026-11-12T12:00:00Z');
const tmp = (p) => mkdtemp(join(tmpdir(), p));

async function results() {
  const out = [];
  for (const [name, buf] of Object.entries(PDFS)) {
    const r = await processPdf(buf, { fileName: name, useAi: false, today: TODAY });
    r.path = join(tmpdir(), name);
    out.push(r);
  }
  return out;
}

test('exports: Excel workbook has 5 sheets with typed numbers and status colours', async () => {
  const dir = await tmp('inv-x-');
  const res = await results();
  const written = await exportAll(res, dir, { formats: ['json', 'xlsx', 'csv', 'xero', 'quickbooks'] });
  assert.ok(written.some((f) => f.endsWith('invoices.xlsx')));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(join(dir, 'invoices.xlsx'));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Invoices', 'Line Items', 'Taxes', 'Checks']);
  const inv = wb.getWorksheet('Invoices');
  const header = inv.getRow(1).values.slice(1);
  const totalCol = header.indexOf('Total') + 1;
  const statusCol = header.indexOf('Status') + 1;
  const totals = [];
  inv.eachRow((row, n) => n > 1 && totals.push(row.getCell(totalCol).value));
  assert.ok(totals.includes(4173.62));
  assert.equal(typeof totals[0], 'number');
  assert.ok(['ok', 'review', 'failed'].includes(inv.getRow(2).getCell(statusCol).value));
  assert.equal(wb.getWorksheet('Line Items').rowCount - 1, 5 + 4 + 5 + 2);
  const checks = [];
  wb.getWorksheet('Checks').eachRow((row, n) => n > 1 && checks.push(row.getCell(5).value));
  assert.ok(checks.includes('math.total'));

  const all = JSON.parse(await readFile(join(dir, 'invoices.json'), 'utf8'));
  assert.equal(all.summary.files, 4);
  assert.equal((await loadResults(dir)).length, 4);
});

test('accounting exports: only verified invoices, discount becomes its own line', async () => {
  const dir = await tmp('inv-acc-');
  await exportAll(await results(), dir, { formats: ['xero', 'quickbooks'] });
  const xero = await readFile(join(dir, 'xero-bills.csv'), 'utf8');
  assert.ok(!xero.includes('TP/24/00917'), 'invoice under review is not exported');
  assert.match(xero, /INV-2026-0142.*Discount,1,-217.45/);
  assert.match(xero, /03\/10\/2026/);
  const qb = await readFile(join(dir, 'quickbooks-bills.csv'), 'utf8');
  assert.match(qb, /RE-2026-0815,Müller Maschinenbau GmbH,10\/15\/2026/);
  const lines = qb.trim().split('\r\n');
  const acme = lines.filter((l) => l.startsWith('INV-2026-0142')).map((l) => Number(l.split(',').at(-3)));
  assert.equal(Math.round(acme.reduce((s, x) => s + x, 0) * 100) / 100, 4131.55, 'lines + discount = net of the PDF');
});

test('CSV quoting and BOM', () => {
  const csv = toCsv([{ a: 'x, "y"', b: 1.5 }], [{ header: 'A', value: (r) => r.a }, { header: 'B', value: (r) => r.b }]);
  assert.equal(csv, '﻿A,B\r\n"x, ""y""",1.5\r\n');
});

test('HTTP API: health, auth, raw PDF and base64 uploads', async () => {
  const app = createApp({ ai: null, apiKey: 'secret' });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal((await fetch(`${base}/api/extract`, { method: 'POST', body: PDFS['mueller-RE-2026-0815.pdf'] })).status, 401);
    const raw = await fetch(`${base}/api/extract?filename=m.pdf&noAi=1`, { method: 'POST', headers: { 'x-api-key': 'secret', 'content-type': 'application/pdf' }, body: PDFS['mueller-RE-2026-0815.pdf'] });
    assert.equal(raw.status, 200);
    const r = await raw.json();
    assert.equal(r.file, 'm.pdf');
    assert.equal(r.invoice.totals.total, 4173.62);
    const b64 = await fetch(`${base}/api/extract?noAi=1`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'gst.pdf', base64: PDFS['shree-ganesh-gst-0458.pdf'].toString('base64') }),
    });
    assert.equal((await b64.json()).invoice.totals.total, 409500);
    const bad = await fetch(`${base}/api/extract`, { method: 'POST', headers: { 'x-api-key': 'secret' }, body: 'not a pdf' });
    assert.equal(bad.status, 422);
  } finally {
    app.close();
  }
});

test('watch folder: processes PDFs, rebuilds reports, moves files by status', async () => {
  const inbox = await tmp('inv-in-');
  const out = await tmp('inv-out-');
  await writeFile(join(inbox, 'mueller.pdf'), PDFS['mueller-RE-2026-0815.pdf']);
  await writeFile(join(inbox, 'techparts.pdf'), PDFS['techparts-uk-TP-24-00917.pdf']);
  const logs = [];
  const w = await watchFolder(inbox, { outDir: out, formats: ['json', 'xlsx'], accountingStatuses: ['ok'], useAi: false, log: (m) => logs.push(m) });
  await w.idle();
  w.close();
  assert.deepEqual(await readdir(join(inbox, 'processed', 'ok')), ['mueller.pdf']);
  assert.deepEqual(await readdir(join(inbox, 'processed', 'review')), ['techparts.pdf']);
  assert.ok(await stat(join(out, 'invoices.xlsx')));
  assert.equal((await loadResults(out)).length, 2);
  assert.ok(logs.some((l) => l.startsWith('REVIEW')));
});

test('webhook: signed POST, retry on 5xx, never throws', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init);
    return new Response('', { status: calls.length === 1 ? 503 : 200 });
  };
  const r = await postWebhook('https://hook.example/x', { a: 1 }, { secret: 's', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].headers['x-signature'], /^sha256=[0-9a-f]{64}$/);
  const r2 = await postWebhook('https://hook.example/x', {}, { fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(r2.ok, false);
});

test('CLI: demo --no-ai, --json output, --fail-on-review exit code', async () => {
  const out = await tmp('inv-cli-');
  const env = { ...process.env, INVOICE_SKIP_DOTENV: '1', NO_COLOR: '1', GEMINI_API_KEY: '', GROQ_API_KEY: '', NVIDIA_API_KEY: '', OPENROUTER_API_KEY: '' };
  const demo = spawnSync(process.execPath, [CLI, 'demo', '--no-ai', '--dir', join(out, 'pdfs'), '-o', out, '-f', 'json,xlsx,csv,xero'], { env, encoding: 'utf8' });
  assert.equal(demo.status, 0, demo.stderr);
  assert.match(demo.stdout, /5 file\(s\): 3 ok, 1 to review, 1 failed/);
  assert.ok(await stat(join(out, 'xero-bills.csv')));

  const one = spawnSync(process.execPath, [CLI, 'extract', join(out, 'pdfs', 'mueller-RE-2026-0815.pdf'), '--no-ai', '--json', '-f', ''], { env, encoding: 'utf8' });
  assert.equal(one.status, 0, one.stderr);
  assert.equal(JSON.parse(one.stdout).invoice.totals.total, 4173.62);

  const strict = spawnSync(process.execPath, [CLI, 'extract', join(out, 'pdfs', 'techparts-uk-TP-24-00917.pdf'), '--no-ai', '--fail-on-review', '-o', out], { env, encoding: 'utf8' });
  assert.equal(strict.status, 2);

  const doctor = spawnSync(process.execPath, [CLI, 'doctor'], { env, encoding: 'utf8' });
  assert.match(doctor.stdout, /No AI key configured/);
});
