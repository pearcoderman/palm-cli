// Palm's pages desk: a live page with no hosting, seen on a phone, and a QR code that is checked to scan.
// Yuzool's Link in Bio, Website Maker, Business Card and Menu Maker pages travel inside their own link (after the #, so
// the page is never sent to a server): the page is live the moment the link exists. This desk uses each app's OWN model
// (its js/model.js: clean, the safe-link rules, escaping, pack/unpack), fetched from yuzool.com (or a local src folder),
// so the link format and the safety rules are never written again here. It refuses what the app would silently drop
// (a javascript: link, a booking link that isn't https …), applies the app's free rules (Pro looks are the app's Pro),
// opens the real viewer in the user's Chrome at phone and desktop widths, and checks every link on the page.
//
//   make     free: validate, link, phone + desktop screenshots, console errors, every link checked, manifest.json
//   qr       free: a QR (qrcode-generator 1.4.4, the QR Codes app's engine) at a print size, decoded with jsQR at that
//            size (and as a phone sees it at 20 cm, and the smallest size that still scans); a business card's QR
//            follows the app: its card link, or the vCard (vcardQR) when that link is too long to scan well
//   batch    Pro: a business card per CSV row; many QR codes from a CSV
//
// The viewer counts a view on the app's misuse counter: the desk's own preview blocks /api/ and tinylytics, so a
// preview is never a visit. Short links (yuzool.com/bio/<name> …) are each app's Pro on Yuzool's server: never made here.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join, resolve, dirname, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { configDir } from './client.mjs';
import { findChrome } from './doctor.mjs';

export const SITE = () => (process.env.PALM_PAGES_BASE || 'https://www.yuzool.com').replace(/\/$/, '');
const err = (msg, code = 2) => Object.assign(new Error(msg), { code });

// What each app is. free: the app's own free rules (its main.js `allowed()`), so a page made here never carries a Pro look.
export const KINDS = {
  'link-in-bio': {
    app: 'Link in Bio', model: 'link-in-bio/js/model.js', viewer: '/link-in-bio/p/', short: 'yuzool.com/bio/<name>', editor: '/link-in-bio/',
    name: (p) => p.name,
    free: (M, p) => ({ ...p, theme: M.theme(p.theme).pro ? 'paper' : p.theme, font: (M.FONTS.find((f) => f.id === p.font) || {}).pro ? 'system' : p.font, badge: true }),
  },
  website: {
    app: 'Website Maker', model: 'website-maker/js/model.js', viewer: '/website-maker/s/', short: 'yuzool.com/site/<name>', editor: '/website-maker/', qrMax: () => 1500,
    name: (s) => s.name,
    free: (M, s) => ({ ...s, theme: M.theme(s.theme).pro ? 'paper' : s.theme, font: (M.FONTS.find((f) => f.id === s.font) || {}).pro ? 'system' : s.font, badge: true, pages: (s.pages || []).slice(0, M.LIMITS.freePages) }),
  },
  card: {
    app: 'Business Card', model: 'business-card/js/model.js', viewer: '/business-card/c/', short: 'yuzool.com/card/<name>', editor: '/business-card/', qrMax: (M) => M.QR_MAX, ecl: 'L',
    name: (c) => c.name,
    free: (M, c) => ({ ...c, design: M.design(c.design).pro ? 'classic' : c.design, cover: '', logo: '', badge: true }),
  },
  menu: {
    app: 'Menu Maker', model: 'menu-maker/js/model.js', viewer: '/menu-maker/m/', short: 'yuzool.com/menu/<name>', editor: '/menu-maker/',
    name: (p) => p.name,
    free: (M, p) => {
      let left = M.LIMITS.freeItems;
      const menus = p.menus.slice(0, M.LIMITS.freeMenus).map((m) => ({ ...m, hh: null, sections: m.sections.map((s) => { const items = s.items.slice(0, Math.max(0, left)).map((it) => ({ ...it, img: '', sp: '', opts: (it.opts || []).map((o) => ({ ...o, s: '' })) })); left -= items.length; return { ...s, days: [], hh: null, items }; }) }));
      return { ...p, menus, langs: [], theme: M.theme(p.theme).pro ? 'paper' : p.theme, font: (M.FONTS.find((f) => f.id === p.font) || {}).pro ? 'system' : p.font, badge: true };
    },
  },
};
const ALIAS = { bio: 'link-in-bio', linkinbio: 'link-in-bio', 'link-bio': 'link-in-bio', site: 'website', 'website-maker': 'website', 'business-card': 'card', businesscard: 'card', 'menu-maker': 'menu' };
export function kindOf(k) {
  const id = ALIAS[String(k || '').toLowerCase()] || String(k || '').toLowerCase();
  if (!KINDS[id]) throw err(`Unknown kind "${k}". Kinds: ${Object.keys(KINDS).join(', ')}.`);
  return id;
}
export const BIO_LONG = 1000;   // Palm's guidance: longer than this is awkward to paste into a profile's website field
export const pagesDir = () => join(configDir(), 'pages');

