// `palm brief`: one page for the week across Palm's desks, with what needs the user on top: Palm Watch's findings for
// their pages, App Store reviews and ratings, Search Console positions, overdue invoices, outreach. Each part runs only
// when that desk is set up (and says in one line how to set it up otherwise); everything is read here, on the user's
// machine, with their own keys. The brief only reads: it drafts nothing, marks nothing and sends nothing (Palm Watch is
// read with `list`, which leaves its "since the last report" news for `palm watch report`). The one thing it writes is
// a small snapshot of this week's numbers in ~/.config/palm/brief/snapshots/, so next week can say what changed.
import { writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import * as invoice from './invoice.mjs';
import * as outreach from './outreach.mjs';
import * as asc from './asc.mjs';
import * as search from './search.mjs';
import * as social from './social.mjs';
import { callTool, readKey, configDir } from './client.mjs';

export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // the user's local day, as Invoice's TODAY()
const down = (md) => md.replace(/^(#+) /gm, '#$1 '); // a desk's digest sits one level below the brief's headings
const hasLedger = (L) => L.invoices.length || (L.proposals || []).length;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const host = (u) => { try { return new URL(u).host + (new URL(u).pathname === '/' ? '' : new URL(u).pathname); } catch { return u; } };
const PRO = 'https://www.yuzool.com/palm/#pro';

// ---- snapshots: this week's numbers, to compare with next week ----
export const snapDir = () => join(configDir(), 'brief', 'snapshots');
export function loadSnapshots(dir = snapDir()) {
  let files = []; try { files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch {}
  return files.map((f) => f.slice(0, 10));
}
// The snapshot to compare with: the newest at least 6 days before `now` (last week's run), else the newest earlier one.
export function previousSnapshot(now, dir = snapDir()) {
  const dates = loadSnapshots(dir).filter((d) => d < now), weekAgo = invoice.daysBetween;
  const pick = [...dates].reverse().find((d) => weekAgo(d, now) >= 6) || dates[dates.length - 1];
  if (!pick) return null;
  try { return JSON.parse(readFileSync(join(dir, pick + '.json'), 'utf8')); } catch { return null; }
}
export function saveSnapshot(snap, dir = snapDir(), keep = 120) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, snap.date + '.json'), JSON.stringify(snap, null, 1) + '\n', { mode: 0o600 });
  const all = loadSnapshots(dir); for (const d of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, d + '.json'), { force: true });
}

