/**
 * /api/documents — Zara document tools (right-side Zara panel).
 *
 *   POST /create   { format, prompt, history?, title? }  → AI writes the content, then renders it
 *   POST /convert  { format, markdown? | text?, file?, title? } → no AI: render given text/file as-is
 *   POST /extract  { file }                              → Markdown text of an uploaded file
 *
 * format: 'pdf' | 'docx' | 'pptx'. File results come back as base64 so nothing
 * is written to disk (Render wipes it) and the browser offers the download.
 */
const express = require('express');
const { requireUser } = require('../auth/session');
const { renderDocument } = require('./render');
const { fileToMarkdown, textToMarkdown } = require('./extract');
const { cleanModelMarkdown } = require('./markdown');

const FORMATS = ['pdf', 'docx', 'pptx'];
const MAX_TEXT = 200_000;

const WRITER_RULES = {
  pdf: `Write a complete, well-structured document in Markdown.
- Start with one "# Title" line.
- Use "## " section headings, short paragraphs, "- " bullet lists and "1. " numbered lists.
- Use a Markdown table only when the content is tabular.
- Write real, specific content. No placeholders like "[Insert here]" unless the user asked for a template.`,
  docx: null, // same as pdf
  pptx: `Write a presentation in Markdown.
- Start with one "# Deck title" line, then one short subtitle sentence.
- Each slide starts with "## Slide title".
- Give each slide 3 to 6 short "- " bullets (max ~12 words each). A table is allowed when it helps.
- After a slide's bullets you may add one line "Notes: ..." with speaker notes.
- Aim for 6 to 10 slides unless the user asked for a number. End with a summary or next-steps slide.`,
};
WRITER_RULES.docx = WRITER_RULES.pdf;

function sendFile(res, r) {
  res.json({ filename: r.filename, mime: r.mime, format: r.format, title: r.title, size: r.buffer.length, data: r.buffer.toString('base64') });
}

function badFormat(format) {
  return !FORMATS.includes(String(format || '').toLowerCase());
}

function historyText(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-8).map((m) => {
    const c = Array.isArray(m.content) ? m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n') : String(m.content || '');
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: c.slice(0, 6000) };
  }).filter((m) => m.content.trim());
}

function createDocumentsRouter({ llm }) {
  const router = express.Router();
  router.use(requireUser);

  router.post('/create', async (req, res) => {
    const { format, prompt, history, title, sourceText } = req.body || {};
    if (badFormat(format)) return res.status(400).json({ error: 'format must be pdf, docx or pptx.' });
    const ask = String(prompt || '').trim().slice(0, 8000);
    if (!ask) return res.status(400).json({ error: 'Tell Zara what the document should be about.' });
    if (!llm) return res.status(503).json({ error: 'No AI model is configured.' });

    const fmt = format.toLowerCase();
    const label = { pdf: 'PDF document', docx: 'Word document', pptx: 'PowerPoint presentation' }[fmt];
    const messages = [
      { role: 'system', content: `You are Zara, Aculyze's AI copilot, writing the content of a ${label} that will be generated from your Markdown.\n${WRITER_RULES[fmt]}\nReply with the Markdown only: no preamble, no closing remarks, no code fences around it.` },
      ...historyText(history),
    ];
    if (sourceText) messages.push({ role: 'user', content: `Source material for the document:\n\n${String(sourceText).slice(0, 40000)}` });
    messages.push({ role: 'user', content: `Create the ${label}: ${ask}` });

    try {
      const out = await llm.sendMessage({ messages, temperature: 0.4, max_tokens: 4000, thinking: false, timeoutMs: 120000 });
      const markdown = cleanModelMarkdown(out && out.content);
      if (!markdown) return res.status(502).json({ error: 'The AI model returned an empty document. Try again.' });
      const r = await renderDocument({ markdown, format: fmt, title: title || undefined });
      sendFile(res, r);
    } catch (err) {
      console.error('[documents] create failed:', err.message);
      res.status(500).json({ error: `Could not create the document: ${err.message}` });
    }
  });

  router.post('/convert', async (req, res) => {
    const { format, markdown, text, file, title } = req.body || {};
    if (badFormat(format)) return res.status(400).json({ error: 'format must be pdf, docx or pptx.' });
    try {
      let md;
      if (file && file.dataUrl) md = (await fileToMarkdown(file)).markdown;
      else if (markdown && String(markdown).trim()) md = String(markdown).slice(0, MAX_TEXT);
      else if (text && String(text).trim()) md = textToMarkdown(String(text).slice(0, MAX_TEXT), title || 'Document');
      else return res.status(400).json({ error: 'Nothing to convert. Paste text or attach a file.' });
      const r = await renderDocument({ markdown: md, format: format.toLowerCase(), title: title || undefined });
      sendFile(res, r);
    } catch (err) {
      res.status(400).json({ error: err.message || 'Conversion failed.' });
    }
  });

  router.post('/extract', async (req, res) => {
    try {
      const r = await fileToMarkdown((req.body || {}).file);
      res.json({ markdown: r.markdown.slice(0, MAX_TEXT), title: r.title, kind: r.kind, pages: r.pages, truncated: !!r.truncated });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Could not read the file.' });
    }
  });

  return router;
}

module.exports = { createDocumentsRouter };
