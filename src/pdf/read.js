import { createHash } from 'node:crypto';

/**
 * Read a PDF: text per page (pdf-parse v2 / pdf.js), SHA-256, and a verdict on whether the
 * text layer is usable. Scanned pages (no text) or garbled text layers (broken font encodings
 * that turn into symbol soup) are routed to AI vision instead.
 */
export class PdfError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** 0..1 share of characters that look like real words/numbers. */
export function textQuality(text) {
  const s = String(text || '').replace(/\s+/g, '');
  if (!s.length) return 0;
  const good = (s.match(/[\p{L}\p{N}.,:;%€$£₹\-/()#@&'"+]/gu) || []).length;
  const bad = (s.match(/[�\u0000-\u001F]|[-]/g) || []).length;
  return Math.max(0, (good - bad * 3) / s.length);
}

export async function readPdf(buffer, { password } = {}) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (buffer.subarray(0, 1024).indexOf('%PDF-') < 0) throw new PdfError('Not a PDF file (missing %PDF- header)', 'not_pdf');

  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer), ...(password ? { password } : {}) });
  let result;
  try {
    result = await parser.getText();
  } catch (err) {
    const msg = String(err?.message || err);
    if (/password/i.test(msg) || err?.name === 'PasswordException') throw new PdfError('PDF is password protected (use --password)', 'password');
    throw new PdfError(`Cannot read PDF: ${msg}`, 'corrupt');
  } finally {
    await parser.destroy().catch(() => {});
  }
  const pages = (result.pages || []).map((p) => ({ num: p.num, text: String(p.text || '').replace(/\r/g, '') }));
  const text = pages.map((p) => p.text).join('\n\n');
  const chars = text.replace(/\s/g, '').length;
  const emptyPages = pages.filter((p) => p.text.replace(/\s/g, '').length < 30).length;
  const quality = textQuality(text);
  const scanned = pages.length > 0 && (chars < 40 * pages.length || emptyPages / pages.length > 0.5);
  const garbled = !scanned && quality < 0.75;
  return { sha256, bytes: buffer.length, pages: pages.length, pageTexts: pages, text, chars, quality: Math.round(quality * 100) / 100, scanned, garbled };
}
