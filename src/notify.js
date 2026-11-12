import { createHmac } from 'node:crypto';

/**
 * POST each result to a webhook (Zapier / Make / n8n / your ERP). Optional HMAC-SHA256
 * signature in `x-signature` when WEBHOOK_SECRET is set. Never throws: delivery problems
 * are returned so the caller can log them.
 */
export async function postWebhook(url, payload, { secret, timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  if (!url) return { ok: false, skipped: true };
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json', 'user-agent': 'pdf-invoice-extractor' };
  if (secret) headers['x-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return { ok: true, status: res.status };
      if (res.status < 500 || attempt === 2) return { ok: false, status: res.status };
    } catch (err) {
      if (attempt === 2) return { ok: false, error: err.message };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false };
}

/** Compact payload: everything an automation needs without the raw text. */
export function webhookPayload(result) {
  return { event: result.validation?.status === 'failed' ? 'invoice.failed' : 'invoice.extracted', status: result.validation?.status, confidence: result.validation?.confidence, file: result.file, invoice: result.invoice, issues: (result.validation?.checks || []).filter((c) => !c.ok && c.level !== 'info').map((c) => c.message), source: result.source, model: result.model };
}
