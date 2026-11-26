// `palm pages-mcp`: Palm's pages desk as a local MCP server over stdio (newline-delimited JSON-RPC). It runs on the
// user's machine with the apps' own code (Link in Bio, Website Maker, Business Card, Menu Maker) and their Chrome.
//   Claude Code:  claude mcp add palm-pages -- npx -y github:pearcoderman/palm-cli pages-mcp
// A page made here is PUBLIC to anyone who has its link (the page travels inside the link; nothing is uploaded).
// Nothing here writes anywhere but the output folder. make, qr and example are free; the CSV batches need Palm Pro.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import * as P from './pages.mjs';
import { callTool } from './client.mjs';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description }), bool = (description) => ({ type: 'boolean', description }), num = (description) => ({ type: 'number', description });
const WR = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const kind = { type: 'string', enum: Object.keys(P.KINDS), description: 'Which app\'s page: link-in-bio (Link in Bio), website (Website Maker), card (Business Card), menu (Menu Maker)' };
const page = { description: 'The page in the app\'s own format (get one with pages_example), a path to a .json file, or an existing page link to check again', anyOf: [{ type: 'object' }, { type: 'string' }] };
const out = str('Folder to write into (default ./palm-page)');
const size = str('Printed size of the code, white border included: 30mm (default), 3cm, 1.2in, or pixels for a screen: 600px');
export const TOOLS = [
  { name: 'pages_example', title: 'A page to start from', description: 'A Link in Bio page, Website Maker site, Business Card card or Menu Maker menu in the app\'s own format (its sample, or one of its templates), to edit and pass to pages_make. Lists the app\'s template ids.', inputSchema: obj({ kind, template: str('A template id (website and menu have templates)') }, ['kind']), annotations: RO },
  { name: 'pages_make', title: 'Make a live page', description: 'Makes a live page with no hosting: the page travels inside its own yuzool.com link, so it is live, and PUBLIC to anyone who has the link, the moment the link exists (nothing is uploaded). Checked with the app\'s own code: links it doesn\'t allow (javascript: and the like) are refused, Pro looks fall back to the free ones. Opens the real viewer in Chrome at a 390 px phone and at 1280 px (phone.png, desktop.png), reports console errors and every link on the page, and writes manifest.json with the link, its length and what that means for a QR code or a bio field. The preview is not counted as a visit. LOOK at phone.png before finishing. Short links (yuzool.com/bio/<name> …) are the app\'s own Pro, made in the app, never here. Free.', inputSchema: obj({ page, kind, out }, ['page']), annotations: WR },
  { name: 'pages_qr', title: 'A QR code that scans', description: 'A QR code (PNG at 300 dpi with its print size, plus SVG), decoded with jsQR at that size; it only reports success when it decodes to exactly the same text. Also reports Palm\'s phone test (a camera at 20 cm) and the smallest size that still reads. Give text (a link or any text), or page_dir (a folder made by pages_make): then the code follows the app (a business card\'s QR is its card link without pictures, or the contact itself as a vCard when that link is too long). Free.', inputSchema: obj({ text: str('A link or text to encode'), page_dir: str('A folder made by pages_make'), size, contact: bool('Business card: put the contact (vCard) in the code, not the link'), out: str('PNG file to write (default qr.png, or qr.png in page_dir)') }), annotations: WR },
  { name: 'pages_make_cards', title: 'A business card per person', description: 'One Business Card card per CSV row (columns: name, title, company, phone, email, website, address), each made and looked at like pages_make, plus its QR code checked to scan. Each card is PUBLIC to anyone with its link. Palm Pro.', inputSchema: obj({ csv: str('The CSV text (first row: column names), or a path to a .csv file'), base: { type: 'object', description: 'A card whose look (design, accent, font, socials, links) every card shares' }, out: str('Folder (default ./palm-cards)'), qr_size: str('QR size, default 25mm'), limit: num('At most this many rows (default 200)') }, ['csv']), annotations: WR },
  { name: 'pages_qr_batch', title: 'Many QR codes', description: 'One QR code per CSV row (the url, link or text column, or the first; name for the file names), each decoded with jsQR at its print size. Palm Pro.', inputSchema: obj({ csv: str('The CSV text, or a path to a .csv file'), size, out: str('Folder (default ./palm-qr)') }, ['csv']), annotations: WR },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
const PRO = new Set(['pages_make_cards', 'pages_qr_batch']);
const csvOf = (c) => (/\n|,/.test(c) ? c : readFileSync(c, 'utf8'));
export async function runTool(name, a = {}, { pro, impl = P } = {}) {
  if (PRO.has(name) && !(await pro())) return text('Batches (a card per CSV row, many QR codes) are part of Palm Pro. Add a Palm Pro key (`palm login` or PALM_KEY); about Pro: https://www.yuzool.com/palm/#pro. pages_make and pages_qr are free.', true);
  switch (name) {
    case 'pages_example': return text(await impl.example(a.kind, a.template));
    case 'pages_make': { const r = await impl.make(a.page, { kind: a.kind, out: a.out || 'palm-page' }); return text(impl.summary(r), !r.ok); }
    case 'pages_qr': {
      if (!a.text && !a.page_dir) return text('Give text or page_dir.', true);
      const r = a.page_dir ? await impl.pageQR(a.page_dir, { size: a.size || '30mm', contact: !!a.contact, out: a.out }) : await impl.qr(a.text, { size: a.size || '30mm', out: a.out || 'qr.png' });
      return text(impl.summary(r), !r.ok);
    }
    case 'pages_make_cards': return text(impl.summary(await impl.makeCards(csvOf(a.csv), { base: a.base || {}, out: a.out || 'palm-cards', qrSize: a.qr_size || '25mm', limit: a.limit || 200 })));
    case 'pages_qr_batch': return text(impl.summary(await impl.qrBatch(csvOf(a.csv), { size: a.size || '30mm', out: a.out || 'palm-qr' })));
    default: return text('Unknown tool: ' + name, true);
  }
}

export const defaultPro = () => P.proOk({ check: async () => { try { const r = await callTool('palm_get', { id: 'review-check', via: 'desk:pages' }); return !r.locked; } catch { return false; } } });

export async function handleMessage(m, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  if (m.id === undefined || m.id === null) return null;
  switch (m.method) {
    case 'initialize': return reply({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'palm-pages', title: 'Palm pages desk', version: '0.1.0' }, instructions: 'Palm\'s pages desk makes Link in Bio, Website Maker, Business Card and Menu Maker pages that live inside their own link (public to anyone with it), looks at them on a phone, and makes QR codes checked to scan. Start from pages_example; after pages_make open phone.png and look; fix every error and make it again.' });
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
