import { AI_SHAPE, SCHEMA_VERSION } from '../schema.js';

/**
 * AI extraction over the multi-model fallback router.
 *  - text mode:   the PDF's text layer goes to any model in the chain
 *  - vision mode: the PDF itself goes to Gemini (scanned / image-only / garbled text layers);
 *                 non-Gemini providers refuse file input instantly and the router moves on
 * If a model returns JSON that is not an invoice, `parse` throws and the NEXT model is tried.
 */

export const PROMPT_VERSION = `v${SCHEMA_VERSION}`;
const MAX_TEXT_CHARS = 60_000; // ~15k tokens: enough for 20+ page invoices
const MAX_INLINE_BYTES = 18 * 1024 * 1024; // Gemini inline request limit is 20 MB

export const SYSTEM_PROMPT = `You are an accounts-payable data extraction engine. You read one invoice-like document and return ONE JSON object with exactly this shape:
${JSON.stringify(AI_SHAPE, null, 1)}

Rules:
- Extract only what is printed. Never invent or calculate a value that is not on the document, except: lineItems[].amount may be quantity x unitPrice when the document clearly shows both but the amount column is unreadable. Use null for anything missing.
- vendor = the company that ISSUED the invoice and gets paid (letterhead, "From", bank details). customer = "Bill to" / "Invoice to" / "Rechnungsempfänger" / "Client". Do not swap them.
- Numbers: plain JSON numbers, no currency symbols, no thousands separators. Read the document's own convention: "1.234,56" is 1234.56, "1,234.56" is 1234.56, "2,22,000.00" is 222000. Negative for credits and discount lines inside lineItems.
- Dates: ISO YYYY-MM-DD. Decide day/month order from the document's country and other dates on it (US documents are month-first; most others day-first; dotted dates are day-first).
- taxId: exactly as printed (VAT / USt-IdNr / TVA / NIF / P.IVA / BTW / GSTIN / ABN / TRN / EIN / Tax ID), keep the country prefix.
- lineItems: one entry per billable row, in order, across ALL pages. Merge descriptions that wrap onto several lines. Skip repeated headers, page footers, and subtotal/total rows. taxRate is a percent (20, not 0.2).
- taxes: one entry per tax line printed in the totals area (e.g. VAT 19% and VAT 7%, or CGST + SGST), with its base if printed.
- totals.total is the gross invoice total (after tax). totals.amountDue is what is still to pay. discount is a positive number.
- documentType: credit_note for credit notes / Gutschrift / avoir; proforma for pro-forma; receipt for paid receipts.
- Output JSON only, no markdown, no comments.`;

export function buildPrompt({ text, fileName, pages, vision }) {
  const body = vision
    ? text && text.trim().length > 50
      ? `The PDF is attached. Its (possibly incomplete or garbled) text layer is below for reference; trust the PDF image when they disagree.\n\n<text>\n${text.slice(0, MAX_TEXT_CHARS)}\n</text>`
      : 'The PDF is attached (scanned / image only). Read it visually.'
    : `<document>\n${text.slice(0, MAX_TEXT_CHARS)}\n</document>${text.length > MAX_TEXT_CHARS ? '\n(Document truncated: extract what is visible.)' : ''}`;
  return `File: ${fileName || 'invoice.pdf'} (${pages || '?'} page${pages === 1 ? '' : 's'})\n\n${body}\n\nReturn the JSON object now.`;
}

/** Parse model output; throw (so the router tries the next model) if it is not invoice data. */
export function parseAiJson(raw, { allowEmpty = false } = {}) {
  let t = String(raw || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in output');
  const obj = JSON.parse(t.slice(start, end + 1));
  if (Array.isArray(obj) || typeof obj !== 'object') throw new Error('JSON is not an object');
  const data = obj.invoice && typeof obj.invoice === 'object' ? obj.invoice : obj;
  const hasSomething = data.invoiceNumber || data.invoice_number || data.totals?.total != null || (Array.isArray(data.lineItems) && data.lineItems.length) || data.vendor?.name;
  // Text mode: an empty answer usually means a lazy model, so try the next one. Vision mode:
  // a blank or non-invoice scan honestly has no fields; do not burn the whole chain on it.
  if (!hasSomething && !allowEmpty) throw new Error('JSON has no invoice fields');
  return data;
}

/**
 * @param ai      router from createRouterFromEnv
 * @param opts    { text, pdf (Buffer), pages, fileName, vision (bool), signal }
 * @returns {Promise<{ data, model, attempts, ms }>}
 */
export async function extractWithAi(ai, { text = '', pdf, pages, fileName, vision = false, signal }) {
  if (vision) {
    if (!pdf) throw new Error('vision mode needs the PDF bytes');
    if (pdf.length > MAX_INLINE_BYTES) throw new Error(`PDF is ${(pdf.length / 1048576).toFixed(1)} MB; vision mode accepts up to 18 MB`);
  }
  const message = { role: 'user', content: buildPrompt({ text, fileName, pages, vision }) };
  if (vision) message.files = [{ mimeType: 'application/pdf', data: pdf.toString('base64') }];
  const r = await ai.generate({
    system: SYSTEM_PROMPT,
    messages: [message],
    json: true,
    temperature: 0,
    maxTokens: 8192,
    parse: (t) => parseAiJson(t, { allowEmpty: vision }),
    signal,
  });
  return { data: r.data, model: r.target, attempts: r.attempts, ms: r.totalMs };
}
