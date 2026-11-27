// Palm's social desk: the week's posts checked, then handed to the scheduler the user already uses (Postiz or Buffer),
// through that scheduler's own public API with the user's own key; or posted straight to Bluesky (an app password, no
// platform approval needed). Palm doesn't rebuild a scheduler: platform approvals, token refresh, retries and the queue
// stay the scheduler's. Runs on the user's machine. Nothing leaves it without --confirm (the default is a dry run that
// shows exactly what would go where and when); drafts by default; never "post now" unless --now --confirm. Keys and app
// passwords are kept in ~/.config/palm/social/ (mode 600) or read from env vars, and never printed. What Palm queued is
// recorded in ~/.config/palm/social/ledger.json, so running it again doesn't queue anything twice.
//   connect, channels, check: free · queue, list: Palm Pro (checked once a day)
//
// Facts, from each service's own docs (read 2026-11-27 unless marked):
//   Postiz (docs.postiz.com/public-api/*): base https://api.postiz.com/public/v1 (cloud) or https://<your-domain>/api/public/v1
//     (self-hosted); header "Authorization: <api key>" (no prefix); GET /is-connected → {connected}; GET /integrations →
//     [{id, name, identifier, picture, disabled, profile}]; POST /upload (multipart "file") → {id, path}; POST /posts
//     {type: draft|schedule|now, date (UTC ISO, required), shortLink, tags, posts:[{integration:{id}, value:[{content,
//     image:[{id, path, alt}]}], settings:{__type, …}}]} → [{postId, integration}]; GET /posts?startDate&endDate →
//     {posts:[{id, content, publishDate, state: QUEUE|PUBLISHED|ERROR|DRAFT, integration}]}. Rate limit on creating posts:
//     the overview says 90 an hour (100 on the cloud, API_LIMIT when self-hosted); the OpenAPI text says 30 an hour.
//     Required settings: x who_can_reply_post; instagram post_type. Alt text is sent by Instagram, Bluesky, Mastodon, Slack
//     and Tumblr and ignored by the others. Character limits: general/platforms/overview.
//   Buffer (developers.buffer.com): GraphQL at https://api.buffer.com, "Authorization: Bearer <key>" (a personal key from
//     publish.buffer.com/settings/api; BUFFER_API_KEY); account{organizations{id name}}; channels(input:{organizationId});
//     createPost(input:{text, channelId, schedulingType: automatic|notification, mode: addToQueue|customScheduled|shareNow
//     |shareNext, dueAt, saveToDraft, assets:[{image:{url, metadata:{altText}}}], metadata}) → PostActionSuccess{post} or
//     MutationError{message}; posts(first, input:{organizationId, filter:{channelIds, status}}). No upload endpoint: images
//     must be public, stable https URLs. Instagram personal profiles and Facebook groups take notification posts only.
//     Limits per plan (Free: 150 requests per 15 min, 600 a day). Character limits: guides/character-limits.
//   Bluesky (AT Protocol; bsky.network/docs/advanced-guides/posts and rate-limits, lexicons in github.com/bluesky-social/
//     atproto packages/api/lexicons, changed 2026-10-15): log in with an app password via com.atproto.server.createSession
//     {identifier, password} → {accessJwt, did, handle} at https://bsky.social; images via com.atproto.repo.uploadBlob (raw
//     bytes, Content-Type) → {blob}; com.atproto.repo.createRecord {repo: did, collection: app.bsky.feed.post, record:{text,
//     createdAt, facets (link: byteStart/byteEnd in UTF-8 bytes, app.bsky.richtext.facet#link {uri}), embed:
//     app.bsky.embed.images {images:[{alt (required), image: blob, aspectRatio}]}}} → {uri, cid}. Text: 300 graphemes and
//     3,000 bytes; up to 4 images of 2,000,000 bytes each. createSession: 30 per 5 minutes, 300 a day per account. There is
//     no draft or schedule on Bluesky itself: Palm only posts there now, with --now --confirm.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, chmodSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configDir } from './client.mjs';

const err = (m, code = 2) => Object.assign(new Error(m), { code });
export const SCHEDULERS = ['postiz', 'buffer', 'bluesky'];
const NAMES = { postiz: 'Postiz', buffer: 'Buffer', bluesky: 'Bluesky' };
export const socialDir = () => join(configDir(), 'social');

// ---- platforms: limits, each with where it came from ----
const S = {
  x: 'X docs "Counting characters", X API "Create Post" and media upload (read 2026-11-26)',
  bsky: 'lexicons app.bsky.feed.post and app.bsky.embed.images (2026-10-15)',
  threads: 'Threads API docs, Posts (read 2026-11-26)',
  li: 'LinkedIn Help "Share photos on LinkedIn" and the MultiImage API docs (read 2026-11-26)',
  postiz: 'Postiz docs, general/platforms/overview (read 2026-11-27)',
  pzcreate: 'Postiz docs, public-api/posts/create (read 2026-11-27)',
  buffer: 'Buffer API docs, guides/character-limits (read 2026-11-27)',
};
export const PLATFORMS = {
  x: { name: 'X', text: 280, count: 'x', images: 4, imageBytes: 5e6, altMax: 1000, src: S.x + '; 4,000 for verified accounts (' + S.postiz + ')' },
  bluesky: { name: 'Bluesky', text: 300, count: 'graphemes', textBytes: 3000, images: 4, imageBytes: 2e6, src: S.bsky },
  threads: { name: 'Threads', text: 500, images: 20, imageBytes: 8e6, aspectMax: 10, minWidth: 320, src: S.threads },
  linkedin: { name: 'LinkedIn', text: 3000, images: 20, imageBytes: 5e6, altMax: 4086, minW: 552, minH: 276, crop: [0.8, 3], src: S.li },
  instagram: { name: 'Instagram', text: 2200, needsMedia: true, altMax: 1000, src: S.postiz + '; alt text ' + S.pzcreate },
  facebook: { name: 'Facebook', text: 63206, src: S.postiz },
  mastodon: { name: 'Mastodon', text: 500, src: S.postiz + ' (the default; each server sets its own)' },
  pinterest: { name: 'Pinterest', text: 500, needsMedia: true, images: 5, src: S.postiz },
  tiktok: { name: 'TikTok', text: 2000, needsMedia: true, src: S.postiz },
  youtube: { name: 'YouTube', text: 5000, needsMedia: true, src: S.postiz },
  gmb: { name: 'Google Business Profile', text: 1500, images: 1, src: S.postiz },
};
// Where Buffer validates a different length (it counts UTF-16 units; Instagram line breaks count 2).
const BUFFER_TEXT = { facebook: 5000, instagram: 2196, gmb: 4000, tiktok: 4000 };
const ALIASES = { twitter: 'x', 'x-twitter': 'x', 'linkedin-page': 'linkedin', 'instagram-standalone': 'instagram', googlebusiness: 'gmb', google: 'gmb', bsky: 'bluesky' };
export const platformOf = (s) => { const k = String(s || '').toLowerCase(); return ALIASES[k] || (PLATFORMS[k] ? k : null); };

