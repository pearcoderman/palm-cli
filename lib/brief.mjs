// `palm brief`: one page for the week across Palm's desks, with what to do today at the top. Each part runs only when
// that desk is set up (and says how to set it up otherwise); everything is read here, on the user's machine, with
// their own keys. Nothing is sent anywhere but where each desk already reads from; Palm sends no email.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import * as invoice from './invoice.mjs';
import * as outreach from './outreach.mjs';
import * as asc from './asc.mjs';
import * as search from './search.mjs';
import { callTool, readKey } from './client.mjs';

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }; // the user's local day, as Invoice's TODAY()
const down = (md) => md.replace(/^(#+) /gm, '#$1 '); // a desk's digest sits one level below the brief's headings
const hasLedger = (L) => L.invoices.length || (L.proposals || []).length;

// deps are injectable for tests: { invoiceLedger, outreachState, asc: {has, client}, search: {has, client, site}, watch }
export async function brief({ days = 7, now = today(), ledger, state, deps = {} } = {}) {
  const todo = [], parts = [];
  const D = {
    ascHas: deps.ascHas ?? asc.hasCreds, ascClient: deps.ascClient ?? (() => asc.client()),
    searchHas: deps.searchHas ?? (() => { const c = search.config(); return !!(c.gscKeyPath && c.site); }), searchClient: deps.searchClient ?? (() => search.client()),
    ascDigest: deps.ascDigest ?? asc.digest, searchDigest: deps.searchDigest ?? search.digest,
    watch: deps.watch ?? (async () => (readKey() ? (await callTool('palm_watch', { action: 'report' })).text : null)),
  };

  // money: invoices and proposals
  const L = invoice.loadLedger(ledger);
  if (hasLedger(L)) {
    const x = invoice.list({ ledger, now }), chase = invoice.chase({ ledger, now, dry: true });
    const over = x.rows.filter((r) => r.state === 'overdue'), open = x.rows.filter((r) => r.state === 'open'), drafts = x.rows.filter((r) => r.state === 'draft');
    const waiting = x.proposals.filter((p) => p.status === 'sent');
    const M = ['## Money', '', `Owed: ${Object.values(x.owed).join(', ') || 'nothing'}${over.length ? ` · **${over.length} overdue**` : ''}`];
    for (const r of over) M.push(`- ${r.number} ${r.client}: ${invoice.fmt(r.total, r.currency)}, ${r.late} days late`);
    for (const r of open.filter((r) => invoice.daysBetween(now, r.due) <= days)) M.push(`- ${r.number} ${r.client}: ${invoice.fmt(r.total, r.currency)}, due ${r.due}`);
    if (drafts.length) M.push(`- Waiting to be sent (milestones): ${drafts.map((r) => r.number).join(', ')}`);
    if (waiting.length) M.push('', `Proposals waiting for an answer: ${waiting.map((p) => `${p.number} ${p.title} (${p.client}, ${p.total}, valid until ${p.valid})`).join('; ')}`);
    const won = x.proposals.filter((p) => p.status === 'accepted'), lost = x.proposals.filter((p) => p.status === 'declined');
    if (won.length || lost.length) M.push(`Proposals so far: ${won.length} accepted, ${lost.length} declined, ${waiting.length} waiting.`);
    if (chase.drafts.length) todo.push(`Draft and send ${chase.drafts.length} payment/proposal reminder${chase.drafts.length > 1 ? 's' : ''}: \`palm invoice chase\` (${chase.drafts.map((d) => d.number).join(', ')})`);
    for (const r of drafts) { const m = r.due && invoice.daysBetween(now, r.due) <= 3; if (m) todo.push(`${r.number} is due ${r.due} and still a draft: when the milestone is done, \`palm invoice send ${r.number}\``); }
    parts.push(M.join('\n'));
  } else parts.push('## Money\n\nNo invoices or proposals yet (`palm invoice make`, `palm proposal make`).');

  // outreach
  const S = outreach.load(state);
  if (Object.keys(S.sequences).length) {
    const st = outreach.status(S, { now }), due = outreach.draftToday(S, { now, dry: true });
    const O = ['## Outreach', ''];
    for (const q of st.sequences) O.push(`- ${q.name}: ${q.people} people, ${q.replied} replied (${q.replyRate}), ${q.active} still going, ${q.unsubscribed} unsubscribed, ${q.bounced} bounced`);
    if (due.drafts.length) todo.push(`Send today's ${due.drafts.length} outreach email${due.drafts.length > 1 ? 's' : ''}: \`palm outreach today\``);
    if (due.held.length) todo.push(`${due.held.length} outreach email${due.held.length > 1 ? 's are' : ' is'} held for a missing merge field (${due.held.map((h) => h.email).join(', ')})`);
    todo.push('Tell Palm about any outreach replies: `palm outreach replied <email>`');
    parts.push(O.join('\n'));
  }

  // App Store
  if (D.ascHas()) {
    try {
      const x = await D.ascDigest(D.ascClient(), { days });
      const un = x.reviews.filter((r) => !r.reply);
      if (un.length) todo.push(`Answer ${un.length} App Store review${un.length > 1 ? 's' : ''}: \`palm asc reviews --unanswered\` (drafts first, you approve each)`);
      parts.push(down(x.markdown));
    } catch (e) { parts.push(`## App Store\n\nCouldn't read App Store Connect: ${e.message}`); }
  }

  // search
  if (D.searchHas()) {
    try {
      const x = await D.searchDigest(D.searchClient(), { days, withLlms: false });
      const lines = x.markdown.split('\n'), at = lines.findIndex((l) => l.startsWith('**Next steps**'));
      const next = at < 0 ? [] : lines.slice(at + 1).filter((l) => l.startsWith('- ') && !/Nothing urgent/.test(l)).map((l) => l.slice(2));
      todo.push(...next);
      parts.push(down(x.markdown));
    } catch (e) { parts.push(`## Search\n\nCouldn't read Search Console: ${e.message}`); }
  }

  // Palm Watch
  try {
    const w = await D.watch();
    if (w && !/no pages|not watching/i.test(w)) {
      parts.push('## Palm Watch\n\n' + w.trim());
      if (/\b(broke|broken|failed|error|down|missing)\b/i.test(w)) todo.push('Palm Watch found problems on your pages (below)');
    }
  } catch { /* Watch is optional */ }

  const set = [!hasLedger(L) && 'invoices', !Object.keys(S.sequences).length && 'outreach', !D.ascHas() && 'App Store (`palm asc --help`)', !D.searchHas() && 'search (`palm search --help`)'].filter(Boolean);
  const md = [`# Palm brief, ${now}`, '', '## Do today', '', ...(todo.length ? todo.map((t) => '- [ ] ' + t) : ['- Nothing urgent.']), '', ...parts.flatMap((p) => [p, '']), set.length ? `_Not set up: ${set.join(', ')}._` : ''].join('\n').trim() + '\n';
  return { markdown: md, todo, date: now };
}

export const briefDir = () => join(homedir(), 'Documents', 'Palm');
export function saveBrief(b, dir = briefDir()) { mkdirSync(dir, { recursive: true }); const f = resolve(join(dir, `brief-${b.date}.md`)); writeFileSync(f, b.markdown); return f; }
export const BRIEF_AGENT = 'com.yuzool.palm.brief';
export const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
