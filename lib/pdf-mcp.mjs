// `palm pdf-mcp`: Palm's PDF desk as a local MCP server over stdio (newline-delimited JSON-RPC). Yuzool PDF Tools' and
// Redact's own code runs on the user's machine in their Chrome; the files stay here (the page may only fetch from the
// site and the PDF libraries' CDN, never upload).
//   Claude Code:  claude mcp add palm-pdf -- npx -y github:pearcoderman/palm-cli pdf-mcp
// Paths are on this machine. Passwords come from the call or PALM_PDF_PASSWORD and are never echoed. Free: info, merge,
// extract, split, rotate, compress, passwords. Palm Pro (checked once a day): redact, sign request, sign check.
import { createInterface } from 'node:readline';
import * as P from './pdf.mjs';
import { callTool } from './client.mjs';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description }), bool = (description) => ({ type: 'boolean', description });
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WR = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const file = str('Path to the PDF on this machine');
const out = str('Where to write: a folder (default ./palm-pdf) or, for a one-file result, a path ending .pdf. manifest.json goes in the folder');
const password = str('The PDF\'s password, if it has one (or set PALM_PDF_PASSWORD). Never echoed');
const pages = str('Pages, e.g. "1-3,5"');
export const TOOLS = [
  { name: 'pdf_info', title: 'What is in a PDF', description: 'Pages, page sizes, whether each page has a text layer (a scan has none, so it can\'t be searched or redacted by words), password/encryption, document info, form fields, attachments, and whether it is a Yuzool signing request (who still has to sign). Free.', inputSchema: obj({ file, password }, ['file']), annotations: RO },
  { name: 'pdf_merge', title: 'Merge PDFs', description: 'Joins PDFs (and JPG/PNG photos, one per page) in the order given, with Yuzool PDF Tools\' own merge. Free.', inputSchema: obj({ files: { type: 'array', items: { type: 'string' }, description: 'Paths, in order' }, out, password, pageSize: { type: 'string', enum: ['fit', 'a4', 'letter'], description: 'How photos are placed (default fit)' } }, ['files']), annotations: WR },
  { name: 'pdf_extract', title: 'Pages into a new PDF', description: 'One new PDF with only the pages given (PDF Tools\' Extract). Free.', inputSchema: obj({ file, pages, out, password }, ['file', 'pages']), annotations: WR },
  { name: 'pdf_split', title: 'Split a PDF', description: 'One PDF per range ("1-3,4-6") or, with each, one per page (PDF Tools\' Split). Free.', inputSchema: obj({ file, pages: str('Ranges, e.g. "1-3,4-6": one file per range'), each: bool('One file per page instead'), out: str('Folder to write into (default ./palm-pdf)'), password }, ['file']), annotations: WR },
  { name: 'pdf_rotate', title: 'Rotate pages', description: 'Turns pages clockwise by 90, 180 or 270 degrees (all pages, or the ones given). Free.', inputSchema: obj({ file, by: { type: 'number', enum: [90, 180, 270] }, pages: str('Pages to turn (default all)'), out, password }, ['file']), annotations: WR },
  { name: 'pdf_compress', title: 'Make a PDF smaller', description: 'PDF Tools\' Compress: each page redrawn as a JPEG at the quality given. The text can no longer be selected. Refuses (and says so) when it wouldn\'t make the file smaller. Free.', inputSchema: obj({ file, quality: { type: 'string', enum: ['high', 'med', 'low'] }, out, password }, ['file']), annotations: WR },
  { name: 'pdf_password_add', title: 'Password-protect a PDF', description: 'Adds a password (AES-256, opens in Preview, Acrobat, Chrome and Edge), then checks the saved file opens with it and not without. Optionally asks PDF apps not to allow printing or copying. Free.', inputSchema: obj({ file, password: str('The new password (or set PALM_PDF_PASSWORD). Never echoed'), current: str('The input\'s current password, if it has one'), print: bool('Allow printing (default true)'), copy: bool('Allow copying text (default true)'), out }, ['file']), annotations: WR },
  { name: 'pdf_password_remove', title: 'Take a PDF\'s password off', description: 'Saves a copy that opens with no password. Needs the password (open or owner); PDFs with limits only need none. Free.', inputSchema: obj({ file, password, out }, ['file']), annotations: WR },
  { name: 'pdf_redact', title: 'Redact a PDF', description: 'Blacks out text with Yuzool Redact\'s own rules and rebuild: find emails, phone numbers, card numbers (Luhn-checked), IBANs, UK sort codes/NI numbers, US SSNs, postcodes, ZIP codes, dates, and/or exact words. Pages with boxes are rebuilt as pictures. The saved file is then VERIFIED as Redact does (its text, raw bytes, and words still showing on rebuilt pages) and searched again; if anything is still findable the file is NOT saved and the result says what. Reports what was blacked out (masked) and writes look.png: OPEN it before telling the user it\'s done. Palm Pro.', inputSchema: obj({ file, find: str(`Kinds, comma-separated: ${P.RULE_IDS.join(', ')}; "default" (${P.RULE_DEFAULT.join(', ')}) or "all"`), text: { type: 'array', items: { type: 'string' }, description: 'Exact words or phrases to black out wherever they appear (case-insensitive)' }, pages: str('Only these pages (anything also on other pages makes the check fail, on purpose)'), style: { type: 'string', enum: ['black', 'white', 'label'] }, label: { type: 'string', description: 'With style label: the words on each box, e.g. "Personal data" (default Redacted)' }, dpi: { type: 'number', enum: [150, 200, 300], description: 'Resolution of the rebuilt pages (default 200)' }, log: { type: 'boolean', description: 'Add a last page listing how many items were removed from each page (never what they were)' }, out: str('Folder (default ./palm-pdf)') }, ['file']), annotations: WR },
  { name: 'pdf_sign_request', title: 'Get a PDF signed', description: 'Yuzool PDF Tools\' Ask others to sign: makes "<title> - to sign.pdf" with each signer\'s boxes drawn in; the request travels inside the PDF, and signers open it at https://www.yuzool.com/sign (free, on their device), fill their boxes and Finish; the last copy gets a Signing record page with the original\'s SHA-256. Up to two signers. Boxes default to the bottom of the last page (look.png shows them; warns if one covers text); give boxes to place them. Writes .eml drafts with the file attached for the user to send: Palm never sends email. Palm Pro.', inputSchema: obj({ file, signers: { type: 'array', items: { type: 'string' }, description: '"Name <email>" in signing order (1 or 2)' }, from: str('The sender, "Name <email>" (where signed copies come back)'), title: str('What it is (default the file name)'), boxes: { type: 'array', items: { type: 'object' }, description: '[{page (1-based), kind: signature|initials|date|name|text|check, signer (1-based), x, y, w, h}] in points from the page\'s top left' }, anyOrder: bool('Everyone signs their own copy (combined later in PDF Tools) instead of one after another'), out: str('Folder (default ./palm-pdf)') }, ['file', 'signers', 'from']), annotations: WR },
  { name: 'pdf_sign_check', title: 'Check a signed PDF', description: 'Checks a returned copy as PDF Tools does: the original inside matches the request\'s fingerprint, who has filled their boxes and when, whether everyone has signed and the Signing record page is there; with original, that it is the document that was sent. It doesn\'t check who anyone is. Palm Pro.', inputSchema: obj({ file: str('The signed PDF'), original: str('The original (the "to sign" file, or original.pdf from pdf_sign_request, or the source PDF)'), out: str('Folder for manifest.json (default ./palm-pdf)') }, ['file']), annotations: RO },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
const PRO = new Set(['pdf_redact', 'pdf_sign_request', 'pdf_sign_check']);
export async function runTool(name, a = {}, { pro, impl = P } = {}) {
  if (!TOOLS.some((t) => t.name === name)) return text('Unknown tool: ' + name, true);
  if (PRO.has(name) && !(await pro())) return text('Redacting and signing requests are part of Palm Pro. Add a Palm Pro key (`palm login` or PALM_KEY); about Pro: https://www.yuzool.com/palm/#pro. pdf_info, merge, extract, split, rotate, compress and passwords are free.', true);
  const pw = impl.pw(a.password);
  const r = await (async () => {
    switch (name) {
      case 'pdf_info': return impl.info(a.file, { password: pw });
      case 'pdf_merge': return impl.merge(a.files, { out: a.out, password: pw, pageSize: a.pageSize || 'fit' });
      case 'pdf_extract': return impl.extract(a.file, { pages: a.pages, out: a.out, password: pw });
      case 'pdf_split': return impl.split(a.file, { pages: a.pages, each: !!a.each, out: a.out, password: pw });
      case 'pdf_rotate': return impl.rotate(a.file, { by: a.by || 90, pages: a.pages, out: a.out, password: pw });
      case 'pdf_compress': return impl.compress(a.file, { quality: a.quality || 'med', out: a.out, password: pw });
      case 'pdf_password_add': return impl.protect(a.file, { password: pw, current: a.current ?? null, print: a.print !== false, copy: a.copy !== false, out: a.out });
      case 'pdf_password_remove': if (!pw) throw new Error('Give the password (password, or PALM_PDF_PASSWORD).'); return impl.unprotect(a.file, { password: pw, out: a.out });
      case 'pdf_redact': return impl.redact(a.file, { rules: a.find ? impl.parseRules(a.find) : [], terms: impl.parseTerms(a.text || []), pages: a.pages, style: a.style || 'black', dpi: a.dpi || 200, log: !!a.log, label: a.label || 'Redacted', out: a.out });
      case 'pdf_sign_request': return impl.signRequest(a.file, { signers: a.signers || [], from: a.from, title: a.title, boxes: a.boxes, order: !a.anyOrder, out: a.out });
      case 'pdf_sign_check': return impl.signCheck(a.file, { original: a.original, out: a.out });
    }
  })();
  return text(impl.summary(r), r.ok === false);
}

export const defaultPro = () => P.proOk({ check: async () => { try { const r = await callTool('palm_get', { id: 'review-check', via: 'desk:pdf' }); return !r.locked; } catch { return false; } } });

export async function handleMessage(m, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  if (m.id === undefined || m.id === null) return null;
  switch (m.method) {
    case 'initialize': return reply({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'palm-pdf', title: 'Palm PDF desk', version: '0.1.0' }, instructions: 'Palm\'s PDF desk runs Yuzool PDF Tools and Redact on this machine; files never leave it. After pdf_redact, open look.png and read the verification before telling the user it is safe; a failed check means no file was saved. Palm never sends email: pdf_sign_request writes drafts for the user to send.' });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      try { return reply(await runTool(m.params?.name, m.params?.arguments || {}, ctx)); }
      catch (e) { return reply(text(e.message, true)); }
    }
    default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } };
  }
}

export function serve(ctx = { pro: defaultPro }) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let m; try { m = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); return; }
    const r = await handleMessage(m, ctx);
    if (r) process.stdout.write(JSON.stringify(r) + '\n');
  });
}
