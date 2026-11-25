// Palm's search desk: Google Search Console, Bing Webmaster Tools, IndexNow and llms.txt from the user's own machine.
// Credentials and search data never leave it; nothing from Search Console or Bing is sent to Palm (owner decision
// 2026-11-25, as for the App Store desk). No dependencies (Node ≥18).
//
// Credentials, first found wins:
//   Google: PALM_GSC_KEY or GOOGLE_APPLICATION_CREDENTIALS (a service-account JSON key the property has added as a user),
//           ~/.config/palm/search/config.json {gscKeyPath}, ~/.yuzool-gsc-key.json
//   Bing:   PALM_BING_KEY (the key itself) or config {bingKeyPath}, ~/.yuzool-bing-key (Bing Webmaster Tools › Settings › API access)
//   IndexNow: config {indexnow: {host, key, keyLocation}} or `--key`/`--key-location`; the key file must be live on the site.
//   Default site: config {site} (e.g. "sc-domain:example.com" or "https://www.example.com/") or PALM_SEARCH_SITE.
// Google docs: Search Console API (https://developers.google.com/webmaster-tools/v1/api_reference_index): sites.list,
// searchanalytics.query (https://developers.google.com/webmaster-tools/v1/searchanalytics/query; data runs ~2 days
// behind, rowLimit ≤ 25,000 with startRow paging), URL Inspection (https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect;
// scope webmasters.readonly is enough). Service-account sign-in: https://developers.google.com/identity/protocols/oauth2/service-account.
// IndexNow: https://www.indexnow.org/documentation (one POST to api.indexnow.org reaches the participating engines;
// Google doesn't take IndexNow; 200/202 accepted, 422 key/host mismatch, 429 too many requests).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sign } from 'node:crypto';
import { configDir } from './client.mjs';

export const searchDir = () => join(configDir(), 'search');
const GSC = 'https://searchconsole.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const day = (n, now = Date.now()) => new Date(now - n * 864e5).toISOString().slice(0, 10);
const b64 = (x) => Buffer.from(x).toString('base64url');
const err = (msg, code = 4) => Object.assign(new Error(msg), { code });

export function config(env = process.env) {
  let c = {};
  try { c = JSON.parse(readFileSync(join(searchDir(), 'config.json'), 'utf8')); } catch {}
  const home = homedir();
  const gscKeyPath = env.PALM_GSC_KEY || env.GOOGLE_APPLICATION_CREDENTIALS || c.gscKeyPath || (existsSync(join(home, '.yuzool-gsc-key.json')) ? join(home, '.yuzool-gsc-key.json') : '');
  let bingKey = env.PALM_BING_KEY || '';
  if (!bingKey) { const p = c.bingKeyPath || join(home, '.yuzool-bing-key'); try { bingKey = readFileSync(p, 'utf8').trim(); } catch {} }
  return { gscKeyPath, bingKey, site: env.PALM_SEARCH_SITE || c.site || '', indexnow: c.indexnow || null };
}

