// `palm search-mcp`: Palm's search desk as a local MCP server over stdio (newline-delimited JSON-RPC, MCP's stdio
// transport). It runs on the user's machine with their own Search Console / Bing credentials; nothing goes to Palm.
//   Claude Code:  claude mcp add palm-search -- npx -y github:pearcoderman/palm-cli search-mcp
// The only write is search_indexnow with send: true, which tells IndexNow engines (Bing and others; not Google) that
// pages changed. Agents should show the URL list and get a yes first.
import { createInterface } from 'node:readline';
import * as search from './search.mjs';
import { callTool } from './client.mjs';

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description }), num = (description) => ({ type: 'number', description }), bool = (description) => ({ type: 'boolean', description });
const site = str('The Search Console property, e.g. "sc-domain:example.com" or "https://www.example.com/" (default: from config)');
export const TOOLS = [
  { name: 'search_sites', title: 'Search Console properties', description: 'The Search Console properties these credentials can read, with the permission level.', inputSchema: obj(), annotations: RO },
  { name: 'search_report', title: 'Google search performance', description: 'Clicks, impressions, CTR and average position for the last N days vs the N days before (Search Console runs ~2 days behind), top queries and pages, and the pages that lost clicks.', inputSchema: obj({ site, days: num('Days per period (default 28)') }), annotations: RO },
  { name: 'search_inspect', title: 'Is this page indexed?', description: 'Google\'s URL Inspection for one page: indexed or not and why, the canonical Google chose vs the page\'s own, robots.txt, last crawl.', inputSchema: obj({ url: str('The page URL'), site }, ['url']), annotations: RO },
  { name: 'search_bing', title: 'Bing performance', description: 'Bing Webmaster Tools: clicks, impressions, top queries and the latest crawl numbers for the site.', inputSchema: obj({ site }), annotations: RO },
  { name: 'search_llms', title: 'Check llms.txt', description: 'Fetches the site\'s llms.txt and checks its shape (H1, summary), size and whether its links resolve.', inputSchema: obj({ site: str('Site or domain, e.g. example.com') }, ['site']), annotations: RO },
  { name: 'search_indexnow', title: 'Tell IndexNow pages changed', description: 'Lists the URLs (given, or from the site\'s sitemaps changed in the last N days) and, ONLY with send: true after the user has seen the list and said yes, submits them to IndexNow (Bing and other engines; not Google). Without send it is a dry run.', inputSchema: obj({ urls: { type: 'array', items: { type: 'string' }, description: 'URLs to submit' }, origin: str('Site origin to read sitemaps from, e.g. https://www.example.com'), days: num('With origin: only URLs whose lastmod is within N days'), send: bool('true to submit; otherwise a dry run') }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: 'search_digest', title: 'This week in search', description: 'A markdown digest: Google clicks and impressions vs the period before, top queries, pages that lost clicks with Google\'s index verdict, Bing, llms.txt, and suggested next steps.', inputSchema: obj({ site, days: num('Days (default 7)') }), annotations: RO },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
export async function runTool(name, a = {}, { cl, pro } = {}) {
  if (!(await pro())) return text('The search desk is part of Palm Pro. Add a Palm Pro key (`palm login` or PALM_KEY); about Pro: https://www.yuzool.com/palm/#pro', true);
  cl ??= search.client();
  switch (name) {
    case 'search_sites': return text(await search.sites(cl));
    case 'search_report': return text(await search.report(cl, { site: a.site, days: a.days || 28 }));
    case 'search_inspect': return text(await search.inspect(cl, a.url, { site: a.site }));
    case 'search_bing': return text(await search.bingSummary(cl, { site: a.site }));
    case 'search_llms': return text(await search.llms(cl, a.site));
    case 'search_indexnow': {
      const urls = a.urls?.length ? a.urls : a.origin ? await search.sitemapUrls(cl, a.origin, { days: a.days || 0 }) : [];
      const r = await search.indexnow(cl, urls, { send: a.send === true });
      return text(r.dryRun ? `Dry run: ${r.count} URL(s) on ${r.host || '–'} would be submitted:\n${(r.urls || []).join('\n')}${r.count > 50 ? `\n… and ${r.count - 50} more` : ''}\n\nCall again with send: true only if the user said to submit.` : r);
    }
    case 'search_digest': return text((await search.digest(cl, { site: a.site, days: a.days || 7 })).markdown);
    default: return text('Unknown tool: ' + name, true);
  }
}

export const defaultPro = () => search.proOk({ check: async () => { try { const r = await callTool('palm_get', { id: 'review-check' }); return !r.locked; } catch { return false; } } });

export async function handleMessage(m, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  if (m.id === undefined || m.id === null) return null;
  switch (m.method) {
    case 'initialize': return reply({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'palm-search', title: 'Palm search desk', version: '0.1.0' }, instructions: 'Palm\'s search desk runs on this machine with the user\'s own Search Console and Bing credentials. Reading is free to call; the only write is search_indexnow with send: true, after the user has seen the URL list.' });
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
