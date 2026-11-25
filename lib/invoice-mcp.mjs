// `palm invoice-mcp`: Palm's invoice desk as a local MCP server over stdio. Runs on the user's machine; the ledger
// stays here. Palm never sends email: reminders are .eml drafts the user sends.
//   Claude Code:  claude mcp add palm-invoice -- npx -y github:pearcoderman/palm-cli invoice-mcp
import { createInterface } from 'node:readline';
import * as V from './invoice.mjs';
import { callTool } from './client.mjs';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description }), bool = (description) => ({ type: 'boolean', description });
const W = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const invoice = { type: 'object', description: 'The invoice. Prices in normal money (450 or 85.50), not cents: {number?, issued? (YYYY-MM-DD, default today), due? or terms? (days, default 14), currency (GBP, USD, EUR, …), from:{name, address, email, phone, taxId, payLink (Stripe payment link, PayPal.me, …), payNote}, to:{name, contact (the person, for "Hi Sam"), email, address, taxId}, lines:[{desc, qty, price, taxRate?}], taxRate?, taxName? ("VAT", "GST"), discountPct? or discount?, notes?}' };
export const TOOLS = [
  { name: 'invoice_make', title: 'Make an invoice', description: 'Checks the invoice (currency, dates, decimals, a number not already used), works out the totals exactly as Yuzool Invoice does, and makes: a link the client opens to see and pay it (the invoice travels inside the link; nothing is stored on a server), a PDF of that page, and an email draft (.eml) to send it with. Records it in the local ledger. Palm sends nothing. Free.', inputSchema: obj({ invoice, out: str('Folder (default ./palm-invoices)'), record: bool('Add it to the ledger (default true)') }, ['invoice']), annotations: W },
  { name: 'invoice_list', title: 'What is owed', description: 'Every invoice in the local ledger: open, overdue (days late) or paid, and the total owed per currency. Palm Pro.', inputSchema: obj(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'invoice_paid', title: 'Mark paid', description: 'Marks an invoice paid in the ledger (so it is never chased again). Palm Pro.', inputSchema: obj({ number: str('Invoice number'), date: str('Paid on (YYYY-MM-DD, default today)') }, ['number']), annotations: W },
  { name: 'invoice_chase', title: 'Draft reminders', description: 'For each unpaid invoice, the reminder it is due for today (3 days before, on the day, 7, 14 and 30 days late; each once, polite, with the link and the pay link), written as .eml drafts for the user to read and send from their own mail. Show the user the drafts; never claim they were sent. dry: true lists them without writing. Palm Pro.', inputSchema: obj({ out: str('Folder (default ./palm-invoices)'), dry: bool('List only') }), annotations: W },
  { name: 'invoice_send', title: 'Send a draft invoice', description: 'A draft invoice (a later payment of an accepted proposal) goes out now: it is chased from now on. Returns the email draft to send. Palm Pro.', inputSchema: obj({ number: str('Invoice number') }, ['number']), annotations: W },
  { name: 'proposal_make', title: 'Make a proposal', description: 'A proposal on Yuzool Invoice\'s proposal pages (cover, letter, sections, timeline, price table with optional lines, payment schedule, plain-English terms, an acceptance page): checks it (dates, decimals, the schedule adds up to 100%, milestones exist), works out totals and payments exactly as Invoice does, and makes a link the client reads and accepts from (nothing stored on a server), a PDF whose last page is for signing, and an email draft. Records it; invoice_chase then drafts a nudge after 5 days and a note before it expires. Free.', inputSchema: obj({ proposal: { type: 'object', description: '{currency, title, subtitle?, letter?, theme? (indigo, forest, coral, ink, gold, plum), from:{name, contact, email, phone, address, payLink}, to:{name, contact, email, address}, sections:[{h, text}], milestones:[{title, date or days}], lines:[{desc, qty, price, optional?, note?}], taxRate?, schedule:[{label, pct, at: "sign" or a milestone number from 1 or its title}] (adds up to 100), validDays? (30) or valid?, jurisdiction?, terms? (false leaves the terms out), number?, issued?}' }, out: str('Folder (default ./palm-invoices)') }, ['proposal']), annotations: W },
  { name: 'proposal_accepted', title: 'Proposal accepted', description: 'The client said yes (or signed): marks the proposal accepted with the options they chose, and turns its payment schedule into invoices like Invoice does (the on-signing invoice goes out now with its email draft; milestone invoices wait as drafts until invoice_send). Palm Pro.', inputSchema: obj({ number: str('Proposal number'), options: { type: 'array', items: { type: 'string' }, description: 'The optional lines the client chose (their descriptions)' }, date: str('Accepted on (YYYY-MM-DD, default today)') }, ['number']), annotations: W },
  { name: 'proposal_declined', title: 'Proposal declined', description: 'Marks a proposal declined, so it gets no more follow-ups. Palm Pro.', inputSchema: obj({ number: str('Proposal number') }, ['number']), annotations: W },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
const PRO = new Set(['invoice_list', 'invoice_paid', 'invoice_chase', 'invoice_send', 'proposal_accepted', 'proposal_declined']);
export async function runTool(name, a = {}, { pro, ledger } = {}) {
  if (PRO.has(name) && !(await pro())) return text('The ledger and reminders are part of Palm Pro. Add a Palm Pro key (`palm login` or PALM_KEY); about Pro: https://www.yuzool.com/palm/#pro. invoice_make is free.', true);
  switch (name) {
    case 'invoice_make': return text(await V.make(a.invoice, { out: a.out || 'palm-invoices', record: a.record !== false, ledger }));
    case 'invoice_list': return text(V.list({ ledger }));
    case 'invoice_paid': return text(V.paid(a.number, { date: a.date, ledger }));
    case 'invoice_send': { const r = V.send(a.number, { ledger }); return text({ number: r.number, status: r.status, email: r.email }); }
    case 'proposal_make': return text(await V.makeProposal(a.proposal, { out: a.out || 'palm-invoices', ledger }));
    case 'proposal_accepted': return text(await V.acceptProposal(a.number, { chosen: a.options || [], date: a.date, ledger, out: a.out || 'palm-invoices' }));
    case 'proposal_declined': return text(V.declineProposal(a.number, { ledger }));
    case 'invoice_chase': return text(V.chase({ out: a.out || 'palm-invoices', dry: !!a.dry, ledger }));
    default: return text('Unknown tool: ' + name, true);
  }
}

export const defaultPro = () => V.proOk({ check: async () => { try { const r = await callTool('palm_get', { id: 'review-check' }); return !r.locked; } catch { return false; } } });

export async function handleMessage(m, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  if (m.id === undefined || m.id === null) return null;
  switch (m.method) {
    case 'initialize': return reply({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'palm-invoice', title: 'Palm invoice and proposal desk', version: '0.1.0' }, instructions: 'Palm\'s invoice desk runs on this machine. It never sends email: invoice_make and invoice_chase write .eml drafts for the user to send. Show the user the totals and the drafts.' });
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