// ---- Google: service-account JWT → access token (RS256), then the Search Console API ----
export function serviceJwt(key, now = Math.floor(Date.now() / 1000)) {
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = sign('RSA-SHA256', Buffer.from(head + '.' + body), key.private_key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

export function client({ fetch: f = globalThis.fetch, cfg = config(), now } = {}) {
  let token = null;
  async function googleToken() {
    if (token) return token;
    if (!cfg.gscKeyPath) throw err('No Google key. Set PALM_GSC_KEY (or GOOGLE_APPLICATION_CREDENTIALS) to a service-account JSON key that your Search Console property has added as a user, or put {"gscKeyPath": "…"} in ' + join(searchDir(), 'config.json') + '.', 2);
    let key; try { key = JSON.parse(readFileSync(cfg.gscKeyPath, 'utf8')); } catch { throw err('Can\'t read the Google key at ' + cfg.gscKeyPath + '.', 2); }
    const r = await f('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceJwt(key, now) }) });
    const j = await r.json(); if (!j.access_token) throw err('Google sign-in failed: ' + (j.error_description || j.error || r.status));
    return (token = j.access_token);
  }
  async function google(path, body) {
    const t = await googleToken();
    const r = await f(GSC + path, body ? { method: 'POST', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: { authorization: 'Bearer ' + t } });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw err(`Search Console ${path.split('?')[0]}: ${r.status} ${j.error?.message || ''}`.trim());
    return j;
  }
  async function bing(method, q = {}) {
    if (!cfg.bingKey) throw err('No Bing key. Set PALM_BING_KEY, or put {"bingKeyPath": "…"} in ' + join(searchDir(), 'config.json') + ' (Bing Webmaster Tools › Settings › API access).', 2);
    const r = await f(`https://ssl.bing.com/webmaster/api.svc/json/${method}?` + new URLSearchParams({ ...q, apikey: cfg.bingKey }));
    const t = await r.text(); if (!r.ok) throw err(`Bing ${method}: ${r.status} ${t.split(cfg.bingKey).join('…').slice(0, 200)}`);
    return JSON.parse(t).d;
  }
  return { google, bing, fetch: f, cfg, now: now ? now * 1000 : Date.now() };
}

const siteOf = (cl, site) => { const s = site || cl.cfg.site; if (!s) throw err('Which site? Pass --site (e.g. sc-domain:example.com) or set {"site": …} in ' + join(searchDir(), 'config.json') + '.', 2); return s; };
const enc = (s) => encodeURIComponent(s);

export async function sites(cl) {
  const j = await cl.google('/webmasters/v3/sites');
  return (j.siteEntry || []).map((s) => ({ site: s.siteUrl, permission: s.permissionLevel }));
}

async function allRows(cl, site, body) {
  const out = [];
  for (let start = 0; ; start += 25000) {
    const j = await cl.google(`/webmasters/v3/sites/${enc(site)}/searchAnalytics/query`, { ...body, rowLimit: 25000, startRow: start, dataState: 'all' });
    out.push(...(j.rows || [])); if (!j.rows || j.rows.length < 25000) return out;
  }
}
const totals = (rows) => { const t = rows.reduce((a, r) => ({ clicks: a.clicks + r.clicks, impressions: a.impressions + r.impressions, pw: a.pw + r.position * r.impressions }), { clicks: 0, impressions: 0, pw: 0 }); return { clicks: t.clicks, impressions: t.impressions, ctr: t.impressions ? t.clicks / t.impressions : 0, position: t.impressions ? t.pw / t.impressions : null }; };

// Clicks, impressions, CTR and position for the last `days` (Search Console runs ~2 days behind) vs the period before.
export async function report(cl, { site, days = 28, top = 15 } = {}) {
  site = siteOf(cl, site);
  const end = day(2, cl.now), start = day(days + 1, cl.now), pEnd = day(days + 2, cl.now), pStart = day(2 * days + 1, cl.now);
  const [pages, prevPages, queries] = await Promise.all([
    allRows(cl, site, { startDate: start, endDate: end, dimensions: ['page'] }),
    allRows(cl, site, { startDate: pStart, endDate: pEnd, dimensions: ['page'] }),
    allRows(cl, site, { startDate: start, endDate: end, dimensions: ['query'] }),
  ]);
  const prev = new Map(prevPages.map((r) => [r.keys[0], r]));
  const dropped = pages.map((r) => ({ page: r.keys[0], clicks: r.clicks, before: prev.get(r.keys[0])?.clicks || 0 }))
    .concat(prevPages.filter((r) => !pages.some((p) => p.keys[0] === r.keys[0])).map((r) => ({ page: r.keys[0], clicks: 0, before: r.clicks })))
    .filter((x) => x.before - x.clicks >= 2).sort((a, b) => (b.before - b.clicks) - (a.before - a.clicks)).slice(0, top);
  const row = (r) => ({ key: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
  return {
    site, period: { start, end }, previous: { start: pStart, end: pEnd },
    totals: totals(pages), previousTotals: totals(prevPages),
    topQueries: queries.sort((a, b) => b.impressions - a.impressions).slice(0, top).map(row),
    topPages: pages.sort((a, b) => b.impressions - a.impressions).slice(0, top).map(row),
    dropped, pagesSeen: pages.length, queriesSeen: queries.length,
  };
}

// URL Inspection: is Google indexing this page, and what did it choose as canonical?
export async function inspect(cl, url, { site } = {}) {
  site = siteOf(cl, site);
  const j = await cl.google('/v1/urlInspection/index:inspect', { inspectionUrl: url, siteUrl: site });
  const s = j.inspectionResult?.indexStatusResult || {};
  return { url, verdict: s.verdict, coverage: s.coverageState, indexing: s.indexingState, robots: s.robotsTxtState, fetch: s.pageFetchState,
    lastCrawl: s.lastCrawlTime || null, googleCanonical: s.googleCanonical || null, userCanonical: s.userCanonical || null,
    canonicalMismatch: !!(s.googleCanonical && s.userCanonical && s.googleCanonical !== s.userCanonical),
    mobile: j.inspectionResult?.mobileUsabilityResult?.verdict || null, link: j.inspectionResult?.inspectionResultLink || null };
}

export async function bingSummary(cl, { site } = {}) {
  const all = await cl.bing('GetUserSites');
  const want = (site || cl.cfg.site || '').replace(/^sc-domain:/, '');
  const mine = all.filter((s) => !want || s.Url.includes(want));
  const url = (mine[0] || all[0])?.Url; if (!url) return { sites: [], note: 'No sites in Bing Webmaster Tools for this key.' };
  const [qs, crawl] = await Promise.all([cl.bing('GetQueryStats', { siteUrl: url }).catch(() => []), cl.bing('GetCrawlStats', { siteUrl: url }).catch(() => [])]);
  const sum = (k) => (qs || []).reduce((s, r) => s + (r[k] || 0), 0);
  const top = Object.values((qs || []).reduce((m, r) => { (m[r.Query] ||= { query: r.Query, impressions: 0, clicks: 0 }); m[r.Query].impressions += r.Impressions || 0; m[r.Query].clicks += r.Clicks || 0; return m; }, {})).sort((a, b) => b.impressions - a.impressions).slice(0, 10);
  const last = (crawl || []).slice(-1)[0];
  return { site: url, verified: !!(mine[0] || all[0])?.IsVerified, clicks: sum('Clicks'), impressions: sum('Impressions'), topQueries: top,
    crawl: last ? { crawled: last.CrawledPages, inIndex: last.InIndex, errors: last.CrawlErrors } : null };
}

// ---- IndexNow: the only write. Dry run unless send is true; checks the live key file first. ----
export async function sitemapUrls(cl, origin, { days = 0 } = {}) {
  const get = async (u) => { const r = await cl.fetch(u, { headers: { 'user-agent': 'palm-search' } }); return r.ok ? r.text() : null; };
  const robots = await get(origin + '/robots.txt');
  const queue = robots ? [...robots.matchAll(/^Sitemap:\s*(\S+)/gim)].map((m) => m[1]) : [origin + '/sitemap.xml'];
  const seen = new Set(), urls = new Map(), since = days ? day(days, cl.now) : '';
  while (queue.length && seen.size < 200) {
    const sm = queue.shift(); if (seen.has(sm) || !sm.startsWith(origin + '/')) continue; seen.add(sm);
    const xml = await get(sm); if (!xml) continue;
    if (/<sitemapindex\b/.test(xml)) { for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) queue.push(m[1]); continue; }
    for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      const loc = (/<loc>\s*([^<\s]+)\s*<\/loc>/.exec(m[1]) || [])[1]; if (!loc || !loc.startsWith(origin + '/')) continue;
      const lm = ((/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(m[1]) || [])[1] || '').slice(0, 10);
      if (!since || (lm && lm >= since)) urls.set(loc, lm);
    }
  }
  return [...urls.keys()].sort();
}

export async function indexnow(cl, urls, { send = false, key, keyLocation, host } = {}) {
  const c = cl.cfg.indexnow || {};
  key ||= c.key; keyLocation ||= c.keyLocation; host ||= c.host || (urls[0] ? new URL(urls[0]).host : '');
  if (!urls.length) return { dryRun: !send, count: 0, note: 'No URLs.' };
  const off = urls.filter((u) => { try { return new URL(u).host !== host; } catch { return true; } });
  if (off.length) throw err(`IndexNow only takes URLs on one host (${host}); these aren't: ${off.slice(0, 3).join(', ')}`, 2);
  if (!send) return { dryRun: true, host, count: urls.length, urls: urls.slice(0, 50), note: 'Dry run: nothing was sent. Add --send (or send: true) to submit.' };
  if (!key || !keyLocation) throw err('IndexNow needs the site\'s key and the address of its key file: --key and --key-location, or {"indexnow": {"host", "key", "keyLocation"}} in ' + join(searchDir(), 'config.json') + '.', 2);
  const served = await cl.fetch(keyLocation).then((r) => (r.ok ? r.text() : '')).catch(() => '');
  if (served.trim() !== key) throw err(`${keyLocation} doesn't serve the key, so IndexNow would reject it. Publish the key file first.`, 1);
  const results = [];
  for (let i = 0; i < urls.length; i += 10000) {
    const batch = urls.slice(i, i + 10000);
    const r = await cl.fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ host, key, keyLocation, urlList: batch }) });
    results.push({ count: batch.length, status: r.status, ok: r.ok });
  }
  return { dryRun: false, host, count: urls.length, results };
}

