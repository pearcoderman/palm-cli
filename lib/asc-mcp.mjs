// `palm asc-mcp`: Palm's App Store desk as a local MCP server over stdio (newline-delimited JSON-RPC, MCP's stdio transport).
// It runs on the user's machine with their App Store Connect key; nothing from App Store Connect goes to Palm.
//   Claude Code:  claude mcp add palm-asc -- npx -y github:pearcoderman/palm-cli asc-mcp
//   Claude Desktop / others: command "npx", args ["-y", "github:pearcoderman/palm-cli", "asc-mcp"]
// The only write is asc_approve_reply, and it posts only a draft the user has seen and approved in the conversation:
// agents must show the draft (id + text) and get an explicit yes first.
import { createInterface } from 'node:readline';
import * as asc from './asc.mjs';
import { callTool } from './client.mjs';

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description }), num = (description) => ({ type: 'number', description }), bool = (description) => ({ type: 'boolean', description });
export const TOOLS = [
  { name: 'asc_apps', title: 'List App Store apps', description: 'Lists the apps on the App Store Connect team (name, bundle id).', inputSchema: obj({ filter: str('Part of a name or bundle id') }), annotations: RO },
  { name: 'asc_reviews', title: 'Read App Store reviews', description: 'Customer reviews across the team\'s apps, newest first, with any reply. Filter by days, app, unanswered, rating (e.g. "1,2") or territory (e.g. "GBR").', inputSchema: obj({ days: num('How far back (default 30)'), app: str('App name or bundle id part'), unanswered: bool('Only reviews without a reply'), rating: str('Ratings, comma-separated'), territory: str('Three-letter territory code') }), annotations: RO },
  { name: 'asc_draft_reply', title: 'Save a reply draft', description: 'Saves a reply to a review as a local draft (nothing is sent). Show the user the returned draft id and text, and ask before approving it.', inputSchema: obj({ review_id: str('The review id'), text: str('The reply (≤ 5,970 characters)') }, ['review_id', 'text']), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: 'asc_drafts', title: 'List reply drafts', description: 'Lists saved reply drafts and which were sent.', inputSchema: obj(), annotations: { ...RO, openWorldHint: false } },
  { name: 'asc_approve_reply', title: 'Post an approved reply', description: 'Posts one saved draft to the App Store. ONLY call this after the user has seen this exact draft (id and text) in the conversation and said to send it. Pass the draft id and the hash shown with the draft. Without send: true it only shows what would be posted. Apple checks replies before they appear.', inputSchema: obj({ draft_id: str('The draft id the user approved'), hash: str('The draft hash shown with it'), send: bool('true to post; otherwise a dry run') }, ['draft_id', 'hash']), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: 'asc_sales', title: 'Sales and trials summary', description: 'Downloads, in-app purchases, proceeds and subscription events for the last N full days vs the N days before, from App Store Connect\'s daily Sales and Trends reports. Needs the vendor number (ASC_VENDOR_NUMBER).', inputSchema: obj({ days: num('Days per period (default 7)') }), annotations: RO },
  { name: 'asc_status', title: 'Versions and builds', description: 'Each app\'s latest App Store version state per platform (e.g. WAITING_FOR_REVIEW, READY_FOR_DISTRIBUTION) and its latest builds\' processing state.', inputSchema: obj({ app: str('App name or bundle id part') }), annotations: RO },
  { name: 'asc_digest', title: 'This week on the App Store', description: 'A markdown digest: new reviews (unanswered flagged), sales vs the week before, version and build states.', inputSchema: obj({ days: num('Days (default 7)'), app: str('App name or bundle id part') }), annotations: RO },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
export async function runTool(name, a = {}, { cl, pro } = {}) {
  if (!(await pro())) return text('The App Store desk is part of Palm Pro. Add a Palm Pro key (`palm login` or PALM_KEY); about Pro: https://www.yuzool.com/palm/#pro', true);
  cl ??= asc.client();
  switch (name) {
    case 'asc_apps': return text(await asc.apps(cl, a.filter || ''));
    case 'asc_reviews': return text(await asc.reviews(cl, a));
    case 'asc_draft_reply': { const d = asc.addDraft(a.review_id, a.text); return text(`Draft ${d.id} (hash ${d.hash}) saved for review ${d.reviewId}. Nothing was sent. Show the user this text and ask before approving:\n\n${d.text}`); }
    case 'asc_drafts': return text(asc.loadDrafts());
    case 'asc_approve_reply': {
      const r = await asc.approve(cl, a.draft_id, { send: a.send === true, hash: a.hash });
      return text(r.dryRun ? `Dry run: would post draft ${r.draft.id} to review ${r.draft.reviewId}:\n\n${r.draft.text}\n\nCall again with send: true only if the user said to send it.` : `Posted draft ${r.draft.id} (state ${r.draft.state}). Apple checks replies before they appear on the App Store.`);
    }
    case 'asc_sales': return text(await asc.sales(cl, { days: a.days || 7 }));
    case 'asc_status': return text(await asc.status(cl, a.app || ''));
    case 'asc_digest': return text((await asc.digest(cl, { days: a.days || 7, app: a.app || '' })).markdown);
    default: return text('Unknown tool: ' + name, true);
  }
}

export const defaultPro = () => asc.proOk({ check: async () => { try { const r = await callTool('palm_get', { id: 'review-check', via: 'desk:asc' }); return !r.locked; } catch { return false; } } });

export async function handleMessage(m, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  if (m.id === undefined || m.id === null) return null; // notifications
  switch (m.method) {
    case 'initialize': return reply({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'palm-asc', title: 'Palm App Store desk', version: '0.1.0' }, instructions: 'Palm\'s App Store desk runs on this machine with the user\'s App Store Connect key. Reading is free to call; the only write is asc_approve_reply, which needs the user to have seen and approved the exact draft first.' });
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
