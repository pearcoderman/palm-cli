// `palm design-mcp`: Palm's image desk as a local MCP server over stdio (newline-delimited JSON-RPC). It runs on the
// user's machine in their Chrome with Quick Design's own code; the design and the files stay here.
//   Claude Code:  claude mcp add palm-design -- npx -y github:pearcoderman/palm-cli design-mcp
// Nothing here writes anywhere but the output folder. Templates, fill and render are free; sizes, video and batch
// need Palm Pro (checked once a day).
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import * as D from './design.mjs';
import { callTool } from './client.mjs';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description }), num = (description) => ({ type: 'number', description }), bool = (description) => ({ type: 'boolean', description });
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WR = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const design = { description: 'The design: Quick Design format v1 JSON (https://www.yuzool.com/quick-design/design-format/), or a string holding a Quick Design link or a path to a .json file', anyOf: [{ type: 'object' }, { type: 'string' }] };
const out = str('Folder to write into (default ./palm-design)');
const sizes = str(`Sizes, comma-separated: ${Object.keys(D.TARGETS).join(', ')}; or a preset: ${Object.keys(D.PRESETS).join(', ')}`);
export const TOOLS = [
  { name: 'design_templates', title: 'Quick Design templates', description: 'Quick Design\'s templates (name, category, size, pages) and, for the free ones, their text fields (ids like p1e2) to fill with design_fill.', inputSchema: obj({ query: str('Words to look for, e.g. "sale", "invite"'), category: str('ig, carousel, story, poster, flyer, yt, slides, card, a4 or logo') }), annotations: RO },
  { name: 'design_fill', title: 'Fill a template', description: 'Fills a free Quick Design template with new text and returns the design JSON (use it with the other tools). replacements map a field id (p1e2) or the original text to new text; \\n for a new line.', inputSchema: obj({ template: str('Template name'), replacements: { type: 'object', additionalProperties: { type: 'string' } }, name: str('A name for the design') }, ['template']), annotations: RO },
  { name: 'design_render', title: 'Render a design', description: 'Draws the design at its own size with Quick Design\'s code, saves a PNG per page plus sheet.png (how it looks at phone size) and manifest.json, and measures it: words split across lines, text off the page, letters over letters, text too small to read. LOOK at sheet.png before finishing. Free.', inputSchema: obj({ design, out }, ['design']), annotations: WR },
  { name: 'design_sizes', title: 'Every platform size', description: 'Lays the design out again (not stretched) at each platform size and saves the files people post, checked against each app: text under its buttons and caption (safe zones, shaded on sheet.png), text too small at the width the app shows it, split words, overlaps, file-size limits (switches to JPEG when a PNG is too big). Writes manifest.json with alt text for a scheduler. Palm Pro.', inputSchema: obj({ design, sizes, out, ads: bool('Also check the stricter ad safe zones (Meta, TikTok)') }, ['design', 'sizes']), annotations: WR },
  { name: 'design_video', title: 'MP4 of the design', description: 'An MP4 (or GIF) of the design\'s entrance animations, page by page, at vertical sizes (default reel), with a cover image and the same checks. Elements animate when they have an: rise, fade, pop, slide, wipe, spin or type. Palm Pro.', inputSchema: obj({ design, sizes, out, hold: num('Seconds each page holds (default 3)'), gif: bool('GIF instead of MP4'), ads: bool('Also check ad safe zones') }, ['design']), annotations: WR },
  { name: 'design_batch', title: 'One design per row', description: 'Quick Design\'s Make many: one design per CSV row (a text box whose text is a column name is replaced whole; {Column} inside text is filled), at the design\'s size or each of sizes, each checked. Palm Pro.', inputSchema: obj({ design, csv: str('The CSV text (first row: column names), or a path to a .csv file'), sizes, out, limit: num('At most this many rows (default 200)') }, ['design', 'csv']), annotations: WR },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
const PRO = new Set(['design_sizes', 'design_video', 'design_batch']);
export async function runTool(name, a = {}, { pro, impl = D } = {}) {
  if (PRO.has(name) && !(await pro())) return text('Every size, video and batch are part of Palm Pro. Add a Palm Pro key (`palm login` or PALM_KEY); about Pro: https://www.yuzool.com/palm/#pro. design_render is free.', true);
  const o = a.out || 'palm-design';
  switch (name) {
    case 'design_templates': { const t = await impl.templates({ query: a.query, category: a.category }); return text(t.slice(0, 60)); }
    case 'design_fill': { const r = await impl.fill(a.template, { ...(a.replacements || {}), ...(a.name ? { name: a.name } : {}) }); return text({ design: r.design, unknown: r.unknown }); }
    case 'design_render': return text(impl.summary(await impl.stills(impl.readDesign(a.design), { targets: [], out: o })));
    case 'design_sizes': return text(impl.summary(await impl.stills(impl.readDesign(a.design), { targets: impl.parseTargets(a.sizes), out: o, ads: !!a.ads })));
    case 'design_video': return text(impl.summary(await impl.video(impl.readDesign(a.design), { targets: impl.parseTargets(a.sizes || 'reel'), out: o, hold: a.hold || 3, gif: !!a.gif, ads: !!a.ads })));
    case 'design_batch': {
      const csv = /\n|,/.test(a.csv) ? a.csv : readFileSync(a.csv, 'utf8');
      return text(impl.summary(await impl.batch(impl.readDesign(a.design), csv, { targets: a.sizes ? impl.parseTargets(a.sizes) : [], out: o, limit: a.limit || 200 })));
    }
    default: return text('Unknown tool: ' + name, true);
  }
}

export const defaultPro = () => D.proOk({ check: async () => { try { const r = await callTool('palm_get', { id: 'review-check' }); return !r.locked; } catch { return false; } } });

export async function handleMessage(m, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  if (m.id === undefined || m.id === null) return null;
  switch (m.method) {
    case 'initialize': return reply({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'palm-design', title: 'Palm image desk', version: '0.1.0' }, instructions: 'Palm\'s image desk renders Quick Design designs on this machine and checks them at every platform size. After each call, open sheet.png and look before calling the work done; fix every error and run again.' });
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
