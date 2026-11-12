/**
 * Minimal PDF 1.4 writer (no dependencies). It exists to build the demo invoices and the
 * test fixtures: text in Helvetica / Helvetica-Bold (WinAnsi, so €, £, ü, é work), lines and
 * filled rectangles. A page with only shapes and no text behaves like a scanned document.
 *
 * page = { items: [ { text, x, y, size?, bold? } | { line: [x1, y1, x2, y2] } | { rect: [x, y, w, h], gray? } ] }
 * Coordinates are PDF points from the bottom-left of an A4 page (595 x 842).
 */

const WIN_ANSI_EXTRA = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '–': 0x96, '—': 0x97, '™': 0x99 };

function encodeText(str) {
  let out = '';
  for (const ch of String(str)) {
    let code = WIN_ANSI_EXTRA[ch] ?? ch.charCodeAt(0);
    if (code > 255) code = 0x3f; // '?'
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (code < 32 || code > 126) out += '\\' + code.toString(8).padStart(3, '0');
    else out += ch;
  }
  return out;
}

function pageStream(page) {
  const ops = [];
  for (const it of page.items || []) {
    if (it.rect) {
      const [x, y, w, h] = it.rect;
      ops.push(`${it.gray ?? 0.85} g ${x} ${y} ${w} ${h} re f 0 g`);
    } else if (it.line) {
      const [x1, y1, x2, y2] = it.line;
      ops.push(`0.5 w ${x1} ${y1} m ${x2} ${y2} l S`);
    } else if (it.text !== undefined) {
      ops.push(`BT /${it.bold ? 'F2' : 'F1'} ${it.size || 10} Tf ${it.x} ${it.y} Td (${encodeText(it.text)}) Tj ET`);
    }
  }
  return ops.join('\n');
}

/** @returns {Buffer} */
export function buildPdf(pages, { title = 'Document' } = {}) {
  const objects = []; // index i -> object number i+1
  const add = (body) => objects.push(body) && objects.length;

  const catalog = add(null);
  const pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title (${encodeText(title)}) /Producer (pdf-invoice-extractor) >>`);
  const kids = [];
  for (const page of pages) {
    const stream = Buffer.from(pageStream(page), 'latin1');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream.toString('latin1')}\nendstream`);
    kids.push(
      add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * Convenience layout: rows of text lines top-down. Each row is a string or an array of
 * [x, text, opts] cells, so table columns line up like a real invoice.
 */
export function layoutPage(rows, { top = 800, lineHeight = 15, left = 50 } = {}) {
  const items = [];
  let y = top;
  for (const row of rows) {
    if (row === null) {
      y -= lineHeight / 2;
      continue;
    }
    if (row && row.hr) {
      items.push({ line: [left, y + 10, 545, y + 10] });
      continue;
    }
    const cells = typeof row === 'string' ? [[left, row]] : row;
    for (const [x, text, opts = {}] of cells) items.push({ text, x, y, ...opts });
    y -= lineHeight;
  }
  return { items };
}