// ---- counting ----
const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
export const graphemes = (t) => [...seg.segment(String(t))].length;
const URL_RE = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'"]/g;
// X's weighted count (twitter-text v3): URLs count 23, emoji 2, letters in the common ranges 1, others (CJK…) 2.
export function xCount(t) {
  let n = 0; const rest = String(t).replace(URL_RE, () => { n += 23; return ''; });
  for (const { segment } of seg.segment(rest)) {
    if (/\p{Extended_Pictographic}/u.test(segment)) { n += 2; continue; }
    for (const ch of segment) { const c = ch.codePointAt(0); n += (c <= 4351 || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247)) ? 1 : 2; }
  }
  return n;
}
export function countText(text, platform, scheduler) {
  const p = PLATFORMS[platform] || {}, t = String(text || '');
  if (p.count === 'x') return { count: xCount(t), limit: p.text, how: "X's weighted count (links 23, emoji 2)" };
  if (p.count === 'graphemes') return { count: graphemes(t), limit: p.text, how: 'graphemes' };
  const limit = scheduler === 'buffer' && BUFFER_TEXT[platform] ? BUFFER_TEXT[platform] : p.text;
  const count = t.length + (scheduler === 'buffer' && platform === 'instagram' ? (t.match(/\n/g) || []).length : 0);
  return { count, limit, how: 'UTF-16 units' + (scheduler === 'buffer' && BUFFER_TEXT[platform] ? ` (Buffer's limit: ${S.buffer})` : '') };
}

// ---- images: type and size from the file's header ----
export function imageInfo(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: 'image/png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'GIF') return { type: 'image/gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const k = buf.toString('latin1', 12, 16);
    if (k === 'VP8X') return { type: 'image/webp', w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (k === 'VP8L') { const b = buf.readUInt32LE(21); return { type: 'image/webp', w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
    if (k === 'VP8 ') return { type: 'image/webp', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { type: 'image/jpeg', w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return { type: 'image/jpeg', w: 0, h: 0 };
  }
  return null;
}

// ---- time: a wall-clock time in a named zone, to UTC (explicit zones only) ----
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }; // the user's local day, as Invoice's TODAY()
export function validZone(tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }
const wall = (ms, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
};
const offsetMs = (ms, tz) => Date.parse(wall(ms, tz) + 'Z') - Math.floor(ms / 1000) * 1000;
export function nice(ms, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms) + ' ' + tz;
}
// "2026-12-01 09:30" (or T09:30, optional :ss) in tz → {utc, ms, local, tz, note}; an ISO time with Z or an offset is taken as is.
export function toUTC(when, tz = localZone()) {
  const w = String(when || '').trim();
  if (!validZone(tz)) throw err(`"${tz}" isn't a time zone (use an IANA name like Europe/London or America/New_York).`, 1);
  if (/(Z|[+-]\d\d:?\d\d)$/i.test(w)) { const ms = Date.parse(w); if (isNaN(ms)) throw err(`"${w}" isn't a date and time.`, 1); return { ms, utc: new Date(ms).toISOString(), local: nice(ms, tz), tz }; }
  const m = w.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw err(`"${w}" must be a date and time like 2026-12-01 09:30 (in ${tz}), or ISO with a Z or an offset.`, 1);
  const target = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}`, guess = Date.parse(target + 'Z');
  if (isNaN(guess) || new Date(guess).toISOString().slice(0, 19) !== target) throw err(`"${w}" isn't a real date and time.`, 1);
  const hits = [...new Set([offsetMs(guess - 864e5 / 2, tz), offsetMs(guess, tz), offsetMs(guess + 864e5 / 2, tz)].map((o) => guess - o))].filter((t) => wall(t, tz) === target).sort((a, b) => a - b);
  if (!hits.length) throw err(`${w} doesn't exist in ${tz} (the clocks go forward then). Pick another time.`, 1);
  const ms = hits[0];
  return { ms, utc: new Date(ms).toISOString(), local: nice(ms, tz), tz, ...(hits.length > 1 ? { note: `${w} happens twice in ${tz} (the clocks go back); Palm uses the first (${new Date(ms).toISOString()}).` } : {}) };
}

// ---- credentials: env first, else ~/.config/palm/social/<scheduler>.json (0600). Never printed. ----
const credFile = (s) => join(socialDir(), s + '.json');
export function creds(s) {
  const e = process.env;
  if (s === 'postiz' && e.POSTIZ_API_KEY) return { key: e.POSTIZ_API_KEY.trim(), url: e.POSTIZ_URL || '', from: 'env' };
  if (s === 'buffer' && e.BUFFER_API_KEY) return { key: e.BUFFER_API_KEY.trim(), org: e.BUFFER_ORG || readJson(credFile(s))?.org || '', from: 'env' };
  if (s === 'bluesky' && e.BLUESKY_APP_PASSWORD) return { identifier: (e.BLUESKY_HANDLE || '').trim(), password: e.BLUESKY_APP_PASSWORD.trim(), service: e.BLUESKY_SERVICE || '', from: 'env' };
  const c = readJson(credFile(s)); return c ? { ...c, from: 'file' } : null;
}
function readJson(f) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } }
function writePrivate(f, obj) { mkdirSync(dirname(f), { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 }); chmodSync(f, 0o600); return f; }
export function saveCreds(s, c) { const { from, ...keep } = c; return writePrivate(credFile(s), keep); }
export function forget(s) { const f = credFile(s), had = existsSync(f); rmSync(f, { force: true }); return had; }
export const connected = () => SCHEDULERS.filter((s) => { const c = creds(s); return c && (c.key || c.password); });
// Every secret this process knows, so nothing that is printed can carry one.
const SECRETS = new Set();
const remember = (...v) => v.filter((x) => x && String(x).length >= 6).forEach((x) => SECRETS.add(String(x)));
export function redact(s) { let t = typeof s === 'string' ? s : JSON.stringify(s); for (const k of SECRETS) t = t.split(k).join('[hidden]'); return typeof s === 'string' ? t : JSON.parse(t); }
const loadSecrets = () => SCHEDULERS.forEach((s) => { const c = creds(s); if (c) remember(c.key, c.password); });

// ---- HTTP ----
async function http(url, { method = 'GET', headers = {}, body, fetch: f = globalThis.fetch } = {}) {
  let res;
  try { res = await f(url, { method, headers: { 'user-agent': 'palm-cli/0.1', ...headers }, body }); }
  catch (e) { throw Object.assign(err(`Couldn't reach ${new URL(url).host}: ${e.message}`, 4), { network: true }); }
  const text = await res.text(); let j; try { j = text ? JSON.parse(text) : null; } catch { j = null; }
  if (!res.ok) {
    const msg = j?.message || j?.error || j?.errors?.[0]?.message || text.slice(0, 200);
    const hint = res.status === 401 ? ' (the key was refused: connect again)' : res.status === 429 ? ` (rate limit${res.headers.get('retry-after') ? `; try again in ${res.headers.get('retry-after')} s` : ''})` : '';
    throw Object.assign(err(redact(`${new URL(url).host} answered ${res.status}${hint}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`), 4), { status: res.status });
  }
  return j;
}

