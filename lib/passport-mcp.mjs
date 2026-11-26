// `palm passport-mcp`: Palm's passport photo desk as a local MCP server over stdio (newline-delimited JSON-RPC). It runs
// Yuzool's Passport Photo in the user's own Chrome on this machine; the photo and the files stay here.
//   Claude Code:  claude mcp add palm-passport -- npx -y github:pearcoderman/palm-cli passport-mcp
// Listing documents and one photo on a document's own background are free; several people on one sheet, a custom size
// and any background colour need Palm Pro (checked once a day).
import { createInterface } from 'node:readline';
import * as P from './passport.mjs';
import { callTool } from './client.mjs';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description }), bool = (description) => ({ type: 'boolean', description });
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WR = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const ADVICE = 'The checks are advice against the published rules, never a promise: show them to the user as advice and say the office that takes the photo decides. Never say a photo will be accepted.';
export const TOOLS = [
  { name: 'passport_docs', title: 'Passport, visa and ID photo rules', description: 'The documents Yuzool Passport Photo knows (passports, visas, ID cards, residence cards, plain sizes), from each official page with its URL and the date it was checked: id, size (mm, and inches where the office states inches), head size, background, glasses, the digital upload\'s pixels and file size, whether the office takes the photo itself (then there is nothing to make). Use it to find the id for passport_make. Free.', inputSchema: obj({ query: str('Words to match, e.g. "uk passport", "schengen", "india visa", "35x45", "2x2"; empty for all') }), annotations: RO },
  { name: 'passport_doc', title: 'One document\'s rules', description: 'Every rule Passport Photo has for one document: size, head (and how it\'s measured), eye height, background colours, glasses, smile, babies, the digital upload, how many prints, the office\'s words on editing, notes, the official source URLs and the date checked. Free.', inputSchema: obj({ id: str('Document id from passport_docs, e.g. uk-passport') }, ['id']), annotations: RO },
  { name: 'passport_make', title: 'Make a passport photo', description: 'Makes a passport, visa or ID photo from the user\'s photo with Yuzool Passport Photo\'s own code, in Chrome on this machine (nothing is uploaded): finds the face, sizes and levels the head to the document\'s rule, and saves the photo at the document\'s size (300 dpi JPEG), a print sheet (4x6 or 5x7 JPEG for a photo counter; A4 or Letter PDF to print at 100 %), the digital upload file where the document has one, look-N.png (the photo with the app\'s guide lines) and page.png, plus manifest.json. Returns the app\'s checks (head size, eyes, looking straight, mouth, background, light, sharpness, glasses) with each message. If no face is found it says so and makes nothing. OPEN look-1.png and page.png before reporting. ' + ADVICE + ' Free: one photo on the document\'s own background colours. Palm Pro: several people (photos) on one sheet, a custom size, any background colour.', inputSchema: obj({
    photo: str('Path to the photo (JPEG, PNG, HEIC, WebP…) of one person facing the camera'),
    doc: str('Document id from passport_docs (e.g. uk-passport, us-passport, schengen-visa)'),
    people: { type: 'array', description: 'Palm Pro: several people on one sheet, instead of photo: [{photo, doc?}] (doc defaults to doc)', items: obj({ photo: str('Path to the photo'), doc: str('Document id') }, ['photo']) },
    paper: { type: 'string', enum: P.PAPER_IDS, description: 'Print sheet: 4x6 (default) or 5x7 photo print as JPEG; a4 or letter as a PDF to print at home' },
    bg: str('Background: keep (default: the person\'s own, best when it\'s a plain light wall), plain (the document\'s own colour, cut out on this device), white, or a colour like #dcdcdc (free when the document allows it; any other colour is Palm Pro)'),
    size: str('Palm Pro: a custom size in mm, width x height (e.g. 30x40), for a form with its own rules'),
    head: str('With size: the head, chin to crown, in mm (e.g. 24-30); default 70–80 % of the height'),
    glassesOff: bool('The user confirmed they are not wearing glasses (answers the app\'s glasses question)'),
    baby: bool('A baby\'s photo: the document\'s relaxed rules for babies'),
    out: str('Folder to write into (default ./palm-passport)'),
  }), annotations: WR },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
export async function runTool(name, a = {}, { pro, impl = P } = {}) {
  switch (name) {
    case 'passport_docs': return text(impl.docsText(await impl.docs({ query: a.query || '' })));
    case 'passport_doc': return text(await impl.doc(a.id));
    case 'passport_make': {
      const people = a.people && a.people.length ? a.people : a.photo ? [{ photo: a.photo }] : [];
      try {
        const r = await impl.make({ people, doc: a.doc, paper: a.paper, bg: a.bg, size: a.size, head: a.head, glassesOff: !!a.glassesOff, baby: !!a.baby, out: a.out || 'palm-passport', pro });
        return text(impl.summary(r), !r.ok && r.people.every((e) => e.error));
      } catch (e) { return text(e.message, true); }
    }
    default: return text('Unknown tool: ' + name, true);
  }
}

export const defaultPro = () => P.proOk({ check: async () => { try { const r = await callTool('palm_get', { id: 'review-check', via: 'desk:passport' }); return !r.locked; } catch { return false; } } });

export async function handleMessage(m, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  if (m.id === undefined || m.id === null) return null;
  switch (m.method) {
    case 'initialize': return reply({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'palm-passport', title: 'Palm passport photo desk', version: '0.1.0' }, instructions: 'Palm\'s passport photo desk runs Yuzool Passport Photo on this machine: find the document with passport_docs, then passport_make. Open look-1.png and page.png before reporting. ' + ADVICE });
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