// What changed since the previous snapshot, per part. A part that wasn't read either time says nothing (never "fixed").
export function compare(prev, cur) {
  const out = { watch: [], asc: [], search: [], money: [] };
  if (!prev) return out;
  if (prev.watch && cur.watch) {
    for (const [u, n] of Object.entries(cur.watch)) {
      const was = prev.watch[u];
      if (was == null) out.watch.push(`${host(u)}: newly watched, ${plural(n, 'problem')}`);
      else if (n > was) out.watch.push(`${plural(n - was, 'new problem')} on ${host(u)} (${was} → ${n})`);
      else if (n < was) out.watch.push(`${host(u)}: ${plural(was - n, 'problem')} fixed (${was} → ${n})`);
    }
    for (const u of Object.keys(prev.watch)) if (!(u in cur.watch)) out.watch.push(`${host(u)}: no longer watched`);
  }
  if (prev.asc && cur.asc) {
    for (const [app, a] of Object.entries(cur.asc)) {
      const p = prev.asc[app]; if (!p) continue;
      if (a.rating != null && p.rating != null && (a.rating !== p.rating || a.ratings !== p.ratings)) {
        const d = a.ratings - p.ratings;
        out.asc.push(`${app}: rating ${p.rating.toFixed(2)}★ → ${a.rating.toFixed(2)}★, ${a.ratings.toLocaleString('en-US')} ratings (${d >= 0 ? '+' : ''}${d})`);
      }
      if (a.reviews !== p.reviews) out.asc.push(`${app}: ${plural(a.reviews, 'review')} this week (last week ${p.reviews})${a.avg != null ? `, average ${a.avg.toFixed(1)}★` : ''}`);
    }
  }
  if (prev.search && cur.search && prev.search.site === cur.search.site) {
    const t = cur.search.totals, p = prev.search.totals;
    const pct = (a, b) => (b ? ` (${a >= b ? '+' : ''}${Math.round(((a - b) / b) * 100)}%)` : '');
    out.search.push(`Clicks ${p.clicks} → ${t.clicks}${pct(t.clicks, p.clicks)}, impressions ${p.impressions} → ${t.impressions}${pct(t.impressions, p.impressions)}${p.position && t.position ? `, average position ${p.position.toFixed(1)} → ${t.position.toFixed(1)}` : ''}`);
    const moves = Object.entries(cur.search.queries).filter(([q]) => prev.search.queries[q]).map(([q, x]) => ({ q, from: prev.search.queries[q].position, to: x.position, d: x.position - prev.search.queries[q].position }));
    const up = moves.filter((m) => m.d <= -1).sort((a, b) => a.d - b.d).slice(0, 5), dn = moves.filter((m) => m.d >= 1).sort((a, b) => b.d - a.d).slice(0, 5);
    const f = (m) => `"${m.q}" ${m.from.toFixed(1)} → ${m.to.toFixed(1)}`;
    if (up.length) out.search.push(`Risers: ${up.map(f).join('; ')}`);
    if (dn.length) out.search.push(`Fallers: ${dn.map(f).join('; ')}`);
    const fresh = Object.keys(cur.search.queries).filter((q) => !prev.search.queries[q]), gone = Object.keys(prev.search.queries).filter((q) => !cur.search.queries[q]);
    if (fresh.length) out.search.push(`New in your top queries: ${fresh.map((q) => `"${q}"`).join(', ')}`);
    if (gone.length) out.search.push(`Left your top queries: ${gone.map((q) => `"${q}"`).join(', ')}`);
  }
  if (prev.money && cur.money) {
    const a = cur.money, p = prev.money;
    if (a.overdue !== p.overdue) out.money.push(`Overdue invoices: ${p.overdue} → ${a.overdue}`);
    for (const c of new Set([...Object.keys(a.owed), ...Object.keys(p.owed)])) if ((a.owed[c] || 0) !== (p.owed[c] || 0)) out.money.push(`Owed (${c}): ${invoice.fmt(p.owed[c] || 0, c)} → ${invoice.fmt(a.owed[c] || 0, c)}`);
    if (a.waiting !== p.waiting) out.money.push(`Proposals waiting: ${p.waiting} → ${a.waiting}`);
  }
  return out;
}