// ---- llms.txt: present, shaped like the proposal (https://llmstxt.org: an H1, a blockquote summary, link lists), links resolve ----
export async function llms(cl, site, { maxLinks = 40 } = {}) {
  const origin = new URL(/^https?:/.test(site) ? site : 'https://' + site.replace(/^sc-domain:/, '')).origin;
  const r = await cl.fetch(origin + '/llms.txt', { headers: { 'user-agent': 'palm-search' } });
  if (!r.ok) return { origin, present: false, issues: [{ level: 'warn', msg: `${origin}/llms.txt answers ${r.status}. An llms.txt is optional (a proposal, not a standard), but it gives AI tools a map of the site.` }] };
  const text = await r.text(), issues = [];
  if (!/^#\s+\S/.test(text.trimStart())) issues.push({ level: 'warn', msg: 'Doesn\'t start with an H1 ("# Site name"), as the llms.txt proposal asks.' });
  if (!/^>\s+\S/m.test(text)) issues.push({ level: 'tip', msg: 'No blockquote summary ("> …") under the title.' });
  const bytes = Buffer.byteLength(text);
  if (bytes > 200_000) issues.push({ level: 'warn', msg: `${Math.round(bytes / 1000)} KB is long for llms.txt; keep it a map and link to detail (Palm's guidance).` });
  const links = [...new Set([...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]))];
  const broken = [];
  for (let i = 0; i < Math.min(links.length, maxLinks); i += 8) {
    await Promise.all(links.slice(i, Math.min(i + 8, maxLinks)).map(async (u) => {
      const x = await cl.fetch(u, { method: 'HEAD', redirect: 'follow' }).catch(() => null);
      if (!x || x.status >= 400) broken.push({ url: u, status: x ? x.status : 'no answer' });
    }));
  }
  for (const b of broken) issues.push({ level: 'error', msg: `Broken link: ${b.url} (${b.status})` });
  return { origin, present: true, bytes, links: links.length, checked: Math.min(links.length, maxLinks), broken, issues };
}