// ---- the schedulers ----
const postizBase = (c) => { const u = String(c.url || process.env.POSTIZ_URL || '').replace(/\/+$/, ''); return !u ? 'https://api.postiz.com/public/v1' : /\/public\/v1$/.test(u) ? u : u + '/api/public/v1'; };
const POSTIZ_SETTINGS = { x: { __type: 'x', who_can_reply_post: 'everyone' }, instagram: { __type: 'instagram', post_type: 'post' }, 'instagram-standalone': { __type: 'instagram-standalone', post_type: 'post' } };
const POSTIZ_PLAIN = ['linkedin', 'linkedin-page', 'facebook', 'threads', 'bluesky', 'mastodon', 'telegram', 'nostr', 'vk'];
const bufferUrl = () => process.env.BUFFER_API_URL || 'https://api.buffer.com';
const bskyUrl = (c) => String(c.service || process.env.BLUESKY_SERVICE || 'https://bsky.social').replace(/\/+$/, '');

export const API = {
  postiz: {
    draft: true, schedule: true, list: true,
    h: (c) => ({ authorization: c.key, accept: 'application/json' }),
    async verify(c, o) { const r = await http(postizBase(c) + '/is-connected', { headers: this.h(c), ...o }); if (r && r.connected === false) throw err('Postiz says this key is not connected.', 4); return {}; },
    async channels(c, o) { return (await http(postizBase(c) + '/integrations', { headers: this.h(c), ...o }) || []).map((i) => ({ scheduler: 'postiz', id: i.id, name: i.name || i.profile || i.id, handle: i.profile || '', kind: i.identifier, platform: platformOf(i.identifier) || i.identifier, disabled: !!i.disabled })); },
    async upload(c, file, o) {
      const fd = new FormData(); fd.append('file', new Blob([readFileSync(file)], { type: imageInfo(readFileSync(file))?.type || 'application/octet-stream' }), basename(file));
      return http(postizBase(c) + '/upload', { method: 'POST', headers: this.h(c), body: fd, ...o });
    },
    async create(c, it, mode, o) {
      const image = [];
      for (const im of it.images) { const u = await this.upload(c, im.path, o); image.push({ id: u.id, path: u.path, ...(im.alt ? { alt: im.alt } : {}) }); }
      const body = { type: mode, date: mode === 'now' ? new Date().toISOString() : (it.when?.utc || new Date().toISOString()), shortLink: false, tags: [], posts: [{ integration: { id: it.channel.id }, value: [{ content: it.text, image }], settings: it.settings }] };
      const r = await http(postizBase(c) + '/posts', { method: 'POST', headers: { ...this.h(c), 'content-type': 'application/json' }, body: JSON.stringify(body), ...o });
      const row = (Array.isArray(r) ? r : []).find((x) => x.integration === it.channel.id) || (Array.isArray(r) ? r[0] : null);
      if (!row?.postId) throw err('Postiz answered without a post id: ' + JSON.stringify(r).slice(0, 200), 4);
      return { id: row.postId };
    },
    async list(c, { from, to }, o) {
      const r = await http(`${postizBase(c)}/posts?startDate=${encodeURIComponent(from)}&endDate=${encodeURIComponent(to)}`, { headers: this.h(c), ...o });
      return (r?.posts || []).map((p) => ({ scheduler: 'postiz', id: p.id, channelId: p.integration?.id, at: p.publishDate, state: String(p.state || '').toLowerCase(), text: p.content || '' }));
    },
  },
  buffer: {
    draft: true, schedule: true, list: true,
    async gql(c, query, variables, o) {
      const r = await http(bufferUrl(), { method: 'POST', headers: { authorization: 'Bearer ' + c.key, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), ...o });
      if (r?.errors?.length) throw err(redact('Buffer: ' + r.errors.map((e) => e.message).join('; ')), 4);
      return r.data;
    },
    async orgs(c, o) { return (await this.gql(c, 'query { account { organizations { id name } } }', {}, o)).account.organizations; },
    async verify(c, o) {
      const orgs = await this.orgs(c, o);
      if (!c.org) { if (orgs.length === 1) return { org: orgs[0].id }; throw err(`Your Buffer key opens ${orgs.length} organizations; pick one with --org: ${orgs.map((g) => `${g.id} (${g.name})`).join(', ')}`, 2); }
      if (!orgs.some((g) => g.id === c.org)) throw err(`Buffer organization ${c.org} isn't one this key opens.`, 2);
      return { org: c.org };
    },
    async channels(c, o) {
      if (!c.org) throw err('No Buffer organization chosen: palm social connect buffer --org <id>.', 2);
      const d = await this.gql(c, 'query Channels($organizationId: OrganizationId!) { channels(input: { organizationId: $organizationId }) { id name displayName service type isDisconnected isLocked isQueuePaused timezone } }', { organizationId: c.org }, o);
      return d.channels.map((ch) => ({ scheduler: 'buffer', id: ch.id, name: ch.displayName || ch.name, handle: ch.name, kind: ch.service, type: ch.type, platform: platformOf(ch.service) || ch.service, disabled: !!(ch.isDisconnected || ch.isLocked), paused: !!ch.isQueuePaused, timezone: ch.timezone }));
    },
    input(it, mode) {
      const notify = (it.channel.kind === 'instagram' && it.channel.type === 'profile') || (it.channel.kind === 'facebook' && it.channel.type === 'group');
      const meta = it.platform === 'instagram' ? { instagram: { type: 'post', shouldShareToFeed: true, ...(it.settings || {}) } } : it.settings ? { [it.channel.kind]: it.settings } : undefined;
      return { text: it.text, channelId: it.channel.id, schedulingType: notify ? 'notification' : 'automatic', mode: mode === 'now' ? 'shareNow' : mode === 'schedule' ? 'customScheduled' : 'addToQueue', ...(mode === 'schedule' ? { dueAt: it.when.utc } : {}), ...(mode === 'draft' ? { saveToDraft: true } : {}), assets: it.images.map((im) => ({ image: { url: im.url, ...(im.alt ? { metadata: { altText: im.alt } } : {}) } })), ...(meta ? { metadata: meta } : {}) };
    },
    async create(c, it, mode, o) {
      const d = await this.gql(c, 'mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id dueAt status } } ... on MutationError { message } } }', { input: this.input(it, mode) }, o);
      const r = d.createPost; if (!r?.post?.id) throw Object.assign(err('Buffer refused the post: ' + (r?.message || 'no reason given'), 1), { status: 400 });
      return { id: r.post.id };
    },
    async list(c, { channelIds }, o) {
      const d = await this.gql(c, 'query Posts($input: PostsInput!) { posts(first: 100, input: $input) { edges { node { id text dueAt status channelId } } } }', { input: { organizationId: c.org, filter: { status: ['draft', 'scheduled'], ...(channelIds?.length ? { channelIds } : {}) } } }, o);
      return d.posts.edges.map(({ node: p }) => ({ scheduler: 'buffer', id: p.id, channelId: p.channelId, at: p.dueAt, state: p.status, text: p.text || '' }));
    },
  },
  bluesky: {
    draft: false, schedule: false, list: false,
    async session(c, o) {
      const s = await http(bskyUrl(c) + '/xrpc/com.atproto.server.createSession', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: c.identifier, password: c.password }), ...o });
      remember(s.accessJwt, s.refreshJwt); return s;
    },
    async verify(c, o) { const s = await this.session(c, o); await http(bskyUrl(c) + '/xrpc/com.atproto.server.getSession', { headers: { authorization: 'Bearer ' + s.accessJwt }, ...o }); return { identifier: s.handle, did: s.did }; },
    async channels(c, o) { const s = await this.session(c, o); return [{ scheduler: 'bluesky', id: s.did, name: s.handle, handle: s.handle, kind: 'bluesky', platform: 'bluesky', disabled: false }]; },
    async create(c, it, mode, o) {
      if (mode !== 'now') throw err('Bluesky has no drafts or scheduling.', 2);
      const s = await this.session(c, o), auth = { authorization: 'Bearer ' + s.accessJwt };
      const images = [];
      for (const im of it.images) {
        const b = readFileSync(im.path), info = imageInfo(b);
        const r = await http(bskyUrl(c) + '/xrpc/com.atproto.repo.uploadBlob', { method: 'POST', headers: { ...auth, 'content-type': info?.type || 'application/octet-stream' }, body: b, ...o });
        images.push({ alt: im.alt || '', image: r.blob, ...(info?.w && info?.h ? { aspectRatio: { width: info.w, height: info.h } } : {}) });
      }
      const record = { $type: 'app.bsky.feed.post', text: it.text, createdAt: new Date().toISOString(), ...(it.langs ? { langs: it.langs } : {}), ...(linkFacets(it.text).length ? { facets: linkFacets(it.text) } : {}), ...(images.length ? { embed: { $type: 'app.bsky.embed.images', images } } : {}) };
      const r = await http(bskyUrl(c) + '/xrpc/com.atproto.repo.createRecord', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ repo: s.did, collection: 'app.bsky.feed.post', record }), ...o });
      return { id: r.uri, url: `https://bsky.app/profile/${s.handle}/post/${String(r.uri).split('/').pop()}` };
    },
  },
};
// Links in the text as Bluesky facets (UTF-8 byte offsets), so they are clickable.
export function linkFacets(text) {
  const t = String(text), out = [];
  for (const m of t.matchAll(URL_RE)) { const s = Buffer.byteLength(t.slice(0, m.index)); out.push({ index: { byteStart: s, byteEnd: s + Buffer.byteLength(m[0]) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }] }); }
  return out;
}