// ---- What Palm did for you: outcomes this month, counted only from the user's own local records ----
// Nothing here is estimated: an invoice counts only once the ledger marks it paid, a reminder only if Palm drafted it on
// or before the day it was paid, a site fix only when the weekly checks saw a page's open problems go down.
const SCHED = { postiz: 'Postiz', buffer: 'Buffer', bluesky: 'Bluesky' };
const monthOf = (day) => String(day || '').slice(0, 7);
const isoMonth = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : monthOf(localDay(d)); }; // a UTC timestamp's local month
export const prevMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const money = (by) => Object.entries(by).map(([c, m]) => invoice.fmt(m, c)).join(', ');
const clean = (s) => String(s ?? '').replace(/[`*\[\]\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim(); // a channel name never turns into markup
export function loadSnapshotsFull(dir = snapDir()) {
  return loadSnapshots(dir).map((d) => { try { return JSON.parse(readFileSync(join(dir, d + '.json'), 'utf8')); } catch { return null; } }).filter(Boolean);
}
// month 'YYYY-MM' → [{key, text}] (lines with nothing in them are left out). Each source is optional: null/undefined
// means that desk isn't connected (or isn't part of this plan), and its line is skipped.
export function palmDid(month, { ledger: L, outreach: S, social: SL, ascDrafts, snapshots } = {}) {
  const out = [];
  if (L) {
    const paid = (L.invoices || []).filter((r) => r.paidAt && monthOf(r.paidAt) === month);
    const chased = paid.filter((r) => Object.values(r.chased || {}).some((d) => typeof d === 'string' && d <= r.paidAt));
    const sum = (rows) => { const by = {}; for (const r of rows) by[r.currency] = (by[r.currency] || 0) + (Number(r.total) || 0); return by; };
    if (chased.length) out.push({ key: 'chased', text: `${plural(chased.length, 'invoice')} paid after reminders (${money(sum(chased))})` });
    if (paid.length > chased.length) out.push({ key: 'paid', text: `${plural(paid.length, 'invoice')} paid in all (${money(sum(paid))})` });
    const won = (L.proposals || []).filter((p) => p.status === 'accepted' && p.acceptedAt && monthOf(p.acceptedAt) === month);
    if (won.length) out.push({ key: 'proposals', text: `${plural(won.length, 'proposal')} accepted (${money(sum(won))})` });
  }
  if (snapshots) {
    const seq = snapshots.filter((s) => s && s.watch).sort((a, b) => a.date.localeCompare(b.date)); let fixed = 0;
    for (let i = 1; i < seq.length; i++) {
      if (monthOf(seq[i].date) !== month) continue;
      for (const [u, n] of Object.entries(seq[i].watch)) { const was = seq[i - 1].watch[u]; if (was != null && n < was) fixed += was - n; }
    }
    if (fixed) out.push({ key: 'site', text: `${plural(fixed, 'site problem')} caught and fixed (seen in the weekly checks)` });
  }
  if (SL) {
    const q = (SL.entries || []).filter((e) => e.status === 'queued' && e.queuedAt && isoMonth(e.queuedAt) === month);
    if (q.length) {
      const by = {}; for (const e of q) { const s = SCHED[e.scheduler] || clean(e.scheduler); (by[s] ||= {})[clean(e.channel) || '?'] = (by[s]?.[clean(e.channel) || '?'] || 0) + 1; }
      const parts = Object.entries(by).map(([s, ch]) => { const n = Object.values(ch).reduce((a, x) => a + x, 0), c = Object.entries(ch); return c.length > 1 ? `${s} ${n}: ${c.map(([k, x]) => `${k} ${x}`).join(', ')}` : `${s} ${n}`; });
      const posted = q.filter((e) => e.mode === 'now').length, verb = posted === q.length ? 'posted' : posted ? `queued or posted` : 'queued';
      out.push({ key: 'posts', text: `${plural(q.length, 'post')} ${verb} (${parts.join('; ')})` });
    }
  }
  if (S && Object.keys(S.sequences || {}).length) {
    let drafts = 0; const replied = new Set();
    for (const e of S.enrolments || []) { for (const x of e.drafted || []) if (monthOf(x.on) === month) drafts++; if (e.stopped === 'replied' && monthOf(e.stoppedAt) === month) replied.add(e.email); }
    if (drafts) out.push({ key: 'outreach', text: `${plural(drafts, 'outreach email')} drafted` });
    if (replied.size) out.push({ key: 'replies', text: `${plural(replied.size, 'outreach reply', 'outreach replies')} recorded` });
  }
  if (ascDrafts) {
    const d = ascDrafts.filter((x) => x.createdAt && isoMonth(x.createdAt) === month), sent = ascDrafts.filter((x) => x.sentAt && isoMonth(x.sentAt) === month);
    if (d.length || sent.length) out.push({ key: 'reviews', text: [d.length && `${plural(d.length, 'App Store review reply', 'App Store review replies')} drafted`, sent.length && `${sent.length} posted`].filter(Boolean).join(', ') });
  }
  return out;
}

// ---- App Store ratings: the public store lookup (Apple's, no key), for ratings that come without a review ----
export async function storeRatings(apps, { fetch: f = globalThis.fetch, country = process.env.PALM_ASC_COUNTRY || 'us' } = {}) {
  if (!apps.length) return {};
  const r = await f(`https://itunes.apple.com/lookup?id=${apps.map((a) => encodeURIComponent(a.id)).join(',')}&country=${encodeURIComponent(country)}`);
  if (!r.ok) throw new Error(`the App Store lookup answered ${r.status}`);
  const j = await r.json(), out = {};
  for (const x of j.results || []) { const a = apps.find((y) => String(y.id) === String(x.trackId)); if (a && x.userRatingCount != null) out[a.name] = { rating: x.averageUserRating, ratings: x.userRatingCount, country }; }
  return out;
}

// Palm Watch's `list` reply, read back into {url: open problems} (list leaves the report's news alone).
export function parseWatchList(text) {
  const out = {};
  for (const l of String(text).split('\n')) { const m = l.match(/^\s*- (.+?): (\d+) open problems?, last checked/); if (m) out[m[1]] = Number(m[2]); }
  return out;
}

// deps are injectable for tests: ascHas/ascClient/ascDigest/ascRatings, searchHas/searchClient/searchDigest, watch
// (→ {url: problems} or null when there's no key), ascDrafts (→ the App Store desk's saved reply drafts).
export async function brief({ days = 7, now = localDay(), ledger, state, socialLedger, pro = true, snapshot = true, snapshots = snapDir(), deps = {} } = {}) {
  const todo = [], parts = [], snap = { date: now, watch: null, asc: null, search: null, money: null }, need = { site: 0, overdue: 0, reviews: 0, outreach: 0 };
  const D = {
    ascHas: deps.ascHas ?? asc.hasCreds, ascClient: deps.ascClient ?? (() => asc.client()),
    searchHas: deps.searchHas ?? (() => { const c = search.config(); return !!(c.gscKeyPath && c.site); }), searchClient: deps.searchClient ?? (() => search.client()),
    ascDigest: deps.ascDigest ?? asc.digest, searchDigest: deps.searchDigest ?? search.digest,
    ascRatings: deps.ascRatings ?? (async (cl) => storeRatings(await asc.apps(cl))),
    ascDrafts: deps.ascDrafts ?? asc.loadDrafts,
    watch: deps.watch ?? (async () => { if (!readKey()) return null; const r = await callTool('palm_watch', { action: 'list' }); if (r.locked || r.isError) throw new Error(r.text.split('\n')[0]); return parseWatchList(r.text); }),
  };
  const prev = previousSnapshot(now, snapshots), since = prev ? ` since ${prev.date}` : '';
  const sinceBlock = (lines) => (lines.length ? ['', `**Since ${prev.date}:**`, ...lines.map((l) => '- ' + l)] : []);
  const sections = {};

  // Palm Watch (Pro): site problems per page
  if (pro) {
    try {
      const w = await D.watch();
      if (w == null) sections.watch = '## Palm Watch\n\nNot connected: save your Palm key with `palm login`, then `palm watch add <url>`.';
      else if (!Object.keys(w).length) { snap.watch = {}; sections.watch = '## Palm Watch\n\nNot watching any pages yet: `palm watch add <url>` (Palm re-checks each about once a day).'; }
      else {
        snap.watch = w; need.site = Object.values(w).reduce((a, n) => a + n, 0);
        sections.watch = ['## Palm Watch', '', ...Object.entries(w).map(([u, n]) => `- ${u}: ${n ? `**${plural(n, 'open problem')}**` : 'no problems'}`), '', 'What each problem is: `palm watch report` (it also marks them as seen).'].join('\n');
        if (need.site) todo.push(`Fix ${plural(need.site, 'problem')} Palm Watch found on your pages: \`palm watch report\``);
      }
    } catch (e) { sections.watch = `## Palm Watch\n\nCouldn't read Palm Watch: ${e.message}`; }
  }

  // App Store (Pro): new reviews, unanswered ones, ratings
  if (pro) {
    if (!D.ascHas()) sections.asc = '## App Store\n\nNot connected: add your App Store Connect API key (.p8) as `palm asc --help` shows; it stays on this machine.';
    else {
      try {
        const cl = D.ascClient(), x = await D.ascDigest(cl, { days });
        const un = x.reviews.filter((r) => !r.reply); need.reviews = un.length;
        if (un.length) todo.push(`Answer ${plural(un.length, 'App Store review')}: \`palm asc reviews --unanswered\` (drafts first, you approve each)`);
        let ratings = {}; try { ratings = await D.ascRatings(cl); } catch { /* the public lookup is a bonus */ }
        snap.asc = {};
        const names = new Set([...x.reviews.map((r) => r.app), ...Object.keys(ratings), ...(x.status || []).map((s) => s.app)]);
        for (const app of names) { const rv = x.reviews.filter((r) => r.app === app); snap.asc[app] = { reviews: rv.length, avg: rv.length ? rv.reduce((a, r) => a + r.rating, 0) / rv.length : null, rating: ratings[app]?.rating ?? null, ratings: ratings[app]?.ratings ?? null }; }
        const R = Object.entries(ratings).map(([a, r]) => `- ${a}: ${r.rating.toFixed(2)}★ from ${r.ratings.toLocaleString('en-US')} ratings (${r.country.toUpperCase()} store)`);
        sections.asc = [down(x.markdown), ...(R.length ? ['', '### Ratings', '', ...R] : [])].join('\n');
      } catch (e) { sections.asc = `## App Store\n\nCouldn't read App Store Connect: ${e.message}`; }
    }
  }

  // Search (Pro): Search Console clicks, impressions, top query positions
  if (pro) {
    if (!D.searchHas()) sections.search = '## Search\n\nNot connected: add a Search Console service-account key and your site as `palm search --help` shows.';
    else {
      try {
        const x = await D.searchDigest(D.searchClient(), { days, withLlms: false });
        const lines = x.markdown.split('\n'), at = lines.findIndex((l) => l.startsWith('**Next steps**'));
        const next = at < 0 ? [] : lines.slice(at + 1).filter((l) => l.startsWith('- ') && !/Nothing urgent/.test(l)).map((l) => l.slice(2));
        todo.push(...next);
        const rep = x.report;
        if (rep) {
          const q = (rows) => Object.fromEntries((rows || []).map((r) => [r.key, { position: Math.round(r.position * 10) / 10, clicks: r.clicks, impressions: r.impressions }]));
          snap.search = { site: rep.site, totals: { clicks: rep.totals.clicks, impressions: rep.totals.impressions, position: rep.totals.position }, queries: q(rep.topQueries), pages: q(rep.topPages) };
        }
        sections.search = down(x.markdown);
      } catch (e) { sections.search = `## Search\n\nCouldn't read Search Console: ${e.message}`; }
    }
  }

  // Money: invoices and proposals (the user's own ledger)
  const L = invoice.loadLedger(ledger);
  if (hasLedger(L)) {
    const x = invoice.list({ ledger, now }), chase = invoice.chase({ ledger, now, dry: true });
    const over = x.rows.filter((r) => r.state === 'overdue'), open = x.rows.filter((r) => r.state === 'open'), drafts = x.rows.filter((r) => r.state === 'draft');
    const waiting = x.proposals.filter((p) => p.status === 'sent');
    need.overdue = over.length;
    const owedN = {}; for (const r of x.rows) if (r.state === 'open' || r.state === 'overdue') owedN[r.currency] = (owedN[r.currency] || 0) + r.total;
    snap.money = { owed: owedN, overdue: over.length, waiting: waiting.length };
    const M = ['## Money', '', `Owed: ${Object.values(x.owed).join(', ') || 'nothing'}${over.length ? ` · **${over.length} overdue**` : ''}`];
    for (const r of over) M.push(`- ${r.number} ${r.client}: ${invoice.fmt(r.total, r.currency)}, ${r.late} days late`);
    for (const r of open.filter((r) => invoice.daysBetween(now, r.due) <= days)) M.push(`- ${r.number} ${r.client}: ${invoice.fmt(r.total, r.currency)}, due ${r.due}`);
    if (drafts.length) M.push(`- Waiting to be sent (milestones): ${drafts.map((r) => r.number).join(', ')}`);
    if (waiting.length) M.push('', `Proposals waiting for an answer: ${waiting.map((p) => `${p.number} ${p.title} (${p.client}, ${p.total}, valid until ${p.valid})`).join('; ')}`);
    const won = x.proposals.filter((p) => p.status === 'accepted'), lost = x.proposals.filter((p) => p.status === 'declined');
    if (won.length || lost.length) M.push(`Proposals so far: ${won.length} accepted, ${lost.length} declined, ${waiting.length} waiting.`);
    if (pro && chase.drafts.length) todo.push(`Draft and send ${chase.drafts.length} payment/proposal reminder${chase.drafts.length > 1 ? 's' : ''}: \`palm invoice chase\` (${chase.drafts.map((d) => d.number).join(', ')})`);
    else if (over.length) todo.push(`Chase ${plural(over.length, 'overdue invoice')}: ${over.map((r) => r.number).join(', ')}`);
    for (const r of drafts) { const m = r.due && invoice.daysBetween(now, r.due) <= 3; if (m) todo.push(`${r.number} is due ${r.due} and still a draft: when the milestone is done, \`palm invoice send ${r.number}\``); }
    sections.money = M.join('\n');
  } else sections.money = '## Money\n\nNo invoices or proposals yet (`palm invoice make`, `palm proposal make`).';

  // outreach (Pro)
  const S = outreach.load(state);
  if (pro && Object.keys(S.sequences).length) {
    const st = outreach.status(S, { now }), due = outreach.draftToday(S, { now, dry: true });
    const O = ['## Outreach', ''];
    for (const q of st.sequences) O.push(`- ${q.name}: ${q.people} people, ${q.replied} replied (${q.replyRate}), ${q.active} still going, ${q.unsubscribed} unsubscribed, ${q.bounced} bounced`);
    need.outreach = due.drafts.length;
    if (due.drafts.length) todo.push(`Send today's ${due.drafts.length} outreach email${due.drafts.length > 1 ? 's' : ''}: \`palm outreach today\``);
    if (due.held.length) todo.push(`${due.held.length} outreach email${due.held.length > 1 ? 's are' : ' is'} held for a missing merge field (${due.held.map((h) => h.email).join(', ')})`);
    todo.push('Tell Palm about any outreach replies: `palm outreach replied <email>`');
    sections.outreach = O.join('\n');
  }

  // week over week
  const ch = compare(prev, snap);
  for (const k of ['watch', 'asc', 'search', 'money']) if (sections[k] && ch[k].length) sections[k] += '\n' + sinceBlock(ch[k]).join('\n');
  if (!prev && (snap.watch || snap.asc || snap.search || snap.money)) parts.push('_First brief with a snapshot: from next week each part also says what changed since this one._');
  for (const k of ['watch', 'asc', 'search', 'money', 'outreach']) if (sections[k]) parts.push(sections[k]);
  // what Palm did: this month so far, and last month on the first brief of a month (only from local records)
  const read = (f) => { try { return f(); } catch { return null; } };
  const src = { ledger: L, outreach: pro ? S : null, social: pro ? read(() => social.loadLedger(socialLedger)) : null, ascDrafts: pro ? read(() => D.ascDrafts()) : null,
    snapshots: pro ? [...(read(() => loadSnapshotsFull(snapshots)) || []).filter((s) => s.date !== now), snap] : null };
  const month = monthOf(now), did = { month: palmDid(month, src), lastMonth: Number(now.slice(8, 10)) <= 7 ? palmDid(prevMonth(month), src) : [] };
  const didLines = [did.month.length && `**This month with Palm:** ${did.month.map((x) => x.text).join(' · ')}`, did.lastMonth.length && `**Last month with Palm:** ${did.lastMonth.map((x) => x.text).join(' · ')}`].filter(Boolean);
  if (snapshot) { try { saveSnapshot(snap, snapshots); } catch { /* the brief still prints */ } }

  const bits = [need.site && plural(need.site, 'site problem'), need.overdue && plural(need.overdue, 'overdue invoice'), need.reviews && plural(need.reviews, 'review') + ' to answer', need.outreach && plural(need.outreach, 'outreach email') + ' to send'].filter(Boolean);
  const total = need.site + need.overdue + need.reviews + need.outreach;
  const summary = total ? `${plural(total, 'thing needs', 'things need')} you: ${bits.join(', ')}` : 'Nothing needs you this week';
  const set = [!hasLedger(L) && 'invoices', pro && !Object.keys(S.sequences).length && 'outreach'].filter(Boolean);
  const md = [`# Palm brief, ${now}`, '', `**${summary}.**`, '', ...(didLines.length ? ['## What Palm did for you', '', ...didLines, ''] : []), '## Do today', '', ...(todo.length ? todo.map((t) => '- [ ] ' + t) : ['- Nothing urgent.']), '', ...parts.flatMap((p) => [p, '']),
    pro ? '' : `_Palm Pro adds Palm Watch (your pages re-checked every day), App Store reviews and ratings, Search Console positions week over week, outreach, reminder drafts and the weekly schedule: ${PRO}_`, '',
    set.length ? `_Not set up: ${set.join(', ')}._` : ''].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { markdown: md, todo, summary, need, did, snapshot: snap, changes: ch, since: prev?.date || null, date: now, pro };
}

// ---- delivery: Markdown + a self-contained HTML page, a notification, an optional .eml draft ----
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inline(s) {
  const keep = []; const hold = (h) => `\u0000${keep.push(h) - 1}\u0000`;
  let x = String(s).replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
  x = x.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => hold(`<a href="${esc(u)}">${esc(t)}</a>`));
  x = x.replace(/https?:\/\/[^\s<>()"'*]+[^\s<>()"'.,;:!?_*]/g, (u) => hold(`<a href="${esc(u)}">${esc(u)}</a>`));
  x = esc(x).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])_([^_]+)_(?=$|[\s).,;:])/g, '$1<em>$2</em>');
  return x.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[i]);
}
export function toHtml(md, { title = 'Palm brief' } = {}) {
  const out = []; let list = false, para = [];
  const endPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
  const endList = () => { if (list) out.push('</ul>'); list = false; };
  for (const l of md.split('\n')) {
    const h = l.match(/^(#{1,4}) (.*)$/), li = l.match(/^\s*- (\[ \] )?(.*)$/);
    if (h) { endPara(); endList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
    else if (li) { endPara(); if (!list) { out.push('<ul>'); list = true; } out.push(`<li${li[1] ? ' class="todo"' : ''}>${inline(li[2])}</li>`); }
    else if (!l.trim()) { endPara(); endList(); }
    else { endList(); para.push(l); }
  }
  endPara(); endList();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#6b675f;--line:#e4e0d8;--accent:#2f6b4f;--code:#f0ede6}
@media (prefers-color-scheme: dark){:root{--bg:#161615;--fg:#ecebe7;--muted:#a19d94;--line:#34322e;--accent:#7cc49e;--code:#26251f}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:1.6rem;margin:0 0 8px}h2{font-size:1.2rem;margin:32px 0 8px;padding-top:16px;border-top:1px solid var(--line)}h3{font-size:1rem;margin:20px 0 6px}h4{font-size:.95rem;margin:16px 0 4px}
ul{padding-left:22px}li{margin:4px 0}li.todo{list-style:none;margin-left:-22px}li.todo::before{content:"\\2610";margin-right:8px;color:var(--accent)}
a{color:var(--accent);word-break:break-all}code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:.9em}em{color:var(--muted)}
</style></head><body><main>
${out.join('\n')}
</main></body></html>
`;
}

export const briefDir = () => join(homedir(), 'Documents', 'Palm', 'Brief');
// Writes <dir>/YYYY-MM-DD.md and .html, and latest.md / latest.html (the same, for a bookmark).
export function saveBrief(b, dir = briefDir()) {
  mkdirSync(dir, { recursive: true });
  const html = toHtml(b.markdown, { title: `Palm brief, ${b.date}` });
  for (const name of [b.date, 'latest']) { writeFileSync(join(dir, name + '.md'), b.markdown); writeFileSync(join(dir, name + '.html'), html); }
  return resolve(join(dir, b.date + '.md'));
}

// A macOS notification (osascript; the text goes in as an argument, never through a shell). Built here, run by the CLI.
export const notifyArgs = (b) => ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Palm brief" subtitle (item 2 of argv)', '-e', 'end run', b.summary, `Week of ${b.date}`];

// An unsent email draft (X-Unsent: 1) with the brief as text and HTML. Palm never sends it.
export function emailDraft(b, { to = '' } = {}) {
  const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
  const b64 = (s) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');
  const bd = 'palm-brief-' + b.date.replace(/-/g, '');
  return [`To: ${String(to).replace(/[\r\n]+/g, ' ').trim()}`, `Subject: ${enc(`Palm brief, ${b.date}: ${b.summary}`)}`, 'X-Unsent: 1', 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${bd}"`, '',
    `--${bd}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(b.markdown),
    `--${bd}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(toHtml(b.markdown, { title: `Palm brief, ${b.date}` })),
    `--${bd}--`, ''].join('\r\n');
}
export function saveEmailDraft(b, dir = briefDir(), opts) { mkdirSync(dir, { recursive: true }); const f = resolve(join(dir, b.date + '.eml')); writeFileSync(f, emailDraft(b, opts)); return f; }

// ---- the weekly schedule ----
export const BRIEF_AGENT = 'com.yuzool.palm.brief';
export const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
// "09:00" / "9" / "9:30" → {hour, minute}; null when it isn't a time of day.
export function parseTime(s) { const m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?$/); if (!m) return null; const hour = Number(m[1]), minute = Number(m[2] || 0); return hour <= 23 && minute <= 59 ? { hour, minute } : null; }
// Which desks only work from this shell's environment variables (the weekly job doesn't get them).
export function envOnly(env = process.env) {
  const out = [];
  try { asc.creds(env); try { asc.creds({}); } catch { out.push('App Store (ASC_* variables: put them in ~/.config/palm/asc/config.json or ~/.appstoreconnect/)'); } } catch {}
  const a = search.config(env), b = search.config({});
  if (a.gscKeyPath && a.site && !(b.gscKeyPath && b.site)) out.push('search (PALM_GSC_KEY / PALM_SEARCH_SITE: put them in ~/.config/palm/search/config.json)');
  return out;
}