// ---- The digest: this week vs last week, pages that lost clicks (with Google's index verdict), llms.txt, next steps ----
const n = (x) => (x == null ? '–' : Math.round(x).toLocaleString('en-GB'));
const delta = (a, b) => (b ? `${a >= b ? '+' : ''}${Math.round(((a - b) / b) * 100)}%` : a ? 'new' : '0');
export async function digest(cl, { site, days = 7, inspectTop = 3, withBing = true, withLlms = true } = {}) {
  site = siteOf(cl, site);
  const rep = await report(cl, { site, days, top: 10 });
  const inspected = [];
  for (const d of rep.dropped.slice(0, inspectTop)) { try { inspected.push(await inspect(cl, d.page, { site })); } catch (e) { inspected.push({ url: d.page, error: e.message }); } }
  const bing = withBing && cl.cfg.bingKey ? await bingSummary(cl, { site }).catch((e) => ({ error: e.message })) : null;
  const ll = withLlms ? await llms(cl, site).catch((e) => ({ error: e.message })) : null;
  const t = rep.totals, p = rep.previousTotals, L = [];
  L.push(`# Search: ${site}, ${rep.period.start} to ${rep.period.end}`, '');
  L.push(`**Google:** ${n(t.clicks)} clicks (${delta(t.clicks, p.clicks)}), ${n(t.impressions)} impressions (${delta(t.impressions, p.impressions)}), CTR ${(t.ctr * 100).toFixed(1)}%, average position ${t.position ? t.position.toFixed(1) : '–'} (was ${p.position ? p.position.toFixed(1) : '–'}). ${rep.pagesSeen} pages and ${rep.queriesSeen} queries seen.`, '');
  if (rep.topQueries.length) { L.push('**Top queries** (impressions · clicks · position):'); for (const q of rep.topQueries.slice(0, 8)) L.push(`- ${q.key}: ${n(q.impressions)} · ${n(q.clicks)} · ${q.position.toFixed(1)}`); L.push(''); }
  if (rep.dropped.length) {
    L.push('**Pages that lost clicks** (now · before):');
    for (const d of rep.dropped.slice(0, 8)) { const i = inspected.find((x) => x.url === d.page); L.push(`- ${d.page}: ${d.clicks} · ${d.before}${i ? (i.error ? ` (inspection failed: ${i.error})` : ` — Google: ${i.coverage || i.verdict}${i.canonicalMismatch ? `, chose a different canonical (${i.googleCanonical})` : ''}`) : ''}`); }
    L.push('');
  } else L.push('No page lost 2 or more clicks against the period before.', '');
  if (bing) L.push(bing.error ? `**Bing:** ${bing.error}` : `**Bing** (${bing.site}, its last ~6 months): ${n(bing.clicks)} clicks, ${n(bing.impressions)} impressions${bing.crawl ? `; latest crawl ${n(bing.crawl.crawled)} pages, ${n(bing.crawl.inIndex)} in the index, ${n(bing.crawl.errors)} errors` : ''}.`, '');
  if (ll) L.push(ll.error ? `**llms.txt:** ${ll.error}` : ll.present ? `**llms.txt:** present, ${Math.round(ll.bytes / 1000)} KB, ${ll.links} links (${ll.broken.length} broken of ${ll.checked} checked).` : '**llms.txt:** none.', '');
  const next = [];
  for (const i of inspected) if (!i.error && i.verdict && i.verdict !== 'PASS') next.push(`Look at ${i.url}: Google says "${i.coverage}".`);
  for (const i of inspected) if (i.canonicalMismatch) next.push(`Google chose ${i.googleCanonical} as canonical for ${i.url}; check the page's rel=canonical and internal links.`);
  if (p.clicks && t.clicks < p.clicks * 0.8) next.push('Clicks fell more than 20%: check recent deploys for noindex, canonical or robots.txt changes (palm check seo-check).');
  if (ll && ll.broken?.length) next.push('Fix the broken links in llms.txt.');
  if (ll && ll.present === false) next.push('Consider an llms.txt so AI tools get a map of the site.');
  L.push("**Next steps** (Palm's suggestions, not Google's):", ...(next.length ? next.map((x) => '- ' + x) : ['- Nothing urgent.']));
  return { markdown: L.join('\n'), report: rep, inspected, bing, llms: ll };
}

// ---- Pro: checked against Palm once a day, cached here. Only the Palm key goes to Palm, never search data. ----
export async function proOk({ check, now = Date.now() } = {}) {
  const f = join(searchDir(), 'pro.json');
  try { const c = JSON.parse(readFileSync(f, 'utf8')); if (c.ok && now - c.at < 86400e3) return true; } catch {}
  const ok = !!(await check());
  mkdirSync(searchDir(), { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify({ ok, at: now }), { mode: 0o600 });
  return ok;
}