// ---- the apps' models: fetched from the site (only Yuzool's own site or this machine), cached by content ----
function trusted(base) {
  let u; try { u = new URL(base); } catch { throw err('PALM_PAGES_BASE is not a web address: ' + base); }
  if (u.protocol === 'https:' && /^(www\.)?yuzool\.com$/.test(u.hostname)) return;
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return;
  throw err('The pages desk runs the apps\' own code on this machine, so it loads it only from https://www.yuzool.com or this machine (localhost). Or set PALM_PAGES_SRC to a folder holding the site\'s files.');
}
async function fetchText(base, p, f = globalThis.fetch) {
  const r = await f(base + '/' + p).catch((e) => { throw err(`Couldn't reach ${base}/${p}: ${e.message}`, 4); });
  if (!r.ok) throw err(`${base}/${p}: ${r.status}`, 4);
  return r.text();
}
const IMPORT_RE = /^\s*(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/gm;
const modelCache = new Map();
export async function loadModel(kind, { base = SITE() } = {}) {
  const k = KINDS[kindOf(kind)];
  const src = process.env.PALM_PAGES_SRC;
  const key = (src || base) + '|' + k.model;
  if (modelCache.has(key)) return modelCache.get(key);
  let mod;
  if (src) mod = await import(pathToFileURL(join(resolve(src), k.model)).href);
  else {
    trusted(base);
    const files = new Map();
    const get = async (p) => {
      if (files.has(p)) return; files.set(p, null);
      let t = await fetchText(base, p);
      // a site-absolute import (/x/y.js) becomes relative, so it resolves inside the cache folder
      t = t.replace(IMPORT_RE, (m, spec) => spec.startsWith('/') ? m.replace(spec, posix.relative(posix.dirname('/' + p), spec).replace(/^(?!\.)/, './')) : m);
      files.set(p, t);
      for (const m of t.matchAll(IMPORT_RE)) if (/^\.\.?\//.test(m[1])) await get(posix.normalize(posix.join(posix.dirname(p), m[1])));
    };
    await get(k.model);
    const h = createHash('sha256'); for (const p of [...files.keys()].sort()) h.update(p + '\0' + files.get(p) + '\0');
    const host = new URL(base).host.replace(/[^a-z0-9.-]/gi, '_'), dir = join(pagesDir(), 'models', host), root = join(dir, h.digest('hex').slice(0, 16));
    if (!existsSync(join(root, '.done'))) {
      for (const [p, t] of files) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); }
      writeFileSync(join(root, 'package.json'), '{"type":"module"}\n'); writeFileSync(join(root, '.done'), new Date().toISOString());
    }
    mod = await import(pathToFileURL(join(root, k.model)).href);
  }
  modelCache.set(key, mod);
  return mod;
}
// a vendored script from the site (the QR Codes app's generator, the Authenticator's jsQR), as CommonJS
const libCache = new Map();
async function siteLib(path, npm) {
  if (libCache.has(path)) return libCache.get(path);
  if (npm) for (const b of [process.env.PALM_NODE_MODULES, process.cwd(), join(process.cwd(), 'palm')].filter(Boolean)) {
    try { const x = createRequire(join(b, 'x.js'))(npm); libCache.set(path, x); return x; } catch { /* next */ }
  }
  let text;
  if (process.env.PALM_PAGES_SRC) text = readFileSync(join(resolve(process.env.PALM_PAGES_SRC), path), 'utf8');
  else { trusted(SITE()); text = await fetchText(SITE(), path); }
  const m = { exports: {} };
  new Function('module', 'exports', 'define', 'self', text)(m, m.exports, undefined, globalThis);
  const x = m.exports.default || m.exports;
  libCache.set(path, x);
  return x;
}
export const qrGenerator = () => siteLib('authenticator/vendor/qrcode-generator-1.4.4.js', 'qrcode-generator');
export const jsQR = () => siteLib('authenticator/vendor/jsQR-1.4.0.js', 'jsqr');