// ---- connect / channels ----
const cacheFile = () => join(socialDir(), 'channels.json');
export const cachedChannels = () => readJson(cacheFile())?.channels || [];
function cacheChannels(s, list) { const keep = cachedChannels().filter((c) => c.scheduler !== s); writePrivate(cacheFile(), { at: new Date().toISOString(), channels: [...keep, ...list] }); }

export async function connect(s, c, { fetch } = {}) {
  if (!SCHEDULERS.includes(s)) throw err(`Connect postiz, buffer or bluesky (not "${s}").`);
  if (s === 'bluesky' ? !(c.identifier && c.password) : !c.key) throw err(s === 'bluesky' ? 'Bluesky needs your handle and an app password (Settings → Privacy and security → App passwords; never your main password).' : `${NAMES[s]} needs an API key.`);
  remember(c.key, c.password);
  const extra = await API[s].verify(c, { fetch });
  const full = { ...c, ...extra };
  const channels = await API[s].channels(full, { fetch });
  const file = c.from === 'env' ? null : saveCreds(s, full);
  if (c.from === 'env' && s === 'buffer' && extra.org) writePrivate(credFile(s), { org: extra.org });
  cacheChannels(s, channels);
  return { scheduler: s, channels: channels.length, saved: file, from: c.from === 'env' ? 'environment' : 'file' };
}
export async function channels({ scheduler, fetch } = {}) {
  const list = scheduler ? [scheduler] : connected();
  if (!list.length) throw err('Nothing connected yet: palm social connect postiz|buffer|bluesky.', 2);
  const out = [], problems = [];
  for (const s of list) {
    const c = creds(s); if (!c) { problems.push(`${NAMES[s]}: not connected`); continue; }
    try { const ch = await API[s].channels(c, { fetch }); cacheChannels(s, ch); out.push(...ch); } catch (e) { problems.push(`${NAMES[s]}: ${e.message}`); }
  }
  return { channels: out, problems };
}

// ---- the bundle ----
// {name?, timeZone?, when?, link?, images?:[{file, alt, url?}], posts:[{to, platform?, text, images?, when?, settings?, langs?}]}
// "to": [postiz:|buffer:|bluesky:]<channel id, name, handle or platform>. Image paths are relative to the bundle.
export function readBundle(src) {
  if (src && typeof src === 'object') return { bundle: src, dir: process.cwd(), path: '' };
  let p = resolve(String(src || ''));
  if (!existsSync(p)) throw err(`No such file: ${src}`);
  if (statSync(p).isDirectory()) { const f = ['post.json', 'posts.json'].map((n) => join(p, n)).find(existsSync); if (!f) throw err(`${src} has no post.json. A bundle: {"timeZone":"Europe/London","when":"2026-12-01 09:30","link":"https://…","images":[{"file":"01.jpg","alt":"…"}],"posts":[{"to":"linkedin","text":"…"}]}`); p = f; }
  let bundle; try { bundle = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw err(`${p} isn't valid JSON: ${e.message}`); }
  return { bundle, dir: dirname(p), path: p };
}

function resolveChannel(to, platform, chans) {
  const raw = String(to || '').trim(), m = raw.match(/^(postiz|buffer|bluesky):(.*)$/i);
  const sched = m ? m[1].toLowerCase() : null, ref = (m ? m[2] : raw).trim(), low = ref.toLowerCase().replace(/^@/, '');
  const pool = chans.filter((c) => !sched || c.scheduler === sched);
  let hit = pool.filter((c) => c.id === ref);
  if (!hit.length) hit = pool.filter((c) => [c.name, c.handle].some((n) => String(n || '').toLowerCase().replace(/^@/, '') === low));
  if (!hit.length && platformOf(low)) hit = pool.filter((c) => c.platform === platformOf(low) && (!platform || c.platform === platform));
  if (hit.length > 1 && !sched) { const direct = hit.filter((c) => c.scheduler !== 'bluesky'); if (direct.length === 1) hit = direct; }
  return { sched, ref, hit };
}

