// `palm social-mcp`: Palm's social desk as a local MCP server over stdio. Runs on the user's machine with their own
// scheduler keys (never passed through the chat: they are saved with `palm social connect` in a terminal, or set as env
// vars). Nothing is sent without confirm: true, which the agent passes only after the user has seen the dry run.
//   Claude Code:  claude mcp add palm-social -- npx -y github:pearcoderman/palm-cli social-mcp
import { createInterface } from 'node:readline';
import * as SO from './social.mjs';
import { callTool } from './client.mjs';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description }), bool = (description) => ({ type: 'boolean', description });
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const NET = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const bundle = { description: 'The posts: a path to post.json (or a folder holding one), or the bundle itself: {timeZone? (IANA, default this machine\'s), when? ("2026-12-01 09:30" in timeZone), link?, images?:[{file (relative to the bundle), alt (required), url? (public https; Buffer needs it)}], posts:[{to ("linkedin", a channel name or id, optionally "postiz:", "buffer:" or "bluesky:" first), text, images? (overrides the shared ones; [] for none), when?, settings? (scheduler settings, e.g. Postiz {"__type":"pinterest","board":"…"})}]}', anyOf: [{ type: 'object' }, { type: 'string' }] };
export const TOOLS = [
  { name: 'social_connect', title: 'Check a scheduler connection', description: 'Checks (read-only) the Postiz, Buffer or Bluesky connection the user set up, and caches its channels. Keys are never passed through the chat: if it isn\'t connected, tell the user to run `palm social connect postiz|buffer|bluesky` in their own terminal (it asks for the key without showing it), or to set POSTIZ_API_KEY / BUFFER_API_KEY / BLUESKY_HANDLE + BLUESKY_APP_PASSWORD. Free.', inputSchema: obj({ scheduler: { type: 'string', enum: SO.SCHEDULERS } }, ['scheduler']), annotations: NET },
  { name: 'social_channels', title: 'Connected channels', description: 'The channels in the user\'s connected schedulers (scheduler, id, platform, name), to use as "to" in a bundle. Free.', inputSchema: obj({ scheduler: { type: 'string', enum: SO.SCHEDULERS } }), annotations: NET },
  { name: 'social_check', title: 'Check the posts', description: 'Checks each post against its platform\'s limits (sourced, dated): length (X\'s weighted count, Bluesky graphemes, the scheduler\'s own limit), image count, file size, shape and minimum size, alt text on every image, the link, the time (in an explicit time zone; past, missing or doubled times). Runs Palm\'s multi-image-check and share-preview when they are on this machine (look at their sheets). Reports problems; changes nothing; sends nothing. Free.', inputSchema: obj({ bundle, tools: bool('Run Palm\'s local check tools when found (default true)'), out: str('Folder for the tools\' sheets (default ./palm-social/check)') }, ['bundle']), annotations: RO },
  { name: 'social_queue', title: 'Queue the posts in the scheduler', description: 'Hands the checked posts to the user\'s scheduler. Without confirm it is a dry run: it lists exactly what would go to which channel and when, and sends nothing; show that to the user. Only after the user says yes, call again with confirm: true. Default: drafts in the scheduler (the user reviews them there). schedule: true puts them in the queue at each post\'s time. now: true posts immediately (the only way to post to Bluesky directly); never use it unless the user asked to post now. Records what was queued, so calling again never queues a post twice (again: true overrides). Palm Pro.', inputSchema: obj({ bundle, schedule: bool('Queue at each post\'s time instead of drafts'), now: bool('Post now (only when the user asked)'), confirm: bool('Actually send (only after the user approved the dry run)'), again: bool('Queue posts Palm already queued once more') }, ['bundle']), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: 'social_list', title: 'What is queued', description: 'What Palm queued (scheduler, channel, time, id) and, from Postiz or Buffer, their drafts and scheduled posts (Palm\'s marked). local: true reads only Palm\'s ledger. Palm Pro.', inputSchema: obj({ local: bool('Only the ledger, no scheduler calls') }), annotations: NET },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: SO.redact(typeof t === 'string' ? t : JSON.stringify(t, null, 2)) }], ...(isError ? { isError: true } : {}) });
const PRO = new Set(['social_queue', 'social_list']);
const slim = (r) => ({ ...r, posts: r.posts?.map(({ images, ...p }) => ({ ...p, images: images.map(({ path, ...im }) => im) })) });
export async function runTool(name, a = {}, { pro, fetch, ledger } = {}) {
  if (PRO.has(name) && !(await pro())) return text('Queueing and listing posts are part of Palm Pro. Add a Palm Pro key (`palm login` or PALM_KEY); about Pro: https://www.yuzool.com/palm/#pro. social_check is free.', true);
  switch (name) {
    case 'social_connect': {
      const c = SO.creds(a.scheduler);
      if (!c || !(c.key || c.password)) return text(`${a.scheduler} isn't connected. Ask the user to run \`palm social connect ${a.scheduler}\` in their own terminal (it asks for the key without showing it), or to set ${a.scheduler === 'postiz' ? 'POSTIZ_API_KEY (and POSTIZ_URL when self-hosted)' : a.scheduler === 'buffer' ? 'BUFFER_API_KEY' : 'BLUESKY_HANDLE and BLUESKY_APP_PASSWORD'}. Never ask them to paste a key into the chat.`, true);
      const r = await SO.connect(a.scheduler, c, { fetch }); return text({ connected: a.scheduler, channels: r.channels, from: r.from });
    }
    case 'social_channels': return text(await SO.channels({ scheduler: a.scheduler, fetch }));
    case 'social_check': { const r = SO.check(a.bundle, { tools: a.tools !== false, out: a.out || 'palm-social/check' }); return text({ ok: r.ok, ...slim(r), summary: SO.checkText(r) }); }
    case 'social_queue': { const r = await SO.queue(a.bundle, { schedule: !!a.schedule, now: !!a.now, confirm: !!a.confirm, again: !!a.again, fetch, ledger }); return text({ ...r, summary: SO.queueText(r) }); }
    case 'social_list': { const r = await SO.list({ local: !!a.local, fetch, ledger }); return text({ ...r, summary: SO.listText(r) }); }
    default: return text('Unknown tool: ' + name, true);
  }
}

export const defaultPro = () => SO.proOk({ check: async () => { try { const r = await callTool('palm_get', { id: 'review-check', via: 'desk:social' }); return !r.locked; } catch { return false; } } });

export async function handleMessage(m, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  if (m.id === undefined || m.id === null) return null;
  switch (m.method) {
    case 'initialize': return reply({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'palm-social', title: 'Palm social desk', version: '0.1.0' }, instructions: 'Palm\'s social desk checks posts on this machine and hands them to the user\'s own scheduler (Postiz or Buffer) or to Bluesky. Run social_check and fix every problem; call social_queue without confirm and show the user the dry run; only after they say yes, call it again with confirm: true. Default to drafts; schedule only when asked; never post now unless the user asked. Never ask for keys in the chat.' });
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