// ---- reading a page: a .json file, '-', JSON text, an object, {kind, page}, or a viewer link ----
export function viewerKind(link) {
  let u; try { u = new URL(String(link)); } catch { return null; }
  return Object.keys(KINDS).find((k) => u.pathname.replace(/\/?$/, '/') === KINDS[k].viewer && u.hash.length > 1) || null;
}
export async function readPage(src, kind) {
  if (typeof src === 'string') {
    let s = src;
    if (s === '-') s = readFileSync(0, 'utf8');
    else if (!/^\s*[{[]/.test(s) && !/^https?:\/\//.test(s) && existsSync(s)) s = readFileSync(s, 'utf8');
    s = s.trim();
    if (/^https?:\/\//.test(s)) {
      const k = viewerKind(s);
      if (!k) throw err('That link is not a Link in Bio, Website Maker, Business Card or Menu Maker page link (…/link-in-bio/p/#…, /website-maker/s/#…, /business-card/c/#…, /menu-maker/m/#…).');
      if (kind && kindOf(kind) !== k) throw err(`That link is a ${KINDS[k].app} page, not --kind ${kind}.`);
      const M = await loadModel(k), hash = decodeURIComponent(new URL(s).hash.slice(1)).split('!')[0];
      let page; try { page = await M.unpack(hash); } catch (e) { throw err(`${KINDS[k].app} couldn't open that link (${e.message}).`, 1); }
      return { kind: k, page, from: 'link' };
    }
    try { src = JSON.parse(s); } catch (e) { throw err('Not JSON: ' + e.message); }
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) throw err('A page is a JSON object (see: palm pages example --kind link-in-bio).');
  const k = src.kind && src.page ? src.kind : kind;
  if (!k) throw err('Say which app: --kind link-in-bio|website|card|menu (or {"kind": …, "page": {…}}).');
  return { kind: kindOf(k), page: src.kind && src.page ? src.page : src, from: 'json' };
}

// ---- validation through the app's own model ----
const SCHEMEISH = /^\s*[a-z][a-z0-9+.-]*:\S/i, DANGER = /^\s*(javascript|vbscript|file|blob|data)\s*:/i, URLKEY = /(url|href|link)$/i;
// strings the app's safeURL would turn into '' (the app drops them without a word; the desk refuses instead)
export function refusals(kind, M, input) {
  const out = [];
  const walk = (v, path) => {
    if (typeof v === 'string') {
      const s = v.trim(); if (!s) return;
      if (/^data:image\/(png|jpe?g|webp);base64,/i.test(s)) return;   // pictures: the model's safeImg/safePhoto keeps or drops them
      const keyed = URLKEY.test(path.split('.').pop());
      if ((DANGER.test(s) || SCHEMEISH.test(s) && !/\s/.test(s) || keyed && /^[a-z][a-z0-9+.-]*:/i.test(s)) && !M.safeURL(s)) out.push({ path, value: s.slice(0, 80), msg: `${path}: "${s.slice(0, 60)}" is not a link ${KINDS[kind].app} allows (only http(s), mailto, tel and sms links; a page link like /about on a website).` });
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(input, '');
  // links the app keeps only when they're https (it drops the rest when it draws the page)
  if (kind === 'card' && input.book && !M.bookURL(input.book)) out.push({ path: 'book', value: String(input.book).slice(0, 80), msg: 'book: Business Card\'s booking link must be an https address.' });
  if (kind === 'menu') {
    if (input.orderUrl && !/^https:/.test(M.safeURL(input.orderUrl))) out.push({ path: 'orderUrl', value: String(input.orderUrl).slice(0, 80), msg: 'orderUrl: Menu Maker\'s order link must be an https address.' });
    if (input.book && !M.bookHref({ book: input.book })) out.push({ path: 'book', value: String(input.book).slice(0, 80), msg: 'book: Menu Maker\'s booking link must be https, tel: or mailto:.' });
  }
  return out.filter((x, i, a) => a.findIndex((y) => y.path === x.path) === i);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// what the app keeps: refused links stop here; Pro looks fall back to the app's free ones (with a warning)
export async function validate(kind0, input) {
  const kind = kindOf(kind0), K = KINDS[kind], M = await loadModel(kind), issues = [];
  const ref = refusals(kind, M, input);
  if (ref.length) { const e = err(`${K.app} refuses this page:\n  ${ref.map((r) => r.msg).join('\n  ')}`, 1); e.refused = ref; throw e; }
  const known = new Set(Object.keys(M.blank()).concat(kind === 'website' ? ['corners'] : []));
  const unknown = Object.keys(input).filter((k) => !known.has(k) && k !== 'id' && k !== 'updated');
  if (unknown.length) issues.push({ level: 'warn', rule: 'unknown-field', msg: `${K.app} ignores ${unknown.map((x) => '"' + x + '"').join(', ')} (see: palm pages example --kind ${kind}).` });
  const cleaned = M.clean(input), page = M.clean(K.free(M, cleaned));
  const changed = ['theme', 'font', 'design', 'cover', 'logo', 'badge'].filter((f) => f in cleaned && !same(cleaned[f], page[f]));
  if (changed.length) issues.push({ level: 'warn', rule: 'pro-look', msg: `${changed.join(', ')}: ${changed.map((f) => JSON.stringify(cleaned[f]).slice(0, 30)).join(', ')} is ${K.app} Pro; the page uses the free ${changed.map((f) => JSON.stringify(page[f]).slice(0, 30)).join(', ')}. Pro looks are made in the app itself (${SITE()}${K.editor}).` });
  if (kind === 'website' && cleaned.pages.length > page.pages.length) issues.push({ level: 'warn', rule: 'pro-pages', msg: `Website Maker's free sites have ${M.LIMITS.freePages} pages; pages ${page.pages.length + 1}–${cleaned.pages.length} were left out (Website Maker Pro).` });
  if (kind === 'menu' && (!same(cleaned.menus, page.menus) || cleaned.langs.length)) issues.push({ level: 'warn', rule: 'pro-menu', msg: `Menu Maker's free menu is one menu of up to ${M.LIMITS.freeItems} dishes, without photos, specials by day, happy hours or extra languages; what's beyond that was left out (Menu Maker Pro).` });
  // what the app dropped without refusing (an empty link row, a social it doesn't know, a picture that's too big)
  for (const f of ['links', 'socials', 'phones', 'emails']) if (Array.isArray(input[f]) && Array.isArray(cleaned[f]) && cleaned[f].length < input[f].length) issues.push({ level: 'warn', rule: 'dropped', msg: `${f}: ${input[f].length - cleaned[f].length} of ${input[f].length} were left out by ${K.app} (empty, unknown platform, not a valid ${f === 'emails' ? 'email' : f === 'phones' ? 'phone number' : 'link'}, or over its limit).` });
  for (const f of ['photo', 'logo', 'cover']) if (input[f] && !cleaned[f]) issues.push({ level: 'warn', rule: 'picture', msg: `${f}: ${K.app} keeps only a small data:image (png, jpeg or webp) ${kind === 'website' || kind === 'menu' ? 'or an https address' : ''}; this one was left out.` });
  if (!String(K.name(page) || '').trim()) issues.push({ level: 'warn', rule: 'no-name', msg: 'The page has no name.' });
  return { kind, page, issues, M };
}
export async function link(kind0, page, M0) {
  const kind = kindOf(kind0), M = M0 || await loadModel(kind);
  return SITE() + KINDS[kind].viewer + '#' + await M.pack(page);
}

// ---- QR codes ----
export const defaultEcl = (text, kind) => (kind && KINDS[kind]?.ecl) || (String(text).length > 200 ? 'L' : 'M');   // Menu Maker's qrMatrix rule
export async function qrMatrix(text, ecl = defaultEcl(text)) {
  const qrcode = await qrGenerator();
  let q; try { q = qrcode(0, ecl); q.addData(String(text), 'Byte'); q.make(); } catch { throw err(`Too long for a QR code at error correction ${ecl} (${Buffer.byteLength(String(text))} bytes).`, 1); }
  const n = q.getModuleCount(), m = [];
  for (let r = 0; r < n; r++) { const row = []; for (let c = 0; c < n; c++) row.push(q.isDark(r, c)); m.push(row); }
  return { m, version: (n - 17) / 4, modules: n, ecl };
}
// Grey pixels (0 dark … 255 light) of the code with a 4-module quiet zone, `px` across. Whole-pixel modules when they
// fit (like the QR Codes app); below one pixel a module, each pixel is the share of light it covers (what a printer or
// camera gets). phase shifts the grid (a camera is never aligned with the modules).
export function raster(m, px, { margin = 4, phase = 0 } = {}) {
  const n = m.length, total = n + 2 * margin, g = new Uint8Array(px * px).fill(255), cell = px / total;
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && m[r][c];
  if (cell >= 1 && !phase) {
    const c0 = Math.floor(cell), off = Math.floor((px - c0 * n) / 2);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) for (let y = 0; y < c0; y++) g.fill(0, (off + r * c0 + y) * px + off + c * c0, (off + r * c0 + y) * px + off + c * c0 + c0);
    return g;
  }
  const S = 4;
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    let d = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) d += dark(Math.floor((y + (sy + 0.5) / S + phase) / cell) - margin, Math.floor((x + (sx + 0.5) / S + phase) / cell) - margin);
    g[y * px + x] = Math.round(255 * (1 - d / (S * S)));
  }
  return g;
}
const rgba = (g) => { const o = new Uint8ClampedArray(g.length * 4); for (let i = 0; i < g.length; i++) { o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = g[i]; o[i * 4 + 3] = 255; } return o; };
async function decode(g, px) { const f = await jsQR(); const r = f(rgba(g), px, px, { inversionAttempts: 'dontInvert' }); return r ? r.data : null; }
// a phone camera (about 3000 px across a 65° view; Palm's model, as in menu-check) at `cm`, ordinary light: soft focus, less contrast
export const camPxPerMm = (cm) => 3000 / (2 * cm * 10 * Math.tan(32.5 * Math.PI / 180));
async function phoneSees(m, mm, cm = 20) {
  const px = Math.max(21, Math.round(mm * camPxPerMm(cm)));
  const g = raster(m, px, { phase: 0.37 }), b = new Uint8Array(g.length);
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    let s = 0, w = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = Math.min(px - 1, Math.max(0, y + dy)), xx = Math.min(px - 1, Math.max(0, x + dx)), k = (2 - Math.abs(dx)) * (2 - Math.abs(dy)); s += g[yy * px + xx] * k; w += k; }
    b[y * px + x] = Math.round(30 + (s / w) * 0.75);   // ink isn't black, paper isn't white
  }
  return { px, data: await decode(b, px) };
}
// PNG (8-bit grey), with the print resolution when there is one
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
export function png(g, px, dpi = 0) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(px, 0); ihdr.writeUInt32BE(px, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((px + 1) * px); for (let y = 0; y < px; y++) Buffer.from(g.buffer, g.byteOffset + y * px, px).copy(raw, y * (px + 1) + 1);
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (dpi) { const p = Buffer.alloc(9); const ppm = Math.round(dpi / 0.0254); p.writeUInt32BE(ppm, 0); p.writeUInt32BE(ppm, 4); p[8] = 1; parts.push(chunk('pHYs', p)); }
  parts.push(chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
// our own PNGs back (8-bit grey, filter 0, as png() writes them)
export function readPng(b) {
  let i = 8, px = 0; const idat = [];
  while (i < b.length) { const n = b.readUInt32BE(i), t = b.toString('latin1', i + 4, i + 8); if (t === 'IHDR') px = b.readUInt32BE(i + 8); if (t === 'IDAT') idat.push(b.subarray(i + 8, i + 8 + n)); i += 12 + n; }
  const raw = inflateSync(Buffer.concat(idat)), g = new Uint8Array(px * px);
  for (let y = 0; y < px; y++) g.set(raw.subarray(y * (px + 1) + 1, (y + 1) * (px + 1)), y * px);
  return { px, g };
}
export function svg(m, mm) {
  const n = m.length, q = 4; let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
  const side = mm ? `${mm}mm` : `${(n + 2 * q) * 10}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>\n`;
}
export function parseSize(s) {
  const t = String(s || '').trim().toLowerCase(), v = parseFloat(t);
  if (!isFinite(v) || v <= 0) throw err(`Size "${s}": use mm (30mm), cm (3cm), in (1.2in) or px (600px).`);
  if (/px$/.test(t)) return { px: Math.round(v) };
  return { mm: Math.round((/cm$/.test(t) ? v * 10 : /in$/.test(t) ? v * 25.4 : v) * 10) / 10 };
}
export const DPI = 300;
// make the code, write it, and decode it: success only when jsQR reads back exactly the same text
export async function qr(text, { size = '30mm', ecl, out = 'qr.png', kind = null, why = '' } = {}) {
  text = String(text || ''); if (!text) throw err('Nothing to put in the QR code.');
  const sz = typeof size === 'object' ? size : parseSize(size);
  const code = await qrMatrix(text, ecl || defaultEcl(text, kind)), issues = [];
  const px = sz.px || Math.round(sz.mm / 25.4 * DPI);
  const g = raster(code.m, px), got = await decode(g, px);
  const decodes = got === text;
  if (!decodes) issues.push({ level: 'error', rule: 'qr-no-scan', msg: got == null ? `At ${sz.mm ? sz.mm + ' mm (' + DPI + ' dpi)' : px + ' px'} the code doesn't scan: ${code.modules}×${code.modules} modules is ${(px / (code.modules + 8)).toFixed(2)} px a module. Make it bigger or the text shorter${kind ? ' (the app\'s Pro short link, ' + KINDS[kind].short + ', is much shorter)' : ''}.` : 'The code decodes to different text.' });
  const res = { ok: decodes, text, textLength: text.length, why, ecl: code.ecl, version: code.version, modules: code.modules, quietZone: 4, mm: sz.mm || null, px, dpi: sz.mm ? DPI : null, decodes, decoded: got, issues };
  if (sz.mm) {
    const ph = await phoneSees(code.m, sz.mm, 20); res.phone20cm = ph.data === text;
    let lo = 4, hi = 150;   // the smallest printed size a phone at 20 cm still reads (Palm's simulation)
    if (!(await phoneSees(code.m, hi, 20)).data) lo = hi = null;
    else { while (hi - lo > 0.5) { const mid = (lo + hi) / 2; if ((await phoneSees(code.m, mid, 20)).data === text) hi = mid; else lo = mid; } }
    res.minMm = hi == null ? null : Math.ceil(hi);
    res.margin = res.minMm ? Math.round(sz.mm / res.minMm * 10) / 10 : null;
    const smaller = Math.round(sz.mm * 0.7 * 10) / 10, sp = Math.round(smaller / 25.4 * DPI);
    res.at70 = { mm: smaller, decodes: (await decode(raster(code.m, sp), sp)) === text };
    if (decodes && !res.phone20cm) issues.push({ level: 'warn', rule: 'qr-phone', msg: `It prints sharp, but in Palm's phone test (a camera at 20 cm) a ${sz.mm} mm code didn't read${res.minMm ? `; it reads from about ${res.minMm} mm` : ''}.` });
    if (sz.mm < 20) issues.push({ level: 'warn', rule: 'qr-small', msg: `${sz.mm} mm is small; a widely used rule of thumb is code width ≥ scanning distance ÷ 10 (20 mm for 20 cm).` });
  } else {
    const half = Math.max(21, Math.round(px / 2)); res.atHalf = { px: half, decodes: (await decode(raster(code.m, half), half)) === text };
  }
  if (code.version >= 15) issues.push({ level: 'warn', rule: 'qr-dense', msg: `A dense code (version ${code.version}, ${code.modules}×${code.modules}): older phones and dim light struggle. Shorter text makes a sparser code.` });
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, png(g, px, sz.mm ? DPI : 0)); res.file = resolve(out);
    const sv = out.replace(/\.png$/i, '') + '.svg'; writeFileSync(sv, svg(code.m, sz.mm)); res.svg = resolve(sv);
    // the file itself, read back from disk: what gets printed is what was checked
    const back = readPng(readFileSync(out));
    res.fileDecodes = back.px === px && (await decode(back.g, px)) === text;
    if (decodes && !res.fileDecodes) { res.ok = false; issues.push({ level: 'error', rule: 'qr-file', msg: 'The saved PNG does not decode to the same text.' }); }
  }
  return res;
}

// a made page's QR, the way its app makes it
export async function pageQR(dir, { size = '30mm', contact = false, out } = {}) {
  const mf = /manifest\.json$/.test(dir) ? dir : join(dir, 'manifest.json');
  if (!existsSync(mf)) throw err(`No manifest.json in ${dir}: make the page first (palm pages make).`);
  const man = JSON.parse(readFileSync(mf, 'utf8')), kind = kindOf(man.kind), M = await loadModel(kind), K = KINDS[kind];
  const page = M.clean(JSON.parse(readFileSync(join(dirname(mf), 'page.json'), 'utf8')));
  let text = man.link, why = 'the page link';
  const notes = [];
  if (kind === 'card') {
    const cardLink = SITE() + K.viewer + '#' + await M.pack(M.forQR(page));   // the app's QR card: no pictures, so the code stays sparse
    const auto = cardLink.length > M.QR_MAX ? 'contact' : 'link';
    if (contact || auto === 'contact') { text = M.vcardQR(page); why = 'the contact (vCard), so a phone saves it straight away' + (auto === 'contact' && !contact ? ` (Business Card does this when the card link is over ${M.QR_MAX} characters; the Pro short link ${K.short} would fit instead)` : ''); }
    else { text = cardLink; why = 'the card link without its pictures (as Business Card makes it)'; }
  } else if (K.qrMax && text.length > K.qrMax(M)) notes.push({ level: 'warn', rule: 'app-qr-limit', msg: `${K.app} offers no QR for a link over ${K.qrMax(M)} characters (this one is ${text.length}); its Pro short link (${K.short}) is the short version.` });
  const r = await qr(text, { size, out: out || join(dirname(mf), 'qr.png'), kind, why });
  r.issues.unshift(...notes);
  r.kind = kind;
  return r;
}

// ---- the browser: the real viewer, as a visitor sees it (but never counted as one) ----
function loadPuppeteer() {
  for (const b of [process.env.PALM_NODE_MODULES, process.cwd(), join(process.cwd(), 'palm')].filter(Boolean)) {
    try { return createRequire(join(b, 'x.js'))('puppeteer-core'); } catch { /* next */ }
  }
  throw err('The pages desk needs puppeteer-core in this folder to look at the page: npm i puppeteer-core (or palm setup). Check with: palm doctor', 4);
}
export const BLOCK = /\/api\/|tinylytics|googletagmanager|google-analytics/;
export async function openBrowser() {
  const puppeteer = loadPuppeteer(), chrome = findChrome();
  if (!chrome) throw err('No Chrome, Edge or Chromium found. Install one or set PALM_CHROME (palm doctor).', 4);
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', timeout: 90000, args: ['--no-first-run', '--no-default-browser-check', '--hide-scrollbars'] });
  return { browser, close: () => browser.close() };
}
export const WIDTHS = { phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, desktop: { width: 1280, height: 800, deviceScaleFactor: 1 } };
async function look(s, url, file, vp) {
  const page = await s.browser.newPage(), errors = [], blocked = [];
  try {
    await page.setRequestInterception(true);
    page.on('request', (r) => { if (BLOCK.test(r.url())) { blocked.push(r.url().slice(0, 120)); r.abort(); } else r.continue(); });
    page.on('console', (m) => { if (m.type() === 'error' && !/net::ERR_FAILED|ERR_BLOCKED_BY_CLIENT/.test(m.text())) errors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => errors.push('page error: ' + String(e.message || e).slice(0, 300)));
    await page.setViewport(vp);
    if (vp.isMobile) await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => document.body && document.body.textContent.trim().length > 20, { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await new Promise((r) => setTimeout(r, 250));
    const info = await page.evaluate(() => ({
      text: document.body.textContent.replace(/\s+/g, ' ').trim(),
      title: document.title,
      hrefs: [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) })),
      frames: [...document.querySelectorAll('iframe[src]')].map((f) => f.getAttribute('src')),
      sideways: document.documentElement.scrollWidth > innerWidth + 1,
      height: document.documentElement.scrollHeight,
    }));
    await page.screenshot({ path: file, fullPage: true, captureBeyondViewport: true });
    return { ...info, errors, blocked, file: resolve(file) };
  } finally { await page.close(); }
}
// is this href one the app's model allows? (the page's own links, the app's own pages, the contact file it makes)
export function linkOk(href, M, viewerURL) {
  if (!href || href.startsWith('#')) return true;
  let u; try { u = new URL(href, viewerURL); } catch { return false; }
  if (u.origin === new URL(viewerURL).origin && /^https?:$/.test(u.protocol)) return true;
  if (u.protocol === 'data:') return /^data:text\/(vcard|calendar)[;,]/i.test(href);
  return /^(https?|mailto|tel|sms):$/.test(u.protocol) && !!M.safeURL(href);
}

