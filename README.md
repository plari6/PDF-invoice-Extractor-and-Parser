# PDF Invoice Extractor & Parser

Turn messy PDF invoices into **validated** JSON, Excel and accounting CSV: line items, tax IDs, VAT/GST breakdown and totals. It handles native PDFs, scanned PDFs and invoices from many countries.

```
OK     acme-cloud-INV-2026-0142.pdf       INV-2026-0142      Acme Cloud Services, Inc.       4,487.90 USD  100%  ai gemini:gemini-3.6-flash
OK     mueller-RE-2026-0815.pdf           RE-2026-0815       Müller Maschinenbau GmbH        4,173.62 EUR  100%  ai gemini:gemini-3.6-flash
OK     scanned-facture-FA-2026-1187.pdf   FA-2026-1187       Atelier Lumière SARL            8,162.40 EUR   95%  ai gemini:gemini-3-flash-preview
OK     shree-ganesh-gst-0458.pdf          SGT/2026-27/0458   Shree Ganesh Textiles Pvt…    409,500.00 INR  100%  ai gemini:gemini-3.6-flash
REVIEW techparts-uk-TP-24-00917.pdf       TP/24/00917        TechParts UK Ltd                3,251.53 GBP   75%  ai gemini:gemini-3.5-flash
       ✗ Total printed 3251.53 but subtotal 2982.9 - discount 298.29 + tax 536.92 = 3221.53 (difference 30)
```

**Stack:** JavaScript (Node.js ESM): a CLI plus a small HTTP API. The AI runs over plain HTTP, so no Python OCR stack is needed. Scanned PDFs are read by Gemini's document vision.

## What it does

1. **Reads the PDF.** pdf-parse (pdf.js) extracts the text of each page. Scanned or garbled pages are detected automatically.
2. **Extracts the fields.**
   - **AI (text mode):** the text goes through a multi-model fallback chain. Gemini models are tried first, then Groq, NVIDIA, OpenRouter and Ollama, with timeouts, cooldowns and hedging.
   - **AI (vision mode):** for scanned or image-only PDFs, the PDF file itself is sent to Gemini.
   - **Rules engine:** a multilingual, offline engine (EN/DE/FR/ES/IT/NL). It is the fallback when every AI model is down, fills fields the AI missed, and gives a second opinion on the total.
3. **Validates.** This is what makes the output safe to import:
   - **Arithmetic:** quantity × unit price = amount on every line; lines add up to the subtotal; subtotal − discount + tax + shipping = total; tax = rate × base; total − paid = amount due.
   - **Tax ID checksums:** DE, GB, FR, IT and BE VAT, India GSTIN, Australian ABN, Swiss UID and Canadian BN. US EIN, UAE TRN, KSA VAT and all other EU VAT formats get a format check.
   - **IBAN:** mod-97 check. A bad IBAN is flagged before anyone pays.
   - **Grounding:** every total the AI returns must actually be printed on the PDF. This catches hallucinated or calculated numbers.
   - **Dates:** due date before invoice date, future dates, day/month swaps.
   - **Duplicates:** the same vendor and invoice number, or the same file twice, in one batch.
   - **Compliance hints:** VAT charged without a supplier VAT number; reverse-charge notes.
4. **Scores and routes.** Every invoice gets a confidence score from 0 to 100 and one of three statuses:
   - `ok`: import automatically.
   - `review`: a person should check it.
   - `failed`: nothing usable was extracted.
5. **Exports:**
   - `invoices.xlsx` with five sheets: Summary, Invoices, Line Items, Taxes and Checks. Headers are frozen, filters are on, status cells are coloured and each invoice links back to its PDF.
   - JSON: one file per invoice plus a combined file.
   - CSV.
   - `xero-bills.csv` and `quickbooks-bills.csv`. These contain only `ok` invoices by default. Discount and shipping become their own lines so that the bill totals match the PDF.

Messy inputs it handles:
- **Number formats:** `1.234,56`, `1 234,56`, `1'234.50`, `2,22,000.00` (lakh), `(1,200.00)`, `1.200,00-`, `150.00 CR`.
- **Dates:** month names in six languages, and US month-first versus day-first dates.
- **Layout:** wrapped descriptions, multi-page tables with repeated headers, SKUs, units, per-line VAT rates, mixed VAT rates (19% + 7%), and CGST + SGST.
- **Document types:** credit notes, pro-formas and receipts.

