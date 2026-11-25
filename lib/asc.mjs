// Palm's App Store desk: App Store Connect from the user's own machine. The .p8 key and the signed JWTs never leave it
// and nothing from App Store Connect is sent to Palm (owner decision 2026-11-25). No dependencies (Node ≥18).
//
// Credentials, first found wins:
//   ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH (and ASC_VENDOR_NUMBER for sales)
//   ~/.config/palm/asc/config.json {keyId, issuerId, privateKeyPath, vendorNumber}
//   ~/.appstoreconnect/issuer_id + the only ~/.appstoreconnect/private_keys/AuthKey_<id>.p8 (the layout Apple's tools use)
// Apple docs: App Store Connect API (https://developer.apple.com/documentation/appstoreconnectapi), JWT auth
// (…/generating-tokens-for-api-requests), customer reviews and responses (…/customer-reviews, …/customer-review-responses),
// sales reports (…/download-sales-and-trends-reports: gzip TSV; SALES SUMMARY 1_0, SUBSCRIPTION_EVENT SUMMARY 1_4).
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createPrivateKey, sign, randomBytes, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { configDir } from './client.mjs';

const API = 'https://api.appstoreconnect.apple.com';
export const ascDir = () => join(configDir(), 'asc');

export function creds(env = process.env) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(ascDir(), 'config.json'), 'utf8')); } catch {}
  let keyId = env.ASC_KEY_ID || cfg.keyId, issuerId = env.ASC_ISSUER_ID || cfg.issuerId, keyPath = env.ASC_PRIVATE_KEY_PATH || cfg.privateKeyPath;
  const apple = join(homedir(), '.appstoreconnect');
  if (!issuerId) { try { issuerId = readFileSync(join(apple, 'issuer_id'), 'utf8').trim(); } catch {} }
  if (!keyPath) {
    let keys = [];
    try { keys = readdirSync(join(apple, 'private_keys')).filter((f) => /^AuthKey_.+\.p8$/.test(f)); } catch {}
    const pick = keyId ? keys.find((f) => f === `AuthKey_${keyId}.p8`) : keys.length === 1 ? keys[0] : null;
    if (pick) keyPath = join(apple, 'private_keys', pick);
  }
  if (!keyId && keyPath) keyId = keyPath.match(/AuthKey_(.+)\.p8$/)?.[1];
  const vendorNumber = env.ASC_VENDOR_NUMBER || cfg.vendorNumber || '';
  if (!keyId || !issuerId || !keyPath) {
    throw Object.assign(new Error('No App Store Connect API key found. Set ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY_PATH, or put issuer_id and AuthKey_<id>.p8 in ~/.appstoreconnect/ (App Store Connect → Users and Access → Integrations → Team Keys). The key stays on this machine.'), { code: 2 });
  }
  return { keyId, issuerId, keyPath, vendorNumber };
}