// ---- make ----
export const slug = (s) => String(s || 'page').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'page';
export async function make(src, { kind, out = 'palm-page', session, browser = true } = {}) {
  const read = await readPage(src, kind);
  const v = await validate(read.kind, read.page), K = KINDS[v.kind], M = v.M, issues = [...v.issues];
  const url = await link(v.kind, v.page, M);
  // the link opens to the same page (pack → unpack through the app's own code)
  const back = await M.unpack(url.split('#')[1]);
  if (!same(back, v.page)) issues.push({ level: 'error', rule: 'round-trip', msg: 'The link doesn\'t open to the same page (pack → unpack differ).' });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'page.json'), JSON.stringify(v.page, null, 2) + '\n');
  writeFileSync(join(out, 'link.txt'), url + '\n');
  // how long, and what that means for a QR and a bio field
  const len = url.length, q = {};
  try {
    const c = await qrMatrix(url, defaultEcl(url, v.kind));
    Object.assign(q, { version: c.version, modules: c.modules, ecl: c.ecl });
    let lo = 4, hi = 150;
    if ((await phoneSees(c.m, hi)).data === url) { while (hi - lo > 1) { const mid = (lo + hi) / 2; if ((await phoneSees(c.m, mid)).data === url) hi = mid; else lo = mid; } q.minMm = Math.ceil(hi); }
  } catch { q.fits = false; }
  if (q.fits === false) issues.push({ level: 'warn', rule: 'qr-too-long', msg: `The link is ${len} characters: too long for any QR code. ${K.app}'s Pro short link (${K.short}) is the QR-sized version.` });
  else if (v.kind === 'card' && len > M.QR_MAX) issues.push({ level: 'info', rule: 'card-qr', msg: `The card link is ${len} characters; for its QR code Business Card uses the card without pictures, or the contact itself (vCard) when that's over ${M.QR_MAX}: palm pages qr --page ${out}.` });
  else if (K.qrMax && len > K.qrMax(M)) issues.push({ level: 'warn', rule: 'qr-long', msg: `The link is ${len} characters; ${K.app} offers no QR over ${K.qrMax(M)} (its Pro short link ${K.short} fits).` });
  else if (q.version >= 15) issues.push({ level: 'warn', rule: 'qr-dense', msg: `The link is ${len} characters: its QR is dense (version ${q.version}); print it at least ${Math.max(30, q.minMm || 0)} mm, or use ${K.app}'s Pro short link (${K.short}).` });
  if (len > BIO_LONG) issues.push({ level: 'warn', rule: 'bio-long', msg: `The link is ${len} characters: long to paste into a profile's website field or a message (Palm's guidance: over ${BIO_LONG}); some apps cut or refuse long links. ${K.app}'s Pro short link (${K.short}) is the short version.` });
  const res = { made: new Date().toISOString(), tool: 'palm pages', kind: v.kind, app: K.app, name: K.name(v.page) || '', link: url, linkLength: len, qr: q, public: 'Anyone with the link can open this page. Nothing was uploaded: the page is inside the link (after the #).', shortLink: `${K.app} Pro gives a short link (${K.short}) with visitor stats; make it in the app (${SITE()}${K.editor}). Palm never makes short links.`, out: resolve(out), page: resolve(join(out, 'page.json')), issues };
  if (browser) {
    const s = session || await openBrowser();
    try {
      res.shots = {}; res.links = []; res.consoleErrors = []; res.blocked = 0;
      for (const [name, vp] of Object.entries(WIDTHS)) {
        const r = await look(s, url, join(out, `${name}.png`), vp);
        res.shots[name] = { file: r.file, width: vp.width, height: r.height };
        res.consoleErrors.push(...r.errors.map((e) => `${name}: ${e}`)); res.blocked += r.blocked.length;
        if (name === 'phone') {
          const nm = String(res.name).replace(/\s+/g, ' ').trim();
          if (nm && !r.text.toLowerCase().includes(nm.toLowerCase())) issues.push({ level: 'error', rule: 'not-shown', msg: `The viewer doesn't show "${nm}": the page didn't open (see phone.png).` });
          if (!/report this/i.test(r.text)) issues.push({ level: 'error', rule: 'no-report', msg: 'The viewer\'s "Report this" link is missing.' });
          if (r.sideways) issues.push({ level: 'warn', rule: 'sideways', msg: 'On a 390 px phone the page scrolls sideways.' });
          const seen = new Set();
          for (const h of r.hrefs) { if (seen.has(h.href)) continue; seen.add(h.href); const ok = linkOk(h.href, M, url); res.links.push({ href: h.href.length > 140 ? h.href.slice(0, 140) + '…' : h.href, text: h.text, ok }); if (!ok) issues.push({ level: 'error', rule: 'bad-link', msg: `A link on the page isn't one ${K.app} allows: ${h.href.slice(0, 80)}` }); }
          for (const f of r.frames) res.links.push({ href: f, text: '(embedded player)', ok: true, embed: true });
          res.hosts = [...new Set(res.links.filter((l) => /^https?:/.test(l.href)).map((l) => M.hostOf(l.href)).filter(Boolean))];
        }
      }
      for (const e of res.consoleErrors) issues.push({ level: 'error', rule: 'console', msg: e });
    } finally { if (!session) await s.close(); }
  }
  const errors = issues.filter((i) => i.level === 'error').length;
  Object.assign(res, { ok: errors === 0, errors, warnings: issues.filter((i) => i.level === 'warn').length });
  res.manifest = resolve(join(out, 'manifest.json'));
  res.look = browser ? 'Open phone.png before you finish: the page as a visitor sees it on a 390 px phone. Fix every error and make it again.' : 'Not looked at (no browser).';
  writeFileSync(res.manifest, JSON.stringify(res, null, 2) + '\n');
  return res;
}

