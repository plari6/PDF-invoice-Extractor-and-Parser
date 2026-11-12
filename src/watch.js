import { watch } from 'node:fs';
import { mkdir, readdir, rename, stat, copyFile, unlink } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { processFile } from './pipeline.js';
import { exportAll, loadResults, writeJson } from './export/index.js';
import { flagDuplicates } from './validate.js';
import { postWebhook, webhookPayload } from './notify.js';

/**
 * Hot folder: drop PDFs into `inbox` (from email rules, a scanner, Dropbox/OneDrive sync...)
 * and each one is extracted, validated, exported, optionally posted to a webhook and moved to
 * inbox/processed/<ok|review|failed>/. Reports in `outDir` are rebuilt after every invoice.
 */
async function waitStable(path, { tries = 20, intervalMs = 500 } = {}) {
  let last = -1;
  for (let i = 0; i < tries; i++) {
    const s = await stat(path).catch(() => null);
    if (!s) return false;
    if (s.size > 0 && s.size === last) return true;
    last = s.size;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return true;
}

async function move(src, destDir) {
  await mkdir(destDir, { recursive: true });
  let dest = join(destDir, basename(src));
  if (await stat(dest).catch(() => null)) dest = join(destDir, `${Date.now()}-${basename(src)}`);
  try {
    await rename(src, dest);
  } catch {
    await copyFile(src, dest);
    await unlink(src);
  }
  return dest;
}

export async function watchFolder(inbox, { outDir, formats, accountingStatuses, move: doMove = true, webhook, webhookSecret, log = console.log, signal, ...opts }) {
  await mkdir(inbox, { recursive: true });
  const busy = new Set();
  let chain = Promise.resolve();

  const handle = (name) => {
    if (extname(name).toLowerCase() !== '.pdf' || busy.has(name)) return;
    busy.add(name);
    chain = chain
      .then(async () => {
        const path = join(inbox, name);
        if (!(await waitStable(path))) return;
        const r = await processFile(path, opts);
        const previous = await loadResults(outDir);
        flagDuplicates([...previous.filter((p) => p.file !== r.file), r]);
        await writeJson([r], outDir);
        const all = await loadResults(outDir);
        await exportAll(all, outDir, { formats: formats.filter((f) => f !== 'json'), accountingStatuses });
        const t = r.invoice?.totals?.total;
        log(`${r.validation.status.toUpperCase().padEnd(6)} ${name}  ${r.invoice?.invoiceNumber || '-'}  ${t ?? '-'} ${r.invoice?.currency || ''}  (${r.source}${r.model ? ` ${r.model}` : ''})`);
        if (webhook) {
          const w = await postWebhook(webhook, webhookPayload(r), { secret: webhookSecret });
          if (!w.ok) log(`  webhook failed: ${w.status || w.error}`);
        }
        if (doMove) await move(path, join(inbox, 'processed', r.validation.status));
      })
      .catch((err) => log(`ERROR  ${name}: ${err.message}`))
      .finally(() => busy.delete(name));
  };

  for (const f of await readdir(inbox)) handle(f);
  const watcher = watch(inbox, (event, name) => name && handle(name));
  signal?.addEventListener('abort', () => watcher.close());
  log(`Watching ${inbox} for PDFs (Ctrl+C to stop). Reports: ${outDir}`);
  return { close: () => watcher.close(), idle: () => chain };
}
