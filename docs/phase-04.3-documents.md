# Phase 04.3: Zara documents (PDF, Word, PowerPoint)

Zara can create, convert and read documents from the right-side Zara panel.

## What users can do

| User says (in the Zara panel) | Result |
|---|---|
| "Create a PDF about our Q4 sales plan" | Zara writes the content; a PDF download card appears |
| "Make a PPT on AI agents with 8 slides" | PowerPoint deck: title slide, one slide per section, speaker notes |
| "I need a Word document for employee onboarding" | Word (.docx) file |
| "Convert this text to PDF:" + text on the next lines | That text as a PDF, without rewriting |
| "Export the above answer as a Word file" | Zara's last answer as a file |
| Attach a file + "convert to word" / "convert to pdf" | File converted as-is |
| Attach a file + "make a presentation summarising this" | Zara reads the file and writes new slides from it |
| Attach a file + any question ("what is this about?") | Zara reads the file and answers from it |

Also:
- **Create** button in the composer: PDF, Word, PowerPoint, Text to PDF, Convert a file.
- **Download icon on every answer**: PDF / Word / PowerPoint of that answer.
- Attaching a PDF to an already-PDF request gets a polite "already a PDF" reply.

## Supported files

| Read (attach) | Write (create) |
|---|---|
| PDF, Word .docx, PowerPoint .pptx, .txt, .md, .csv, .html | PDF, Word .docx, PowerPoint .pptx |

Not supported: scanned (image-only) PDFs, password-protected PDFs, old .doc / .ppt. Each one gets a clear message.

## How it works

```
Zara panel (aculyze-studio.js)
  detectDocumentRequest()  → create | convertFile | createFromFile | convertText | convertPrev
  runDocumentJob()         → /api/documents/*  → download card on the reply
        │
src/documents/
  routes.js    POST /create (AI writes Markdown) · /convert (no AI) · /extract (file → Markdown)
  markdown.js  Markdown → blocks (headings, lists, tables, code, quotes)
  render.js    blocks → PDF (pdfkit) · DOCX (docx) · PPTX (pptxgenjs), Aurora indigo styling
  extract.js   file → Markdown: DOCX (mammoth), PPTX (slide XML via jszip), CSV, TXT, HTML
  pdfRead.js   PDF → Markdown (unpdf / pdf.js)
```

- Everything is pure JavaScript, so it runs on Render with no LibreOffice, Python or headless browser.
- Files are returned as base64 and never written to disk (Render wipes it). Generated files up to about 500 KB are saved with the chat in the browser; bigger ones stay downloadable until the page is reloaded.
- All `/api/documents` routes require sign-in.
- `/create` uses the same AI provider as Zara (`provider.sendMessage`, thinking off, 2-minute timeout).

### PDF reading (`pdfRead.js`)

pdf.js only gives positioned text runs, so structure is rebuilt from layout:
- Runs on the same baseline form a line; wide gaps split a line into cells.
- Lines that are at least 1.6×, 1.25× or 1.1× the body font size become `#`, `##` and `###` headings.
- Lines starting with •, -, ▪ … become bullets (indented ones are nested); "1." and "a)" stay numbered.
- Consecutive lines with the same column positions become a Markdown table.
- Lines join into paragraphs until a vertical gap or a change of type, including across page breaks, and hyphenated words are re-joined.
- Text repeated at the top or bottom of most pages (headers, footers, "Page 3 of 9") is dropped.
- Limits: 300 pages, 400,000 characters. When answering a question, Zara sends the first 40,000 characters of each file and tells the model if the file was cut.

The approach was inspired by `chat_with_X_tutorials/chat_with_pdf` in Shubhamsaboo/awesome-llm-apps (Apache-2.0); no code was copied.

## Known limits

- **PDF output only shows Latin characters** (pdfkit's built-in fonts). Tamil and emoji are dropped and ₹ becomes "Rs.". Word and PowerPoint output keep all characters. Fix later by bundling a Unicode font.
- Reading complex PDF layouts (multi-column pages, rotated text, forms) gives readable text, not perfect structure.
- Scanned PDFs need OCR, which is not built.

## Tests

`node test/documents.test.js` (19 checks): Markdown parsing, all three renderers, reading PDF/DOCX/PPTX/CSV/TXT back, PDF → Word round trip, multi-page header/footer removal, scanned and damaged PDF errors, and the routes (sign-in, validation, create, convert, extract).

## Deploying

New npm packages: `pdfkit`, `docx`, `pptxgenjs`, `mammoth`, `jszip`, `unpdf`. Render installs them on deploy. **Restart the local server** after pulling: a server started before this code existed answers `/api/documents` with 404, which used to show as "Something went wrong" and now shows "restart the server".