// ES256 JWT, 15 minutes (Apple allows up to 20).
export function jwt({ keyId, issuerId, key }, now = Math.floor(Date.now() / 1000)) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = b64({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const b = b64({ iss: issuerId, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' });
  const s = sign('sha256', Buffer.from(`${h}.${b}`), { key: createPrivateKey(key), dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${h}.${b}.${s}`;
}

export function client({ fetch: f = globalThis.fetch, credentials } = {}) {
  let c = credentials, token = null, tokenAt = 0;
  const auth = () => {
    if (!c) { const x = creds(); c = { ...x, key: readFileSync(x.keyPath, 'utf8') }; }
    const now = Math.floor(Date.now() / 1000);
    if (!token || now - tokenAt > 600) { token = jwt(c, now); tokenAt = now; }
    return token;
  };
  async function api(method, path, body, { raw = false } = {}) {
    const url = path.startsWith('http') ? path : API + path;
    const r = await f(url, { method, headers: { Authorization: 'Bearer ' + auth(), Accept: raw ? 'application/a-gzip' : 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (raw) {
      if (r.status === 404) return null; // no report for that day (yet)
      if (!r.ok) throw Object.assign(new Error(`${method} ${path.replace(API, '')} → ${r.status} ${(await r.text()).slice(0, 200)}`), { code: 4 });
      return Buffer.from(await r.arrayBuffer());
    }
    const t = await r.text(); const j = t ? JSON.parse(t) : {};
    if (!r.ok) {
      const e = j.errors?.[0];
      let msg = `${method} ${path.replace(API, '')} → ${r.status} ${e ? `${e.title}: ${e.detail}` : t.slice(0, 200)}`;
      if (r.status === 403 && method !== 'GET') msg += ' (replies need a key with the Admin, App Manager or Customer Support role)';
      throw Object.assign(new Error(msg), { code: r.status === 401 || r.status === 403 ? 3 : 4 });
    }
    return j;
  }
  async function all(path, max = 2000) {
    const out = []; const included = [];
    for (let next = path; next && out.length < max;) { const j = await api('GET', next); out.push(...(j.data || [])); included.push(...(j.included || [])); next = j.links?.next; }
    return { data: out, included };
  }
  return { api, all, vendor: () => { if (!c) auth(); return c.vendorNumber; } };
}

// ---- apps, reviews, status ----
export async function apps(cl, filter = '') {
  const { data } = await cl.all('/v1/apps?limit=200&fields[apps]=name,bundleId,sku,primaryLocale');
  const q = filter.toLowerCase();
  return data.map((a) => ({ id: a.id, name: a.attributes.name, bundleId: a.attributes.bundleId })).filter((a) => !q || a.name.toLowerCase().includes(q) || a.bundleId.toLowerCase().includes(q));
}

export async function reviews(cl, { days = 30, app = '', unanswered = false, rating, territory } = {}) {
  const since = Date.now() - days * 86400e3;
  const out = [];
  for (const a of await apps(cl, app)) {
    for (let next = `/v1/apps/${a.id}/customerReviews?sort=-createdDate&limit=200&include=response`; next;) {
      const j = await cl.api('GET', next);
      const resp = Object.fromEntries((j.included || []).filter((x) => x.type === 'customerReviewResponses').map((x) => [x.id, x.attributes]));
      let old = false;
      for (const r of j.data || []) {
        const x = r.attributes;
        if (Date.parse(x.createdDate) < since) { old = true; break; }
        const rr = resp[r.relationships?.response?.data?.id];
        out.push({ id: r.id, app: a.name, appId: a.id, rating: x.rating, title: x.title || '', body: x.body || '', reviewer: x.reviewerNickname, territory: x.territory, date: (x.createdDate || '').slice(0, 10), reply: rr ? { body: rr.responseBody, state: rr.state } : null });
      }
      next = old ? null : j.links?.next;
    }
  }
  return out.filter((r) => (!unanswered || !r.reply) && (!rating || String(rating).split(',').map(Number).includes(r.rating)) && (!territory || r.territory === territory.toUpperCase()))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export async function status(cl, app = '') {
  const out = [];
  for (const a of await apps(cl, app)) {
    const v = await cl.api('GET', `/v1/apps/${a.id}/appStoreVersions?limit=5&fields[appStoreVersions]=versionString,platform,appStoreState,appVersionState,createdDate`);
    const seen = new Set(); const versions = [];
    for (const x of v.data || []) { const p = x.attributes.platform; if (seen.has(p)) continue; seen.add(p); versions.push({ platform: p, version: x.attributes.versionString, state: x.attributes.appVersionState || x.attributes.appStoreState }); }
    const b = await cl.api('GET', `/v1/builds?filter[app]=${a.id}&sort=-uploadedDate&limit=3&fields[builds]=version,processingState,uploadedDate,expired`);
    const builds = (b.data || []).map((x) => ({ build: x.attributes.version, processing: x.attributes.processingState, uploaded: (x.attributes.uploadedDate || '').slice(0, 10), expired: !!x.attributes.expired }));
    out.push({ app: a.name, bundleId: a.bundleId, versions, builds });
  }
  return out;
}

// ---- reply drafts: stored only here; posting needs an explicit approve with the draft's id ----
const draftsFile = () => join(ascDir(), 'drafts.json');
export function loadDrafts() { try { return JSON.parse(readFileSync(draftsFile(), 'utf8')); } catch { return []; } }
function saveDrafts(d) { mkdirSync(ascDir(), { recursive: true, mode: 0o700 }); writeFileSync(draftsFile(), JSON.stringify(d, null, 2), { mode: 0o600 }); }
export const draftHash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 8);
export function addDraft(reviewId, text, meta = {}) {
  if (!reviewId || !text?.trim()) throw Object.assign(new Error('A draft needs a review id and the reply text.'), { code: 2 });
  if (text.length > 5970) throw Object.assign(new Error(`The reply is ${text.length} characters; Apple allows 5,970.`), { code: 2 });
  const d = loadDrafts().filter((x) => !(x.reviewId === reviewId && !x.sentAt));
  const draft = { id: 'd-' + randomBytes(3).toString('hex'), reviewId, text: text.trim(), hash: draftHash(text.trim()), createdAt: new Date().toISOString(), ...meta };
  d.push(draft); saveDrafts(d); return draft;
}
// The only write. dryRun (default) shows what would be posted; send posts it. `hash` must match when given (MCP passes it).
export async function approve(cl, draftId, { send = false, hash } = {}) {
  const d = loadDrafts(); const x = d.find((y) => y.id === draftId);
  if (!x) throw Object.assign(new Error(`No draft "${draftId}". List drafts with: palm asc drafts`), { code: 2 });
  if (x.sentAt) throw Object.assign(new Error(`Draft ${draftId} was already sent on ${x.sentAt}.`), { code: 2 });
  if (hash && hash !== x.hash) throw Object.assign(new Error('The draft changed since it was shown; show the user the current text and ask again.'), { code: 2 });
  if (!send) return { dryRun: true, draft: x };
  const j = await cl.api('POST', '/v1/customerReviewResponses', { data: { type: 'customerReviewResponses', attributes: { responseBody: x.text }, relationships: { review: { data: { type: 'customerReviews', id: x.reviewId } } } } });
  x.sentAt = new Date().toISOString(); x.state = j.data?.attributes?.state || 'PENDING_PUBLISH'; saveDrafts(d);
  return { dryRun: false, draft: x };
}

// ---- sales and subscription events (gzip TSV) ----
export function parseTsv(buf) {
  if (!buf) return [];
  const text = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8');
  const [head, ...rows] = text.split('\n').filter((l) => l.trim());
  const cols = head.split('\t').map((c) => c.trim());
  return rows.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v.trim()])));
}
const ymd = (d) => d.toISOString().slice(0, 10);
async function report(cl, type, date) {
  const v = cl.vendor();
  if (!v) throw Object.assign(new Error('Sales reports need your vendor number: set ASC_VENDOR_NUMBER (App Store Connect → Payments and Financial Reports, top left) or vendorNumber in ~/.config/palm/asc/config.json.'), { code: 2 });
  const q = type === 'SALES' ? 'filter[reportType]=SALES&filter[reportSubType]=SUMMARY&filter[version]=1_0' : 'filter[reportType]=SUBSCRIPTION_EVENT&filter[reportSubType]=SUMMARY&filter[version]=1_4';
  return parseTsv(await cl.api('GET', `/v1/salesReports?${q}&filter[frequency]=DAILY&filter[reportDate]=${date}&filter[vendorNumber]=${v}`, null, { raw: true }));
}
// Product Type Identifier groups (Apple's "Product Type Identifiers" reference): 1*, F1, 1T… first downloads of paid/free apps;
// 7*, F7 updates (left out); IA*/FI1 in-app purchases. Proceeds = Units × Developer Proceeds, per currency.
const kind = (t = '') => /^(IA|FI)/.test(t) ? 'inApp' : /^(7|F7)/.test(t) ? 'update' : /^(1|F1|3|F3)/.test(t) ? 'download' : 'other';
export function summariseSales(rows) {
  const s = { downloads: 0, inApp: 0, proceeds: {}, byApp: {} };
  for (const r of rows) {
    const k = kind(r['Product Type Identifier']); if (k === 'update') continue;
    const units = Number(r.Units || 0), per = Number(r['Developer Proceeds'] || 0), cur = r['Currency of Proceeds'] || '?';
    if (k === 'download') s.downloads += units; if (k === 'inApp') s.inApp += units;
    if (per) s.proceeds[cur] = +((s.proceeds[cur] || 0) + units * per).toFixed(2);
    const app = (r['Parent Identifier'] && r['Parent Identifier'].trim()) ? r['Parent Identifier'] : r.SKU || r.Title || '?';
    const a = (s.byApp[app] ??= { title: r.Title, downloads: 0, inApp: 0 }); if (k === 'download') a.downloads += units; if (k === 'inApp') a.inApp += units;
  }
  return s;
}
export function summariseEvents(rows) {
  const s = {};
  for (const r of rows) { const e = r.Event || '?'; s[e] = (s[e] || 0) + Number(r.Quantity || r.Units || 1); }
  return s;
}
// Last N full days (reports appear a day or so late) vs the N days before.
export async function sales(cl, { days = 7, end = new Date(Date.now() - 86400e3), subscriptions = true } = {}) {
  const span = async (from) => {
    const rows = [], ev = [];
    for (let i = 0; i < days; i++) {
      const d = ymd(new Date(from.getTime() - i * 86400e3));
      rows.push(...await report(cl, 'SALES', d));
      if (subscriptions) { try { ev.push(...await report(cl, 'SUBSCRIPTION_EVENT', d)); } catch (e) { if (e.code !== 4) throw e; } }
    }
    return { ...summariseSales(rows), events: summariseEvents(ev) };
  };
  const thisWeek = await span(end), lastWeek = await span(new Date(end.getTime() - days * 86400e3));
  return { days, end: ymd(end), thisWeek, lastWeek };
}

// ---- digest ----
export async function digest(cl, { days = 7, app = '' } = {}) {
  const rv = await reviews(cl, { days, app });
  let s = null, sErr = ''; try { s = await sales(cl, { days }); } catch (e) { sErr = e.message; }
  const st = await status(cl, app);
  const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
  const money = (p) => Object.entries(p).map(([c, v]) => `${v.toFixed(2)} ${c}`).join(', ') || '0';
  const L = [`# App Store, last ${days} days`, ''];
  L.push(`## Reviews: ${rv.length} new, ${rv.filter((r) => !r.reply).length} without a reply`);
  for (const r of rv) L.push(`- ${stars(r.rating)} ${r.app} · ${r.territory} · ${r.date}${r.reply ? '' : ' · **NO REPLY**'} — ${r.title || r.body.slice(0, 80)} (id ${r.id})`);
  L.push('', '## Sales');
  if (s) {
    const t = s.thisWeek, w = s.lastWeek, d = (a, b) => `${a} (last week ${b})`;
    L.push(`- Downloads: ${d(t.downloads, w.downloads)}`, `- In-app purchases: ${d(t.inApp, w.inApp)}`, `- Proceeds: ${money(t.proceeds)} (last week ${money(w.proceeds)})`);
    const ev = Object.entries(t.events); if (ev.length) L.push(`- Subscription events: ${ev.map(([k, v]) => `${k} ${v}`).join(', ')}`);
  } else L.push(`- Not available: ${sErr}`);
  L.push('', '## Versions and builds');
  for (const a of st) L.push(`- ${a.app}: ${a.versions.map((v) => `${v.platform} ${v.version} ${v.state}`).join('; ') || 'no versions'}${a.builds[0] ? ` · latest build ${a.builds[0].build} ${a.builds[0].processing}` : ''}`);
  return { markdown: L.join('\n'), reviews: rv, sales: s, status: st };
}

// ---- Pro: checked against Palm once a day, cached here. Only the Palm key goes to Palm, never App Store data. ----
export async function proOk({ check, now = Date.now() } = {}) {
  const f = join(ascDir(), 'pro.json');
  try { const c = JSON.parse(readFileSync(f, 'utf8')); if (c.ok && now - c.at < 86400e3) return true; } catch {}
  const ok = !!(await check());
  mkdirSync(ascDir(), { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify({ ok, at: now }), { mode: 0o600 });
  return ok;
}
export const hasCreds = () => { try { creds(); return true; } catch { return false; } };
