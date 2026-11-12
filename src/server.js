import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { processPdf } from './pipeline.js';

/**
 * Small HTTP API so n8n / Make / Zapier / an ERP can send a PDF and get JSON back.
 *   GET  /health                      -> { ok, ai: [{ id, state, avgMs }] }
 *   POST /api/extract                 -> body: raw PDF (Content-Type: application/pdf)
 *                                        or JSON { filename, base64 }
 *        ?filename=x.pdf&noAi=1&vision=auto|always|never
 * Protect it with API_KEY (x-api-key header or Bearer token). No dependencies (node:http).
 */
const MAX_BYTES = 25 * 1024 * 1024;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(Object.assign(new Error('PDF larger than 25 MB'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req, apiKey) {
  if (!apiKey) return true;
  const given = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(String(given));
  const b = Buffer.from(apiKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({ ai, cache, apiKey, maxConcurrent = 3, log = () => {} } = {}) {
  let active = 0;
  const queue = [];
  const acquire = () => (active < maxConcurrent ? (active++, Promise.resolve()) : new Promise((r) => queue.push(r)));
  const release = () => (queue.length ? queue.shift()() : active--);

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, aiConfigured: Boolean(ai?.enabledCount), ai: (ai?.status() || []).filter((t) => t.enabled).map(({ id, state, avgMs, lastErrorKind }) => ({ id, state, avgMs, lastErrorKind })) });
      }
      if (url.pathname !== '/api/extract') return send(res, 404, { error: 'Not found. Use POST /api/extract or GET /health' });
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (!authorized(req, apiKey)) return send(res, 401, { error: 'Missing or wrong API key' });

      const raw = await readBody(req);
      let pdf = raw;
      let fileName = url.searchParams.get('filename') || 'upload.pdf';
      if (/json/i.test(req.headers['content-type'] || '')) {
        const body = JSON.parse(raw.toString('utf8') || '{}');
        if (!body.base64) return send(res, 400, { error: 'JSON body needs { "base64": "<pdf>" }' });
        pdf = Buffer.from(body.base64, 'base64');
        fileName = body.filename || fileName;
      }
      if (!pdf.length) return send(res, 400, { error: 'Empty body: send the PDF bytes' });

      await acquire();
      try {
        const result = await processPdf(pdf, {
          fileName,
          ai,
          cache,
          useAi: !['1', 'true'].includes(url.searchParams.get('noAi') || ''),
          vision: url.searchParams.get('vision') || 'auto',
        });
        log(`[api] ${fileName} -> ${result.validation.status} (${result.source}${result.model ? ` ${result.model}` : ''}) ${result.ms} ms`);
        return send(res, result.validation.status === 'failed' && result.errorCode ? 422 : 200, result);
      } finally {
        release();
      }
    } catch (err) {
      return send(res, err.status || (err instanceof SyntaxError ? 400 : 500), { error: err.message });
    }
  });
}