// ---- Pro: batches ----
// a business card per CSV row: name, title, org/company, phone/mobile, email, website/url, address (+ a base card's look)
const COLS = { name: ['name', 'full name'], title: ['title', 'job title', 'role'], org: ['org', 'company', 'organisation', 'organization'], phone: ['phone', 'mobile', 'cell', 'phone number'], email: ['email', 'e-mail', 'email address'], url: ['url', 'website', 'web', 'site'], address: ['address'], pronouns: ['pronouns'], about: ['about', 'bio'] };
export async function cardsFromCSV(csv, base = {}) {
  const C = await loadModel('card'), Mm = await loadModel('menu');
  const T = Mm.parseTable(csv, { header: true }), heads = T.columns.map((h) => String(h).trim().toLowerCase());
  const col = (k) => heads.findIndex((h) => COLS[k].includes(h));
  if (col('name') < 0) throw err(`The CSV needs a "name" column (found: ${T.columns.join(', ')}).`);
  return T.rows.map((r) => { const g = (k) => (col(k) >= 0 ? r[col(k)] : '') || ''; const c = C.contactIn({ name: g('name'), title: g('title'), org: g('org'), phone: g('phone'), email: g('email'), url: g('url'), address: g('address') }); return { ...base, ...c, pronouns: g('pronouns') || base.pronouns || '', about: g('about') || base.about || '', socials: base.socials || [], links: base.links || [] }; }).filter((c) => c.name);
}
export async function makeCards(csv, { base = {}, out = 'palm-cards', limit = 200, qrSize = '25mm', browser = true } = {}) {
  const cards = (await cardsFromCSV(csv, base)).slice(0, limit), items = [];
  const s = browser ? await openBrowser() : null;
  try {
    for (let i = 0; i < cards.length; i++) {
      const dir = join(out, String(i + 1).padStart(3, '0') + '-' + slug(cards[i].name));
      try {
        const r = await make({ kind: 'card', page: cards[i] }, { out: dir, session: s, browser });
        const q = await pageQR(dir, { size: qrSize });
        items.push({ row: i + 1, name: cards[i].name, ok: r.ok && q.ok, link: r.link, out: r.out, qr: q.file, errors: r.errors + (q.ok ? 0 : 1) });
      } catch (e) { items.push({ row: i + 1, name: cards[i].name, ok: false, error: e.message, errors: 1 }); }
    }
  } finally { if (s) await s.close(); }
  const errors = items.reduce((n, x) => n + x.errors, 0);
  const res = { made: new Date().toISOString(), tool: 'palm pages make --csv', kind: 'card', rows: items.length, ok: errors === 0, errors, items, out: resolve(out), manifest: resolve(join(out, 'manifest.json')) };
  mkdirSync(out, { recursive: true }); writeFileSync(res.manifest, JSON.stringify(res, null, 2) + '\n');
  return res;
}
// many QR codes: a column url/link/text (or the first), and name for the file names
export async function qrBatch(csv, { size = '30mm', out = 'palm-qr', limit = 500 } = {}) {
  const Mm = await loadModel('menu'), T = Mm.parseTable(csv, { header: true }), heads = T.columns.map((h) => String(h).trim().toLowerCase());
  let ti = heads.findIndex((h) => ['url', 'link', 'text', 'qr', 'address'].includes(h)); if (ti < 0) ti = 0;
  const ni = heads.findIndex((h) => ['name', 'label', 'title', 'file'].includes(h));
  mkdirSync(out, { recursive: true });
  const items = [];
  for (const [i, r] of T.rows.slice(0, limit).entries()) {
    const text = r[ti] || '', name = (ni >= 0 && r[ni]) || text;
    const file = join(out, String(i + 1).padStart(3, '0') + '-' + slug(name) + '.png');
    try { const q = await qr(text, { size, out: file }); items.push({ row: i + 1, name, text, ok: q.ok, file: q.file, version: q.version, minMm: q.minMm, issues: q.issues }); }
    catch (e) { items.push({ row: i + 1, name, text, ok: false, error: e.message }); }
  }
  const bad = items.filter((x) => !x.ok).length;
  const res = { made: new Date().toISOString(), tool: 'palm pages qr --csv', column: T.columns[ti], rows: items.length, ok: bad === 0, errors: bad, items, out: resolve(out), manifest: resolve(join(out, 'manifest.json')) };
  writeFileSync(res.manifest, JSON.stringify(res, null, 2) + '\n');
  return res;
}