## Quick start

```bash
npm install
node bin/invoice-extractor.js demo --no-ai      # 5 sample invoices, offline, no key needed
node bin/invoice-extractor.js init              # writes .env: add GEMINI_API_KEY
node bin/invoice-extractor.js demo              # same samples with AI, including the scanned one
node bin/invoice-extractor.js extract ./invoices -o ./output -f json,xlsx,csv,xero
```

The sample invoices are:
- a US SaaS invoice (EIN, sales tax);
- a German Rechnung (USt-IdNr, 19% + 7% MwSt, IBAN);
- a UK invoice over two pages with a deliberate £30 error in the total;
- an Indian GST invoice (GSTIN, CGST + SGST, lakh amounts);
- a **scanned French facture** that is only an image, with no text layer.

## Commands

```bash
invoice-extractor extract <files|folders...> [options]
  -o, --out <dir>            output folder (default ./output)
  -f, --format <list>        json,xlsx,csv,xero,quickbooks (default json,xlsx,csv)
  --no-ai                    rules engine only: offline, instant, free
  --vision auto|always|never send the PDF itself to Gemini (auto = scanned/garbled only)
  -c, --concurrency <n>      PDFs in parallel (default 3)
  -r, --recursive            include sub-folders
  --accounting ok,review     statuses that go into the Xero/QuickBooks files (default ok)
  --webhook <url>            POST every result as JSON (Zapier / Make / n8n / ERP)
  --json                     print the result JSON to stdout
  --fail-on-review           exit code 2 if any invoice is not ok (for pipelines)
  --password <pw>            password-protected PDFs
  --no-cache                 ignore the AI cache (.invoice-cache, keyed by PDF hash)
  --simulate-outage gemini   demo the fallback chain
  -v, --verbose              show info checks and AI errors

invoice-extractor watch <inbox>   # hot folder: extract, rebuild reports, move to processed/<ok|review|failed>/
invoice-extractor serve           # HTTP API (below)
invoice-extractor export          # rebuild xlsx/csv/xero from output/json after hand-fixing a JSON
invoice-extractor doctor --ping   # test every AI model in the chain
invoice-extractor schema          # print the JSON shape
```

## HTTP API (for n8n / Make / Zapier / an ERP)

```bash
API_KEY=change-me node bin/invoice-extractor.js serve --host 0.0.0.0 -p 3000

curl -X POST "http://localhost:3000/api/extract?filename=inv.pdf" \
  -H "x-api-key: change-me" -H "content-type: application/pdf" --data-binary @inv.pdf

# or JSON: {"filename": "inv.pdf", "base64": "<pdf base64>"}
# GET /health -> AI model states
```

The response is the same JSON as `output/json/<file>.json`. It holds `invoice`, `validation` (`status`, `confidence` and a list of `checks`), `source` (`ai`, `ai+rules` or `rules`), `mode` (`text` or `vision`) and `model`.

## Output example (trimmed)

```json
{
  "file": "mueller-RE-2026-0815.pdf",
  "source": "ai", "mode": "text", "model": "gemini:gemini-3.6-flash",
  "invoice": {
    "invoiceNumber": "RE-2026-0815", "invoiceDate": "2026-10-15", "dueDate": "2026-11-14", "currency": "EUR",
    "vendor": { "name": "Müller Maschinenbau GmbH", "taxId": "DE812345673", "taxIdType": "VAT", "taxIdCountry": "DE", "taxIdValid": true,
                "iban": "DE89 3704 0044 0532 0130 00", "ibanValid": true },
    "customer": { "name": "Schneider Logistik AG", "taxId": "DE298765435" },
    "lineItems": [{ "description": "Servicetechniker Einsatz vor Ort", "quantity": 6.5, "unit": "Std", "unitPrice": 95, "taxRate": 19, "amount": 617.5 }],
    "taxes": [{ "label": "MwSt 19%", "rate": 19, "base": 3417.5, "amount": 649.33 }, { "label": "MwSt 7%", "rate": 7, "base": 99.8, "amount": 6.99 }],
    "totals": { "subtotal": 3517.3, "tax": 656.32, "total": 4173.62 }
  },
  "validation": { "status": "ok", "confidence": 100, "checks": [{ "id": "math.total", "ok": true, "message": "Subtotal - discount + tax + shipping = total" }] }
}
```

