// `palm outreach-mcp`: Palm's outreach desk as a local MCP server over stdio. Drafts only: Palm never sends email.
//   Claude Code:  claude mcp add palm-outreach -- npx -y github:pearcoderman/palm-cli outreach-mcp
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import * as O from './outreach.mjs';
import { callTool } from './client.mjs';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description }), bool = (description) => ({ type: 'boolean', description });
const W = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const TOOLS = [
  { name: 'outreach_import', title: 'Import contacts', description: `Contacts from CSV (text or a file path; an "email" column, plus name/first_name/company and any other columns as merge fields) into a named list, with the basis for writing to them: ${O.BASES.join(', ')}. Ask the user which basis applies; never guess it. Suppressed addresses (unsubscribed, bounced) are skipped.`, inputSchema: obj({ csv: str('CSV text or a path to a .csv'), list: str('List name'), basis: { type: 'string', enum: O.BASES }, source: str('Where the contacts came from (kept with them)') }, ['csv', 'list']), annotations: W },
  { name: 'outreach_sequence', title: 'Add a sequence', description: 'A short email sequence: {name, from:{name, email, address (postal, required)}, perDay? (default 20, max 50), unsubscribe? (the line at the foot), steps:[{day, subject (step 1; later steps reply "Re: …" when blank), body}]}. Merge fields {{first}}, {{company}}, {{any_column}}, with a fallback {{first|there}}. Checked: postal address, at most 5 steps, days in order, subjects, links. Write like a person: short, specific, one ask.', inputSchema: obj({ sequence: { type: 'object' } }, ['sequence']), annotations: W },
  { name: 'outreach_start', title: 'Start a sequence for a list', description: 'Enrols a list\'s contacts in a sequence (each person once per sequence, never while in another, never if suppressed). The first emails are due today.', inputSchema: obj({ sequence: str('Sequence name'), list: str('List name') }, ['sequence', 'list']), annotations: W },
  { name: 'outreach_today', title: 'Today\'s drafts', description: 'Drafts today\'s due emails, up to the daily cap, as .eml files and mailto links for the user to read and send from their own mailbox. A contact missing a merge field (no fallback) is held back and listed. Show the user the drafts; never say they were sent. dry: true lists without writing.', inputSchema: obj({ out: str('Folder (default ./palm-outreach)'), dry: bool('List only') }), annotations: W },
  { name: 'outreach_stop', title: 'Replied, unsubscribed or bounced', description: 'Someone replied (their sequence stops), unsubscribed or bounced (never written to again, in any sequence). Call it as soon as the user mentions a reply.', inputSchema: obj({ email: str('Their email'), why: { type: 'string', enum: ['replied', 'unsubscribed', 'bounced'] } }, ['email', 'why']), annotations: W },
  { name: 'outreach_status', title: 'Outreach status', description: 'Each sequence: people, active, due today, replied (and reply rate), unsubscribed, bounced, finished; lists and the suppression count.', inputSchema: obj(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
];
const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
export async function runTool(name, a = {}, { pro, state } = {}) {
  if (!(await pro())) return text('The outreach desk is part of Palm Pro. Add a Palm Pro key (`palm login` or PALM_KEY); about Pro: https://www.yuzool.com/palm/#pro', true);
  const S = O.load(state); let r;
  switch (name) {
    case 'outreach_import': r = O.importContacts(S, O.parseCsv(/\n|,/.test(a.csv) ? a.csv : readFileSync(a.csv, 'utf8')), { list: a.list, basis: a.basis, source: a.source }); break;
    case 'outreach_sequence': r = O.addSequence(S, a.sequence); break;
    case 'outreach_start': r = O.enrol(S, a.sequence, a.list); break;
    case 'outreach_today': r = O.draftToday(S, { out: a.out || 'palm-outreach', dry: !!a.dry }); r = { ...r, drafts: r.drafts.map(({ body, ...d }) => ({ ...d, preview: body.slice(0, 280) })) }; break;
    case 'outreach_stop': r = O.stop(S, a.email, a.why); break;
    case 'outreach_status': return text(O.status(S));
    default: return text('Unknown tool: ' + name, true);
  }
  O.save(S, state);
  return text(r);
}
export const defaultPro = () => O.proOk({ check: async () => { try { const r = await callTool('palm_get', { id: 'review-check' }); return !r.locked; } catch { return false; } } });
export async function handleMessage(m, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  if (m.id === undefined || m.id === null) return null;
  switch (m.method) {
    case 'initialize': return reply({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'palm-outreach', title: 'Palm outreach desk', version: '0.1.0' }, instructions: 'Palm\'s outreach desk drafts personal email sequences on this machine; Palm never sends email. Ask the user for the basis for writing to their contacts, show them every draft, and record replies with outreach_stop as soon as they mention one.' });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': { try { return reply(await runTool(m.params?.name, m.params?.arguments || {}, ctx)); } catch (e) { return reply(text(e.message, true)); } }
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