// a starting page in the app's own format (its SAMPLE, or one of its templates)
export async function example(kind0, template) {
  const kind = kindOf(kind0), M = await loadModel(kind);
  if (template) {
    const t = (M.TEMPLATES || []).find((x) => x.id === template || x.name.toLowerCase() === String(template).toLowerCase());
    if (!t) throw err(`${KINDS[kind].app} has no template "${template}"${M.TEMPLATES ? '. Templates: ' + M.TEMPLATES.map((x) => x.id).join(', ') : ''}.`);
    return { kind, page: M.clean(t.site || t.place || t.page || t), templates: M.TEMPLATES.map((x) => x.id) };
  }
  return { kind, page: M.clean(M.SAMPLE), templates: (M.TEMPLATES || []).map((x) => x.id) };
}

// ---- Pro: checked against Palm once a day, cached. Only the Palm key goes to Palm, never the page. ----
export async function proOk({ check, now = Date.now() } = {}) {
  const f = join(pagesDir(), 'pro.json');
  try { const c = JSON.parse(readFileSync(f, 'utf8')); if (c.ok && now - c.at < 86400e3) return true; } catch {}
  const ok = !!(await check());
  mkdirSync(pagesDir(), { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify({ ok, at: now }), { mode: 0o600 });
  return ok;
}

// Text for people (the CLI and the MCP share it).
const lvl = (i) => `    ${i.level}: ${i.msg}`;
export function summary(r) {
  if (r.tool === 'palm pages make --csv') return `${r.rows} business cards → ${r.out}\n${r.items.map((x) => `  ${x.ok ? '✓' : '✗'} ${String(x.row).padStart(3)} ${x.name}${x.error ? ': ' + x.error : ''}`).join('\n')}\n${r.ok ? 'No errors.' : r.errors + ' error(s): see each folder\'s manifest.json.'}\nPublic: anyone with a card's link can open it.\nManifest: ${r.manifest}`;
  if (r.tool === 'palm pages qr --csv') return `${r.rows} QR codes from the "${r.column}" column → ${r.out}\n${r.items.map((x) => `  ${x.ok ? '✓' : '✗'} ${String(x.row).padStart(3)} ${x.name.slice(0, 60)}${x.error ? ': ' + x.error : x.minMm ? `  (reads from ~${x.minMm} mm)` : ''}`).join('\n')}\n${r.ok ? 'Every code decodes to its text.' : r.errors + ' code(s) did not scan: see manifest.json.'}\nManifest: ${r.manifest}`;
  if (r.tool === 'palm pages') {
    const L = [`${r.ok ? '✓' : '✗'} ${r.app}: "${r.name}"`, `Link (${r.linkLength} characters; live now, public to anyone who has it):`, r.link.length > 300 ? r.link.slice(0, 260) + '… (full link in link.txt)' : r.link];
    if (r.shots) L.push(`Phone (390 px): ${r.shots.phone.file}`, `Desktop (1280 px): ${r.shots.desktop.file}`, `Links on the page: ${r.links.length} (${r.links.filter((l) => !l.ok).length} not allowed)${r.hosts?.length ? '; they go to ' + r.hosts.join(', ') : ''}`, `Preview not counted as a visit (${r.blocked} counter/analytics request${r.blocked === 1 ? '' : 's'} blocked).`);
    if (r.qr.version) L.push(`QR: version ${r.qr.version} (${r.qr.modules}×${r.qr.modules})${r.qr.minMm ? `, reads from about ${r.qr.minMm} mm in Palm's phone test` : ''}. Make it: palm pages qr --page ${r.out}`);
    for (const i of r.issues) L.push(lvl(i));
    L.push('', r.ok ? 'No errors.' : `${r.errors} error(s), ${r.warnings} warning(s).`, r.shortLink, `Manifest: ${r.manifest}`, r.look);
    return L.join('\n');
  }
  // a QR
  const L = [`${r.ok ? '✓ Scans' : '✗ Does not scan'}: ${r.mm ? r.mm + ' mm at ' + r.dpi + ' dpi (' + r.px + ' px)' : r.px + ' px'}, version ${r.version} (${r.modules}×${r.modules} modules, error correction ${r.ecl}, 4-module quiet zone)`,
    `Holds${r.why ? ' ' + r.why : ''} (${r.textLength} characters): ${r.text.length > 120 ? r.text.slice(0, 110) + '…' : r.text}`];
  if (r.ok) L.push(`Decoded with jsQR at that size: the same text.`);
  if (r.mm) L.push(`Phone at 20 cm (Palm's simulation): ${r.phone20cm ? 'reads' : 'does NOT read'}${r.minMm ? `; reads from about ${r.minMm} mm${r.phone20cm && r.margin ? ` (${r.margin}× room)` : ''}` : ''}. At 70% (${r.at70.mm} mm): ${r.at70.decodes ? 'still decodes' : 'does not decode'}.`);
  else if (r.atHalf) L.push(`At half size (${r.atHalf.px} px): ${r.atHalf.decodes ? 'still decodes' : 'does not decode'}.`);
  if (r.file) L.push(`PNG: ${r.file}`, `SVG (for print): ${r.svg}`);
  for (const i of r.issues) L.push(lvl(i));
  return L.join('\n');
}
export const _test = { decode, phoneSees };