// check: every post against its platform's sourced limits; problems reported, nothing changed. No network.
export function check(src, { now = Date.now(), chans = cachedChannels(), tools = false, out = 'palm-social/check', toolsDir, ignorePast = false } = {}) {
  const { bundle: b, dir, path } = readBundle(src);
  const errors = [], warnings = [];
  const tz = b.timeZone || b.timezone || localZone();
  if (!validZone(tz)) errors.push(`timeZone "${tz}" isn't a time zone (use an IANA name like Europe/London).`);
  if (!Array.isArray(b.posts) || !b.posts.length) errors.push('posts is empty: [{"to":"linkedin","text":"…"}].');
  const link = String(b.link || '').trim();
  if (link && !/^https:\/\//i.test(link)) warnings.push(`link "${link}" isn't https://.`);
  const loadImg = (im, i) => {
    const o = { file: im.file || '', url: im.url || '', alt: String(im.alt ?? '').trim() };
    if (o.file) { o.path = resolve(dir, o.file); if (existsSync(o.path)) { const buf = readFileSync(o.path); o.bytes = buf.length; Object.assign(o, imageInfo(buf) || {}); } else o.missing = true; }
    if (o.url && !/^https:\/\//i.test(o.url)) o.badUrl = true;
    o.n = i + 1; return o;
  };
  const posts = (b.posts || []).map((p, i) => {
    const e = [], w = [], label = `post ${i + 1} (${p.to || '?'})`;
    const r = resolveChannel(p.to, platformOf(p.platform), chans);
    let channel = r.hit.length === 1 ? r.hit[0] : null;
    const platform = platformOf(p.platform) || channel?.platform || platformOf(r.ref) || null;
    const scheduler = channel?.scheduler || r.sched || (platform === 'bluesky' && chans.some((c) => c.scheduler === 'bluesky') ? 'bluesky' : null);
    if (!p.to) e.push('"to" is missing (a channel: its id, name or platform, optionally scheduler: first, e.g. "postiz:linkedin").');
    else if (r.hit.length > 1) e.push(`"${p.to}" matches ${r.hit.length} channels (${r.hit.map((c) => `${c.scheduler}:${c.id} ${c.name}`).join(', ')}); use the scheduler: and the channel id.`);
    else if (!channel && chans.length) e.push(`"${p.to}" isn't a connected channel (palm social channels lists them).`);
    else if (!channel) w.push(`"${p.to}" isn't matched to a channel yet (nothing connected); checked as ${platform || 'an unknown platform'}.`);
    if (!platform) e.push(`Palm doesn't know which platform "${p.to}" is; add "platform" (${Object.keys(PLATFORMS).join(', ')}).`);
    if (channel?.disabled) e.push(`${channel.name} is disconnected or locked in ${NAMES[channel.scheduler]}: reconnect it there.`);
    if (channel?.paused) w.push(`${channel.name}'s queue is paused in Buffer: scheduled posts won't go out until it's resumed.`);
    const L = PLATFORMS[platform] || {};
    const text = String(p.text ?? '');
    const images = (Array.isArray(p.images) ? p.images : (b.images || [])).map(loadImg);
    if (!text.trim() && !images.length) e.push('no text and no images.');
    const cnt = countText(text, platform, scheduler);
    if (cnt.limit && cnt.count > cnt.limit) e.push(`${cnt.count} characters (${cnt.how}); ${L.name}'s limit is ${cnt.limit}. Source: ${L.src}.`);
    if (L.textBytes && Buffer.byteLength(text) > L.textBytes) e.push(`${Buffer.byteLength(text)} bytes; Bluesky's limit is ${L.textBytes}.`);
    if (platform === 'mastodon') w.push('Mastodon: 500 is the default; your server may allow more or fewer.');
    if (L.needsMedia && !images.length) e.push(`${L.name} needs at least one image or video (${S.postiz}).`);
    if (L.images && images.length > L.images) e.push(`${images.length} images; ${L.name} takes ${L.images} at most. Source: ${L.src}.`);
    for (const im of images) {
      const n = `image ${im.n}${im.file ? ` (${im.file})` : ''}`;
      if (!im.file && !im.url) e.push(`${n}: needs "file" (or "url").`);
      if (im.missing) e.push(`${n}: no such file (${im.path}).`);
      if (im.badUrl) e.push(`${n}: url must be https://.`);
      if (!im.alt) e.push(`${n}: no alt text. Describe it (and any words printed in it) for people who can't see it.`);
      if (L.altMax && im.alt.length > L.altMax) e.push(`${n}: alt text is ${im.alt.length} characters; ${L.name} takes ${L.altMax}.`);
      if (im.file && !im.missing && !im.type) e.push(`${n}: not a PNG, JPEG, GIF or WebP.`);
      if (im.bytes && L.imageBytes && im.bytes > L.imageBytes) e.push(`${n}: ${(im.bytes / 1e6).toFixed(2)} MB; ${L.name} takes ${(L.imageBytes / 1e6).toFixed(L.imageBytes % 1e6 ? 1 : 0)} MB (${L.imageBytes.toLocaleString('en')} bytes) at most. Source: ${L.src}.`);
      if (im.w && im.h) {
        const ar = im.w / im.h;
        if (L.aspectMax && Math.max(ar, 1 / ar) > L.aspectMax) e.push(`${n}: ${im.w}×${im.h} is past ${L.name}'s ${L.aspectMax}:1.`);
        if (L.minWidth && im.w < L.minWidth) e.push(`${n}: ${im.w} px wide; ${L.name} needs ${L.minWidth} or more.`);
        if (L.minW && (im.w < L.minW || im.h < L.minH)) e.push(`${n}: ${im.w}×${im.h}; ${L.name} needs at least ${L.minW}×${L.minH}.`);
        if (L.crop && (ar < L.crop[0] || ar > L.crop[1])) w.push(`${n}: ${im.w}×${im.h} is outside ${L.name}'s 4:5 to 3:1; it is centred and cropped.`);
      }
      if (scheduler === 'buffer' && !im.url) e.push(`${n}: Buffer takes images only as public, stable https URLs (it has no upload); add "url".`);
      if ((scheduler === 'postiz' || scheduler === 'bluesky') && !im.file) e.push(`${n}: Palm uploads the local file to ${NAMES[scheduler]}; add "file".`);
    }
    if (scheduler === 'postiz' && channel && !p.settings && !POSTIZ_SETTINGS[channel.kind] && !POSTIZ_PLAIN.includes(channel.kind)) e.push(`Postiz needs settings for ${channel.kind} (e.g. a board, a title): add "settings": {"__type": "${channel.kind}", …} from docs.postiz.com/public-api/providers.`);
    if (link && !text.includes(link)) w.push(`the link (${link}) isn't in the text.`);
    if (!link && !/https?:\/\//.test(text)) w.push('no link in the post.');
    let when = null; const ws = p.when || b.when;
    if (ws) { try { when = toUTC(ws, p.timeZone || tz); if (when.note) w.push(when.note); if (when.ms <= now && !ignorePast) e.push(`${when.local} is in the past.`); } catch (x) { e.push(x.message); } }
    return { n: i + 1, to: p.to, label, scheduler, channel: channel ? { id: channel.id, name: channel.name, kind: channel.kind, type: channel.type } : null, platform, text, chars: cnt, images: images.map(({ n: _, ...im }) => im), when, settings: p.settings || (channel?.scheduler === 'postiz' ? POSTIZ_SETTINGS[channel.kind] || { __type: channel.kind } : undefined), langs: p.langs, errors: e, warnings: w };
  });
  const res = { bundle: path || '(inline)', name: b.name || (path ? basename(dirname(path)) + '/' + basename(path) : 'inline'), timeZone: tz, link, errors, warnings, posts, tools: [] };
  if (tools) res.tools = runTools(res, { out, toolsDir });
  res.ok = !errors.length && posts.every((p) => !p.errors.length) && res.tools.every((t) => t.ok !== false);
  return res;
}

// Palm's own check tools, when they are on this machine (./palm/tools from `palm tool`, PALM_TOOLS_DIR, or this repo).
const here = dirname(fileURLToPath(import.meta.url));
export function findTool(name, toolsDir) {
  return [toolsDir, process.env.PALM_TOOLS_DIR, join(process.cwd(), 'palm', 'tools'), join(here, '..', '..', 'tools')].filter(Boolean).map((d) => join(d, name + '.mjs')).find(existsSync) || null;
}
const lastJson = (s) => { const t = String(s || '').trim(); try { return JSON.parse(t); } catch {} const i = t.indexOf('{'); try { return JSON.parse(t.slice(i)); } catch { return null; } };
function runTool(file, args) {
  const r = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', timeout: 240e3, maxBuffer: 64e6 });
  const j = lastJson(r.stdout);
  if (!j) return { ran: false, error: (r.error?.message || r.stderr || r.stdout || 'no output').trim().split('\n').slice(-3).join(' ').slice(0, 300) };
  return { ran: true, ok: j.ok !== false, errors: (j.issues || j.errors || []).filter((x) => typeof x !== 'object' || x.level === 'error' || x.severity === 'error').length, sheet: j.sheet || null, score: j.score, issues: (j.issues || []).slice(0, 12).map((x) => (typeof x === 'string' ? x : x.message || x.msg || JSON.stringify(x))) };
}
const MULTI = { x: 'X', bluesky: 'Bluesky', threads: 'Threads', facebook: 'Facebook', linkedin: 'LinkedIn' };
function runTools(res, { out, toolsDir }) {
  const found = [], mic = findTool('multi-image-check', toolsDir), sp = findTool('share-preview', toolsDir);
  if (mic) for (const p of res.posts) {
    const imgs = p.images.filter((im) => im.path && !im.missing);
    if (imgs.length < 2 || !MULTI[p.platform]) continue;
    const d = mkdtempSync(join(tmpdir(), 'palm-social-'));
    const names = imgs.map((im, k) => { const n = `${String(k + 1).padStart(2, '0')}-${basename(im.path).replace(/^\d+[-_ ]/, '')}`; copyFileSync(im.path, join(d, n)); return n; });
    writeFileSync(join(d, 'alt.txt'), imgs.map((im, k) => `${names[k]}: ${im.alt.replace(/\n/g, ' ')}`).join('\n') + '\n');
    writeFileSync(join(d, 'post.md'), `## ${MULTI[p.platform]}\n\n${p.text}\n`);
    found.push({ tool: 'multi-image-check', post: p.n, ...runTool(mic, ['check', d, '--out', resolve(out, `post-${p.n}`)]) });
  }
  if (sp && /^https:\/\//i.test(res.link)) found.push({ tool: 'share-preview', link: res.link, ...runTool(sp, [res.link, '--out', resolve(out, 'share')]) });
  if (!mic && !sp) found.push({ tool: 'none', ran: false, note: "Palm's check tools aren't on this machine (palm tool multi-image-check; palm tool share-preview) – skipped." });
  return found;
}

// ---- the ledger: what Palm queued, with the scheduler's id. Rerunning a bundle never queues a post twice. ----
export const ledgerPath = (p) => resolve(p || process.env.PALM_SOCIAL_LEDGER || join(socialDir(), 'ledger.json'));
export function loadLedger(p) { return readJson(ledgerPath(p)) || { entries: [] }; }
export function saveLedger(L, p) { return writePrivate(ledgerPath(p), L); }
const sha = (x) => createHash('sha256').update(x).digest('hex');
export function keyOf(it) {
  const imgs = it.images.map((im) => (im.path && existsSync(im.path) ? sha(readFileSync(im.path)) : im.url));
  return sha(JSON.stringify([it.scheduler, it.channel?.id, it.text, imgs, it.when?.utc || null])).slice(0, 20);
}

// queue: dry run by default; --confirm sends. Drafts unless --schedule; "now" only with --now --confirm.
export async function queue(src, { schedule = false, now: postNow = false, confirm = false, again = false, ledger, fetch, nowMs = Date.now(), refresh = true } = {}) {
  loadSecrets();
  const mode = postNow ? 'now' : schedule ? 'schedule' : 'draft';
  const c = check(src, { now: nowMs, ignorePast: mode === 'now' });
  const L = loadLedger(ledger), plan = [], skipped = [], problems = [];
  for (const p of c.posts) {
    const row = { n: p.n, to: p.to, scheduler: p.scheduler, channel: p.channel?.name || p.to, platform: p.platform, mode, at: mode === 'now' ? 'now' : p.when ? p.when.local : null, utc: mode === 'now' ? null : p.when?.utc || null, text: p.text.length > 90 ? p.text.slice(0, 89) + '…' : p.text, images: p.images.length, notes: [] };
    if (p.errors.length) { problems.push(...p.errors.map((e) => `${p.label}: ${e}`)); continue; }
    if (!p.scheduler || !p.channel) { problems.push(`${p.label}: not matched to a connected channel (palm social connect …, then palm social channels).`); continue; }
    if (p.scheduler === 'bluesky' && mode !== 'now') { skipped.push({ ...row, why: 'Bluesky has no drafts or scheduling: queue it through Postiz or Buffer, or post it at the time with --now --confirm.' }); continue; }
    if (mode === 'schedule' && !p.when) { problems.push(`${p.label}: --schedule needs a time ("when", in ${c.timeZone} unless it says otherwise).`); continue; }
    if (mode === 'draft' && p.scheduler === 'buffer' && p.when) row.notes.push(`Buffer drafts carry no time; set ${p.when.local} in Buffer, or use --schedule.`);
    if (p.scheduler === 'buffer' && API.buffer.input({ ...p, images: p.images }, mode).schedulingType === 'notification') row.notes.push('This channel only takes reminders: Buffer notifies your phone at the time and someone posts it by hand.');
    if (p.scheduler === 'postiz' && p.images.length) row.notes.push(`uploads ${p.images.length} image${p.images.length > 1 ? 's' : ''} to Postiz`);
    const key = keyOf(p), had = L.entries.find((x) => x.key === key);
    if (had && !again) {
      skipped.push({ ...row, why: had.status === 'queued' ? `already queued (${NAMES[had.scheduler]} ${had.mode}, id ${had.remoteId}, ${had.queuedAt.slice(0, 10)}); --again queues a second copy` : `an earlier run's result is unknown (${had.status}); check ${NAMES[had.scheduler]}, then rerun with --again if it isn't there` });
      continue;
    }
    plan.push({ ...row, key, item: p });
  }
  const view = (r) => { const { item, ...v } = r; return v; };
  const notes = [...new Set(c.posts.flatMap((p) => p.warnings.map((w) => `${p.label}: ${w}`)))];
  if (problems.length || !confirm) {
    return { dry: true, mode, ok: !problems.length, problems, warnings: notes, plan: plan.map(view), skipped, note: problems.length ? 'Fix these first; nothing was sent.' : plan.length ? `Dry run: nothing was sent. ${mode === 'now' ? 'This would post NOW. ' : ''}Show this to the person; when they say yes, run it again with --confirm.` : 'Nothing to queue.' };
  }
  // --confirm: refresh the channel list once (a read), then send one post at a time, recording each as it goes.
  if (refresh) for (const s of [...new Set(plan.map((r) => r.scheduler))]) { const live = await API[s].channels(creds(s), { fetch }); cacheChannels(s, live); for (const r of plan.filter((x) => x.scheduler === s)) if (!live.some((ch) => ch.id === r.item.channel.id)) throw err(`${r.channel} is no longer in ${NAMES[s]}; nothing was sent.`, 1); }
  const sent = [], failed = [];
  for (const r of plan) {
    const cr = creds(r.scheduler), entry = { key: r.key, status: 'sending', scheduler: r.scheduler, channelId: r.item.channel.id, channel: r.channel, platform: r.platform, mode, at: r.utc, local: r.at, timeZone: c.timeZone, bundle: c.name, text: r.text, startedAt: new Date().toISOString() };
    L.entries = L.entries.filter((x) => x.key !== r.key); L.entries.push(entry); saveLedger(L, ledger);
    try {
      const res = await API[r.scheduler].create(cr, r.item, mode, { fetch });
      Object.assign(entry, { status: 'queued', remoteId: res.id, url: res.url, queuedAt: new Date().toISOString() }); delete entry.startedAt;
      sent.push({ ...view(r), id: res.id, url: res.url });
    } catch (e) {
      if (e.status) L.entries = L.entries.filter((x) => x !== entry); else entry.status = 'unknown';
      failed.push({ ...view(r), error: redact(e.message), unknown: !e.status });
    }
    saveLedger(L, ledger);
  }
  return { dry: false, mode, ok: !failed.length, sent, failed, skipped, warnings: notes, ledger: ledgerPath(ledger), note: sent.length ? (mode === 'now' ? 'Posted.' : mode === 'schedule' ? 'Queued in your scheduler: it posts at those times (its queue, retries and tokens do the rest).' : 'Saved as drafts in your scheduler: open it to review and schedule them.') : 'Nothing was sent.' };
}

// list: what Palm queued (the ledger) and, where the scheduler can list, its drafts and scheduled posts.
export async function list({ ledger, local = false, fetch, nowMs = Date.now() } = {}) {
  loadSecrets();
  const L = loadLedger(ledger), entries = [...L.entries].sort((a, b) => String(a.at || a.queuedAt).localeCompare(String(b.at || b.queuedAt)));
  const remote = [], problems = [];
  if (!local) for (const s of connected().filter((x) => API[x].list)) {
    try {
      const mine = entries.filter((e) => e.scheduler === s && e.at).map((e) => Date.parse(e.at));
      const from = new Date(Math.min(nowMs - 864e5, ...mine)).toISOString(), to = new Date(Math.max(nowMs + 60 * 864e5, ...mine.map((t) => t + 864e5))).toISOString();
      const rows = await API[s].list(creds(s), { from, to }, { fetch });
      remote.push(...rows.map((r) => ({ ...r, palm: entries.some((e) => e.scheduler === s && e.remoteId === r.id), text: r.text.length > 90 ? r.text.slice(0, 89) + '…' : r.text })));
    } catch (e) { problems.push(`${NAMES[s]}: ${redact(e.message)}`); }
  }
  return { entries, remote, problems, ledger: ledgerPath(ledger) };
}

// ---- Pro: checked against Palm once a day, cached. Only the Palm key goes to Palm, never the posts or scheduler keys. ----
export async function proOk({ check: chk, now = Date.now() } = {}) {
  const dir = socialDir(), f = join(dir, 'pro.json');
  try { const c = JSON.parse(readFileSync(f, 'utf8')); if (c.ok && now - c.at < 86400e3) return true; } catch {}
  const ok = !!(await chk());
  mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify({ ok, at: now }), { mode: 0o600 });
  return ok;
}

// ---- text for people ----
export function checkText(r) {
  const lines = [`${r.name} · times in ${r.timeZone}`];
  for (const e of r.errors) lines.push('  ✗ ' + e);
  for (const w of r.warnings) lines.push('  ! ' + w);
  for (const p of r.posts) {
    lines.push(`\n${p.n}. ${p.to} → ${p.channel ? `${NAMES[p.scheduler]}: ${p.channel.name}` : p.scheduler ? NAMES[p.scheduler] : 'not connected'} (${PLATFORMS[p.platform]?.name || p.platform || '?'})${p.when ? ' · ' + p.when.local : ''}`);
    lines.push(`   ${p.chars.count}/${p.chars.limit || '?'} characters · ${p.images.length} image${p.images.length === 1 ? '' : 's'}${p.images.length ? ' (' + p.images.map((im) => (im.w ? `${im.w}×${im.h}` : '?') + (im.bytes ? ` ${(im.bytes / 1e6).toFixed(2)} MB` : '')).join(', ') + ')' : ''}`);
    for (const e of p.errors) lines.push('   ✗ ' + e);
    for (const w of p.warnings) lines.push('   ! ' + w);
  }
  for (const t of r.tools) lines.push(t.tool === 'none' ? '\n' + t.note : `\n${t.tool}${t.post ? ' (post ' + t.post + ')' : ''}: ${t.ran ? (t.ok ? 'ok' : 'problems') + (t.sheet ? ` · look at ${t.sheet}` : '') + (t.issues?.length ? '\n   ' + t.issues.join('\n   ') : '') : "couldn't run: " + t.error}`);
  lines.push('\n' + (r.ok ? 'No problems. Palm changed nothing.' : 'Problems above (✗); Palm changed nothing.'));
  return lines.join('\n');
}
export function queueText(r) {
  const row = (x) => `  ${x.n}. ${NAMES[x.scheduler] || '?'} · ${x.channel} · ${x.mode === 'now' ? 'NOW' : x.mode === 'schedule' ? x.at : 'draft' + (x.at ? ` (for ${x.at})` : '')}${x.images ? ` · ${x.images} image${x.images > 1 ? 's' : ''}` : ''}\n     "${x.text}"${x.id ? `\n     id ${x.id}${x.url ? ' · ' + x.url : ''}` : ''}${(x.notes || []).map((n) => '\n     note: ' + n).join('')}`;
  return [
    ...(r.problems?.length ? ['Problems:', ...r.problems.map((p) => '  ✗ ' + p), ''] : []),
    ...(r.dry && r.plan.length ? [`Would send (${r.mode}):`, ...r.plan.map(row)] : []),
    ...(r.sent?.length ? [`Sent (${r.mode}):`, ...r.sent.map(row)] : []),
    ...(r.failed?.length ? ['Failed:', ...r.failed.map((x) => `  ${x.n}. ${x.channel}: ${x.error}${x.unknown ? ' (no answer: check the scheduler before running again)' : ''}`)] : []),
    ...(r.skipped?.length ? ['Skipped:', ...r.skipped.map((x) => `  ${x.n}. ${x.channel}: ${x.why}`)] : []),
    ...(r.warnings?.length ? ['Notes:', ...r.warnings.map((w) => '  ! ' + w)] : []),
    '', r.note,
  ].join('\n');
}
export function listText(r) {
  const lines = r.entries.length ? ['Queued by Palm:', ...r.entries.map((e) => `  ${e.status === 'queued' ? ' ' : '?'} ${(e.local || (e.mode === 'now' ? 'posted ' + (e.queuedAt || '').slice(0, 16).replace('T', ' ') : 'draft')).padEnd(34)} ${NAMES[e.scheduler]} · ${e.channel} · ${e.mode}${e.remoteId ? ' · id ' + e.remoteId : ' · ' + e.status}\n      "${e.text}"`)] : ['Palm has queued nothing yet.'];
  if (r.remote.length) lines.push('', 'In your scheduler (drafts and scheduled):', ...r.remote.map((x) => `  ${x.palm ? '•' : ' '} ${String(x.at || '').slice(0, 16).replace('T', ' ').padEnd(17)} ${NAMES[x.scheduler]} · ${x.state} · "${x.text}"`), '  (• = queued by Palm)');
  for (const p of r.problems) lines.push('! ' + p);
  return lines.join('\n');
}

export const HELP = `palm social: Palm's social desk. Checks the week's posts, then hands them to the scheduler you already use
(Postiz or Buffer) through its own API with your own key, or posts straight to Bluesky. Runs here. Nothing is sent
without --confirm; drafts by default; never "now" unless --now --confirm. Keys are never printed.

  palm social connect postiz [--url https://your-postiz]   key from POSTIZ_API_KEY, else asked for (hidden); checked read-only
  palm social connect buffer [--org <id>]           key from BUFFER_API_KEY, else asked for (publish.buffer.com/settings/api)
  palm social connect bluesky --handle you.bsky.social     an app password from BLUESKY_APP_PASSWORD, else asked for
  palm social disconnect postiz|buffer|bluesky      forget the saved key
  palm social channels                             your connected channels (ids and names to put in "to")
  palm social check <post.json|folder> [--no-tools] [--out dir]   each post against its platform's limits (sourced):
                                                   length, images (count, size, shape), alt text, the link, the time;
                                                   runs Palm's multi-image-check and share-preview when they're here
  palm social queue <bundle>                       dry run: exactly what would go where and when (Pro)
  palm social queue <bundle> --confirm             send them as drafts in your scheduler (Pro)
  palm social queue <bundle> --schedule --confirm  into the scheduler's queue at each post's time (Pro)
  palm social queue <bundle> --now --confirm       post now (the only way Bluesky is posted) (Pro)
                                                   [--again] queue a post Palm already queued once more
  palm social list [--local]                       what Palm queued, and your scheduler's drafts and scheduled posts (Pro)
  palm social-mcp                                  the same as a local MCP server (stdio)

post.json: {"timeZone":"Europe/London","when":"2026-12-01 09:30","link":"https://…",
  "images":[{"file":"01.jpg","alt":"…","url":"https://… (Buffer needs a public URL)"}],
  "posts":[{"to":"linkedin","text":"…"},{"to":"postiz:x","text":"…","when":"2026-12-01 12:00"},{"to":"bluesky","text":"…","images":[]}]}
"to": a channel id, name, handle or platform, optionally with the scheduler first (postiz:, buffer:, bluesky:).
Times are wall-clock in timeZone (default: this machine's, ${localZone()}), or ISO with Z or an offset.
Keys: ~/.config/palm/social/<scheduler>.json (only you can read it), or env POSTIZ_API_KEY (+ POSTIZ_URL), BUFFER_API_KEY
(+ BUFFER_ORG), BLUESKY_HANDLE + BLUESKY_APP_PASSWORD. Ledger: ~/.config/palm/social/ledger.json (or PALM_SOCIAL_LEDGER).`;

// Reads a secret without echoing it (a terminal), or from piped stdin.
async function askHidden(q) {
  const input = process.stdin;
  if (!input.isTTY) { let s = ''; for await (const d of input) s += d; return s.trim(); }
  process.stderr.write(q);
  return new Promise((done) => {
    let s = ''; input.setRawMode(true); input.resume(); input.setEncoding('utf8');
    const on = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { input.setRawMode(false); input.pause(); input.off('data', on); process.stderr.write('\n'); return done(s.trim()); }
        if (c === '\u0003') { input.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
    };
    input.on('data', on);
  });
}

export async function cli(a, { print, fail, pro, fetch, ask = askHidden }) {
  const VAL = ['--url', '--org', '--handle', '--service', '--out', '--ledger', '--scheduler'];
  const opt = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  const has = (n) => a.includes('--' + n);
  const pos = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && VAL.includes(a[i - 1])));
  const [sub, ...p] = pos;
  if (!sub || sub === 'help') { fail(HELP); return 2; }
  loadSecrets();
  const say = (t, x) => print(redact(t), x === undefined ? undefined : redact(x));
  let code = 0; const run = async (f) => { try { return await f(); } catch (e) { code = e.code || 4; fail(redact(e.message), code); return null; } };
  const needPro = async (what) => { if (await pro()) return true; print(`${what} is part of Palm Pro (connect, channels and check are free). Run \`palm login\` (or set PALM_KEY). About Pro: https://www.yuzool.com/palm/#pro`, { locked: true }); return false; };
  switch (sub) {
    case 'connect': {
      const s = String(p[0] || '').toLowerCase();
      if (!SCHEDULERS.includes(s)) { fail(HELP); return 2; }
      let c = creds(s);
      const fromEnv = c?.from === 'env';
      if (!fromEnv) {
        if (s === 'bluesky') { const identifier = opt('handle') || c?.identifier; if (!identifier) { fail('Give your handle: palm social connect bluesky --handle you.bsky.social', 2); return 2; } c = { identifier, password: await ask('Bluesky app password (Settings → Privacy and security → App passwords; not your main password): '), service: opt('service', c?.service || '') }; }
        else c = { key: await ask(`${NAMES[s]} API key (${s === 'buffer' ? 'publish.buffer.com/settings/api' : 'Postiz → Settings → Developers'}): `), ...(s === 'postiz' ? { url: opt('url', c?.url || '') } : { org: opt('org', c?.org || '') }) };
      } else { if (opt('org')) c.org = opt('org'); if (opt('url')) c.url = opt('url'); }
      const x = await run(() => connect(s, c, { fetch })); if (!x) return code;
      say(`Connected to ${NAMES[s]}: ${x.channels} channel${x.channels === 1 ? '' : 's'} (palm social channels lists them). ${x.saved ? `Key saved to ${x.saved} (only you can read it).` : 'Using the key from the environment (not saved).'}`, x);
      return 0;
    }
    case 'disconnect': { const s = String(p[0] || '').toLowerCase(); if (!SCHEDULERS.includes(s)) { fail(HELP); return 2; } const had = forget(s); say(had ? `${NAMES[s]} key removed.` : `No saved ${NAMES[s]} key.`, { removed: had }); return 0; }
    case 'channels': {
      const x = await run(() => channels({ scheduler: opt('scheduler'), fetch })); if (!x) return code;
      say((x.channels.map((c) => `${(c.scheduler + ':' + c.id).padEnd(40)} ${String(PLATFORMS[c.platform]?.name || c.kind).padEnd(12)} ${c.name}${c.handle && c.handle !== c.name ? ' (' + c.handle + ')' : ''}${c.disabled ? '  disconnected' : ''}${c.paused ? '  queue paused' : ''}`).join('\n') || 'No channels.') + x.problems.map((m) => '\n! ' + m).join(''), x);
      return x.problems.length && !x.channels.length ? 4 : 0;
    }
    case 'check': {
      if (!p[0]) { fail(HELP); return 2; }
      const x = await run(() => check(p[0], { tools: !has('no-tools'), out: opt('out', 'palm-social/check') })); if (!x) return code;
      say(checkText(x), x); return x.ok ? 0 : 1;
    }
    case 'queue': {
      if (!p[0]) { fail(HELP); return 2; }
      if (!(await needPro('Queueing posts'))) return 3;
      if (has('now') && has('schedule')) { fail('Choose --schedule or --now, not both.', 2); return 2; }
      const x = await run(() => queue(p[0], { schedule: has('schedule'), now: has('now'), confirm: has('confirm'), again: has('again'), ledger: opt('ledger'), fetch })); if (!x) return code;
      say(queueText(x), x); return x.ok ? 0 : 1;
    }
    case 'list': {
      if (!(await needPro('The list of queued posts'))) return 3;
      const x = await run(() => list({ ledger: opt('ledger'), local: has('local'), fetch })); if (!x) return code;
      say(listText(x), x); return 0;
    }
    default: fail(HELP); return 2;
  }
}