## Configuration (.env)

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | First models in the chain. Also required for scanned PDFs (vision). |
| `GROQ_API_KEY`, `NVIDIA_API_KEY`, `OPENROUTER_API_KEY` | Free fallback models (text PDFs). |
| `OLLAMA_BASE_URL` | Local model: invoices never leave the machine. |
| `AI_CHAIN` | Your own order, e.g. `gemini:gemini-3.6-flash,groq:llama-3.3-70b-versatile`. |
| `AI_TIMEOUT_MS` / `AI_TOTAL_BUDGET_MS` / `AI_HEDGE_MS` | 45 s per model, 120 s per invoice, hedge after 25 s. |
| `WEBHOOK_URL`, `WEBHOOK_SECRET` | POST each result, signed with `x-signature: sha256=…`. |
| `API_KEY`, `HOST`, `PORT` | For `serve`. |
| `XERO_ACCOUNT_CODE`, `XERO_TAX_TYPE`, `XERO_DATE_FORMAT` | Xero import defaults (429, "Tax on Purchases", DD/MM/YYYY). |
| `QB_ACCOUNT`, `QB_DATE_FORMAT` | QuickBooks import defaults. |

For client work, use a **paid** Gemini key as the first model. On the free tier, Google may use your prompts (the invoice data) to improve its products, and daily limits are low. Keep the free providers behind it as redundancy.

## Architecture

```
bin/invoice-extractor.js   CLI (commander)
src/pdf/read.js            pdf-parse v2: text per page, SHA-256, scanned/garbled detection
src/pdf/write.js           tiny dependency-free PDF writer (demo + test fixtures)
src/extract/ai.js          prompt, JSON shape, text vs vision (PDF as inlineData), output validation
src/extract/rules.js       offline multilingual extraction (labels, totals, table rows, parties)
src/parse/numbers.js       amounts, decimal-style detection, currencies, dates
src/parse/taxid.js         tax ID detection + checksums, IBAN
src/schema.js              canonical invoice shape + normalizer
src/validate.js            math / grounding / ID / date / duplicate checks, confidence, status
src/pipeline.js            read -> AI (cached) -> rules fallback/merge -> validate; batch with concurrency
src/export/index.js        JSON, Excel (exceljs), CSV, Xero, QuickBooks
src/server.js              HTTP API (node:http)
src/watch.js               hot folder
src/ai/                    multi-model fallback router (Gemini, Groq, NVIDIA, OpenRouter, Ollama)
```

## Tests

```bash
npm test     # 61 tests, no network, no keys (fake AI providers)
```

The tests cover:
- number, date, currency and tax-ID parsing;
- the rules engine on every sample;
- fallback when a model returns bad JSON;
- a hallucinated total caught by grounding, arithmetic and the rules cross-check;
- vision routing, with the PDF sent only to Gemini;
- caching and duplicate detection;
- reading the Excel workbook back, the accounting CSVs, the HTTP API, the hot folder, webhooks and the CLI.

## Docker

```bash
docker build -t invoice-extractor .
docker run -p 3000:3000 -e GEMINI_API_KEY=... -e API_KEY=... invoice-extractor
docker run --rm -v "$PWD/inbox:/data" -e GEMINI_API_KEY=... invoice-extractor node bin/invoice-extractor.js extract /data -o /data/output
```

## Limits

- Assumes one invoice per PDF. A PDF holding several invoices is extracted as one document.
- Vision mode accepts PDFs up to 18 MB, the Gemini inline limit.
- Without an AI key, scanned PDFs fail with a clear reason. Text PDFs still work through the rules engine.
- Before the first import, check the Xero and QuickBooks column mappings (account codes, tax types) against the client's chart of accounts.

## License

MIT
