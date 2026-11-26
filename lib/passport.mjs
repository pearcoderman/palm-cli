// Palm's passport photo desk: a person's photo made into a passport, visa or ID photo with Yuzool's Passport Photo
// (yuzool.com/passport-photo/), on the user's machine. The rules are the app's own docs.js (each document from its
// official page, with the page and the date it was checked; never a number from memory), the fit, checks, print sheets
// and digital file are the app's own code, run in the user's own Chrome. The photo goes into the page from this machine
// and the files come back out; nothing is uploaded (the page only fetches its code and on-device models, and this desk
// blocks every request that isn't a GET). Palm sees only the Palm key, once a day, for the Pro parts.
//
//   docs [words]   the documents (free, no browser: docs.js is plain data, evaluated in an empty vm context)
//   make           the photo at the document's size (300 dpi JPEG), the app's checks as advice, a print sheet (4×6 or 5×7
//                  JPEG, A4 or Letter PDF with a 50 mm check line), the digital file where the document has one, and
//                  look-N.png (the photo with the app's guides) + page.png (the app as the person would see it)
//   Free: one photo, the document's own background colours. Pro (the app's own Pro): several people on one sheet, a
//   custom size, any background colour.
// The checks are advice against the published rules, never a promise: the office that takes the photo decides.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, basename, extname } from 'node:path';
import vm from 'node:vm';
import { configDir } from './client.mjs';
import { findChrome } from './doctor.mjs';

export const SITE = () => (process.env.PALM_PASSPORT_BASE || 'https://www.yuzool.com').replace(/\/$/, '');
export const APP = () => SITE() + '/passport-photo/';
export const PAPER_IDS = ['4x6', '5x7', 'a4', 'letter'];
const err = (msg, code = 2) => Object.assign(new Error(msg), { code });

// ---- the app's pure modules, in Node (no browser) ----
// docs.js, fit.js and sheet.js import nothing and touch no browser API. They're fetched from the site (the same files
// the page runs) and evaluated in an empty vm context: no require, process, fs or network inside it.
const mods = new Map();
export function evalModule(src, filename = 'module.js') {
  if (/^\s*import\s/m.test(src)) throw err(`${filename} imports other modules; the desk can't read it in Node.`, 4);
  const names = [...src.matchAll(/^export\s+(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const code = src.replace(/^export\s+(const|let|function)\s/gm, '$1 ') + `\n;({ ${names.join(', ')} })`;
  return vm.runInNewContext(code, Object.create(null), { filename, timeout: 2000 });
}
async function siteModule(name, { fetch: f = globalThis.fetch } = {}) {
  const key = SITE() + '|' + name;
  if (!mods.has(key)) mods.set(key, (async () => {
    let r;
    try { r = await f(APP() + 'js/' + name); } catch (e) { throw err(`Couldn't reach ${APP()} (${e.message}). Check the connection.`, 4); }
    if (!r.ok) throw err(`Passport Photo's ${name} unavailable (${r.status}) at ${APP()}`, 4);
    return evalModule(await r.text(), name);
  })().catch((e) => { mods.delete(key); throw e; }));
  return mods.get(key);
}
export async function rules(o = {}) {
  const [D, F, S] = await Promise.all(['docs.js', 'fit.js', 'sheet.js'].map((n) => siteModule(n, o)));
  // plain data in this realm (the vm's objects have its own prototypes)
  const plain = (x) => JSON.parse(JSON.stringify(x));
  return { CHECKED: D.CHECKED, DOCS: plain(D.DOCS), OFFICE: plain(D.OFFICE), fit: F, sheet: S };
}

// ---- words for people ----
const r1 = (v) => String(Math.round(v * 10) / 10);
const inch = (mm) => String(Math.round(mm / 25.4 * 1000) / 1000);
export const sizeText = (d) => (d.inches ? `${inch(d.size[0])} × ${inch(d.size[1])} in (${r1(d.size[0])} × ${r1(d.size[1])} mm)` : `${r1(d.size[0])} × ${r1(d.size[1])} mm`);
export function headText(d) {
  if (d.head) return `head ${r1(d.head[0])}–${r1(d.head[1])} mm chin to ${d.skull ? 'top of the skull (hair not counted)' : 'top of the head'}`;
  if (d.headPct) return `head ${d.headPct[0]}–${d.headPct[1]} % of the height`;
  return 'no head size given (the app uses the ICAO guide, 70–80 % of the height)';
}
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

/** One document as the desk shows it. R: rules(). */
export function describe(d, R) {
  if (!d.size) return { id: d.id, name: d.name, countryName: d.countryName, takenForYou: true, note: d.note, source: [d.source], aka: d.aka || [] };
  const dg = d.digital, px = { ...R.fit.printPx(d) };
  return {
    id: d.id, name: d.name, country: d.country, countryName: d.countryName, kind: d.kind,
    size: d.size, inches: !!d.inches, sizeText: sizeText(d), printPx: d.printable === false ? null : px, dpi: 300,
    head: d.head, headPct: d.headPct, skull: !!d.skull, headText: headText(d), headNote: d.headNote || null,
    eyes: d.eyes, top: d.top, bg: d.bg, bgName: d.bgName, glasses: d.glasses, glassesNote: d.glassesNote || null, smile: d.smile,
    baby: d.baby || null, printable: d.printable !== false, photos: d.photos,
    digital: dg ? { px: { ...R.fit.digitalPx(d) }, minPx: dg.minPx || null, maxPx: dg.maxPx || null, minKB: dg.minKB || null, maxKB: dg.maxKB || null, note: dg.note || null } : null,
    diy: d.diy, diyNote: d.diyNote || null, takenForYou: d.diy === false, edits: d.edits || null, more: d.more || null,
    source: d.source || [], checked: d.checked || R.CHECKED,
  };
}

/** The documents matching every word (id, name, country, kind, search words, size). */
export async function docs({ query = '', fetch } = {}) {
  const R = await rules({ fetch });
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (d) => [d.id, d.name, d.country, d.countryName, d.kind, ...(d.aka || []), d.size ? sizeText(d) + ' ' + d.size.map(Math.round).join('x') : 'photo taken for you'].join(' ').toLowerCase();
  const hit = (d) => words.every((w) => hay(d).includes(w));
  return { checked: R.CHECKED, docs: R.DOCS.filter(hit).map((d) => describe(d, R)), office: R.OFFICE.filter(hit).map((d) => describe(d, R)) };
}
export async function doc(id, o = {}) {
  const R = await rules(o), d = R.DOCS.find((x) => x.id === id) || R.OFFICE.find((x) => x.id === id);
  if (!d) throw err(await unknownDoc(id, R), 2);
  return describe(d, R);
}
async function unknownDoc(id, R) {
  const words = String(id).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const near = R.DOCS.filter((d) => words.some((w) => [d.id, d.name.toLowerCase(), (d.countryName || '').toLowerCase(), ...(d.aka || [])].join(' ').includes(w))).slice(0, 8).map((d) => d.id);
  return `No document "${id}".${near.length ? ' Did you mean: ' + near.join(', ') + '?' : ''} See: palm passport docs <country or document>`;
}
export function docsText(r) {
  const L = [];
  for (const d of r.docs) {
    L.push(`${d.id}  ${d.name} (${d.countryName}, ${d.kind}): ${d.sizeText}${d.printable ? '' : ' (upload only, no print)'} · ${d.headText} · ${d.bgName}${d.digital ? ` · digital ${d.digital.px.w}×${d.digital.px.h} px${d.digital.maxKB ? ', ≤' + d.digital.maxKB + ' KB' : ''}` : ''}`);
    if (d.takenForYou) L.push(`    TAKEN FOR YOU: ${d.diyNote}`);
    else if (d.diy === 'note' && d.diyNote) L.push(`    before you start: ${d.diyNote}`);
    L.push(d.source[0] ? `    rules: ${d.source[0]} (checked ${d.checked})` : '    a plain size for any form that asks for it: check the form\'s own rules');
  }
  for (const o of r.office) L.push(`${o.id}  ${o.name} (${o.countryName}): THE PHOTO IS TAKEN FOR YOU, nothing to make. ${o.note}\n    rules: ${o.source[0]}`);
  if (!L.length) L.push('No document matches. Try the country, the document, or the size (35x45, 2x2). For a form with its own size: --size WxH (Palm Pro).');
  L.push('', `${r.docs.length} document(s)${r.office.length ? `, ${r.office.length} where the office takes the photo` : ''}. Rules from each official page (checked ${r.checked} unless shown). Make one: palm passport make <photo> --doc <id>`);
  return L.join('\n');
}

// ---- what a run asks for, checked before any browser starts ----
const HEX = /^#[0-9a-f]{6}$/i;
/** opts: { people: [{ photo, doc }], doc, paper, bg, size: 'WxH' | [w,h], head: 'a-b' | [a,b] }. Returns the plan (docs
    resolved) and the Pro reasons. Throws code 2 on anything wrong. */
export async function plan(opts = {}, o = {}) {
  const R = await rules(o);
  const people = (opts.people || []).map((p) => (typeof p === 'string' ? { photo: p } : p));
  if (!people.length) throw err('Give a photo: palm passport make <photo.jpg> --doc <id>');
  for (const p of people) {
    if (!p.photo) throw err('Each person needs a photo.');
    if (!existsSync(p.photo)) throw err(`No photo at ${p.photo}`);
    if (statSync(p.photo).size > 60e6) throw err(`${p.photo} is over 60 MB: use the camera's own photo, not a scan of a poster.`);
  }
  const pro = [];
  let custom = null;
  if (opts.size) {
    const s = Array.isArray(opts.size) ? opts.size.map(Number) : String(opts.size).toLowerCase().replace(/mm$/, '').split(/[x×*,\s]+/).map(Number);
    if (s.length !== 2 || s.some((v) => !(v >= 5 && v <= 200))) throw err(`--size wants width x height in mm, 5 to 200 each (e.g. 30x40); got "${opts.size}".`);
    let head = null;
    if (opts.head) {
      head = Array.isArray(opts.head) ? opts.head.map(Number) : String(opts.head).split(/[-–,\s]+/).map(Number);
      if (head.length !== 2 || head.some((v) => !(v > 0)) || head[0] > head[1] || head[1] >= s[1]) throw err(`--head wants the head's chin-to-crown range in mm, smaller than the height (e.g. 24-30); got "${opts.head}".`);
    }
    custom = { w: s[0], h: s[1], head, bg: '#ffffff' };
    pro.push('a custom size');
  } else if (opts.head) throw err('--head goes with --size (a custom size). A listed document uses its own head rule.');
  for (const p of people) {
    p.docId = custom ? 'custom' : (p.doc || opts.doc);
    if (!p.docId) throw err('Which document? --doc <id> (find it with: palm passport docs <country or document>)');
    if (custom) { p.d = { id: 'custom', name: `Custom size ${custom.w} × ${custom.h} mm`, size: [custom.w, custom.h], head: custom.head, headPct: custom.head ? null : [70, 80], bg: ['#ffffff'], bgName: 'your background colour', printable: true, digital: null, diy: true, source: [] }; continue; }
    const office = R.OFFICE.find((x) => x.id === p.docId);
    if (office) throw Object.assign(err(`${office.name}: the photo is taken for you, so there's nothing to make. ${office.note} (rules: ${office.source})`, 1), { office: describe(office, R) });
    p.d = R.DOCS.find((x) => x.id === p.docId);
    if (!p.d) throw err(await unknownDoc(p.docId, R));
  }
  if (people.length > 1) {
    pro.push('several people on one sheet');
    const up = people.filter((p) => p.d.printable === false);
    if (up.length) throw err(`${up[0].d.name} is upload only (no print), so it can't share a sheet: make it on its own.`);
  }
  const paper = String(opts.paper || '4x6').toLowerCase();
  if (!PAPER_IDS.includes(paper)) throw err(`--paper is one of ${PAPER_IDS.join(', ')}; got "${opts.paper}".`);
  // the background: keep the person's own (default), plain (the document's first allowed colour, as the app's "Make it
  // white/plain"), or a colour: free when the document allows it, any other is Pro
  let bg = String(opts.bg || 'keep').toLowerCase();
  if (bg === 'white') bg = '#ffffff';
  if (!['keep', 'plain'].includes(bg) && !HEX.test(bg)) throw err(`--bg is keep, plain, white or a colour like #dcdcdc; got "${opts.bg}".`);
  const notes = [];
  if (custom && HEX.test(bg)) { custom.bg = bg; for (const p of people) p.d.bg = [bg]; }
  if (HEX.test(bg)) {
    for (const p of people) {
      const allowed = (p.d.bg || []).map((c) => c.toLowerCase());
      if (!allowed.includes(bg) && !custom) {
        if (!pro.includes('any background colour')) pro.push('any background colour');
        notes.push(`${p.d.name} wants ${p.d.bgName} (${allowed.join(', ')}); ${bg} isn't one of them. Use --bg plain for the document's own colour.`);
      }
    }
  }
  return { people, custom, paper, bg, pro, notes, R };
}

// ---- the browser ----
function loadPuppeteer() {
  for (const base of [process.env.PALM_NODE_MODULES, process.cwd(), join(process.cwd(), 'palm')].filter(Boolean)) {
    try { return createRequire(join(base, 'x.js'))('puppeteer-core'); } catch { /* next */ }
  }
  throw err('The passport desk needs puppeteer-core in this folder: npm i puppeteer-core (or palm setup). Check with: palm doctor', 4);
}
export const passportDir = () => join(configDir(), 'passport');

// In the page, before its scripts: the app's own Pro unlock only when Palm Pro allows it (the app reads localStorage
// "yz-unlocked"), no remembered document, and a file input's click() does nothing (the app opens a file picker when a
// person is added; the desk hands the photo in itself).
function prime() {
  try { localStorage.removeItem('yz-pp'); } catch { /* not this frame */ }
  const click = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { if (this.type === 'file') return; return click.call(this); };
}

export async function open({ base = SITE() } = {}) {
  const puppeteer = loadPuppeteer(), chrome = findChrome();
  if (!chrome) throw err('No Chrome, Edge or Chromium found. Install one or set PALM_CHROME (palm doctor).', 4);
  const opts = { executablePath: chrome, headless: 'new', timeout: 90000, protocolTimeout: 900000, args: ['--no-first-run', '--no-default-browser-check'] };
  // a profile of its own, so the face finder (~4 MB) and the background cut-out (~44 MB) download once
  let browser;
  try { mkdirSync(join(passportDir(), 'chrome'), { recursive: true, mode: 0o700 }); browser = await puppeteer.launch({ ...opts, userDataDir: join(passportDir(), 'chrome') }); }
  catch { browser = await puppeteer.launch(opts); } // the profile is in use by another run: a fresh one
  const net = { hosts: new Set(), blocked: [] };
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const u = r.url();
      if (/^(data|blob):/.test(u)) return r.continue();
      if (r.method() !== 'GET' && r.method() !== 'HEAD') { net.blocked.push(r.method() + ' ' + u.slice(0, 120)); return r.abort(); }
      if (/tinylytics|googletagmanager|\/api\/yuzool\//.test(u)) { net.blocked.push('analytics ' + host(u)); return r.abort(); }
      try { net.hosts.add(new URL(u).host); } catch { /* none */ }
      r.continue();
    });
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    await page.evaluateOnNewDocument(prime);
    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    const ready = () => page.waitForFunction(() => window.PP && typeof PP.buildOne === 'function', { timeout: 30000 });
    // a fresh page for every run; the app's own Pro (localStorage "yz-unlocked") only when Palm Pro allows it
    const load = async (query = '', pro = false) => {
      net.hosts.clear(); net.blocked.length = 0;
      await page.goto(base + '/passport-photo/' + query, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const changed = await page.evaluate((pro) => {
        const k = 'yz-unlocked', was = localStorage.getItem(k) || '[]', u = (JSON.parse(was) || []).filter((x) => x !== 'passport-photo');
        if (pro) u.push('passport-photo');
        localStorage.setItem(k, JSON.stringify(u)); return JSON.stringify(u) !== was;
      }, pro);
      if (changed) await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await ready();
    };
    return { page, net, load, close: () => browser.close() };
  } catch (e) { await browser.close(); throw e; }
}

// In the page: one person's photo in, through the app's own reading (decode, MediaPipe, fit, checks).
async function addPhoto(b64, type, first) {
  if (!first) await PP.addPerson();
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  try { await PP.loadUrl(url); } finally { URL.revokeObjectURL(url); }
  const p = PP.person();
  return { ok: !!(p && p.tf), err: p && p.err, faces: p && p.read ? p.read.faces : 0, n: PP.S.people.length };
}
async function settle(i, o) {
  const sel = (k) => { PP.S.cur = k; const chips = document.querySelectorAll('.pp-chip'); if (chips[k]) chips[k].click(); };
  sel(i);
  const p = PP.person();
  if (o.custom) { PP.S.custom = o.custom; PP.setDoc('custom'); } else if (p.docId !== o.docId) PP.setDoc(o.docId);
  p.glassesOff = !!o.glassesOff; p.baby = !!o.baby && !!PP.doc().baby;
  let bgErr = null;
  if (o.bg !== 'keep') {
    p.bgColour = o.bg === 'plain' ? null : o.bg;
    await PP.setBg('replace');
    if (p.bgMode !== 'replace' || !(p.repl || p.maskC)) bgErr = 'The background couldn’t be changed (the cut-out model failed to load or run).';
  }
  sel(i); PP.runChecks();
  return { bgErr };
}
async function readOut(i) {
  const sel = (k) => { PP.S.cur = k; const chips = document.querySelectorAll('.pp-chip'); if (chips[k]) chips[k].click(); };
  sel(i); PP.runChecks();
  const b64 = (blob) => new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
  const p = PP.person(), d = PP.doc(), out = { verdicts: p.verdicts, summary: PP.checks.summary(p.verdicts || []), docId: d.id };
  const m = p.measure || {};
  out.measure = { headMm: m.head, eyesMm: m.eyes, crownEstimated: !!m.crownEstimated, pxPerMm: m.pxPerMm, missingMm: m.missing };
  if (d.printable !== false) { const o = await PP.buildOne(); out.one = { name: o.name, b64: await b64(o.blob) }; }
  if (d.digital) { const o = await PP.buildDigital(); out.digital = { name: o.name, b64: await b64(o.blob), fits: o.fits }; }
  PP.drawEditor();
  const fr = document.querySelector('#frame');
  out.look = fr ? fr.toDataURL('image/png').split(',')[1] : null;
  const foot = (id) => { const e = document.querySelector('#' + id + ' .group-footer'); return e ? e.textContent.trim() : null; };
  out.bgFooter = foot('bgSec'); out.checksFooter = foot('checksSec');
  out.docNotes = [...document.querySelectorAll('#docSec .pp-note')].map((e) => e.textContent.replace(/\s+/g, ' ').trim());
  return out;
}
async function buildSheet(paper) {
  PP.S.paper = paper;
  const o = await PP.buildPrint();
  const b = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.readAsDataURL(o.blob); });
  return { name: o.name, n: o.n, px: o.px, b64: b };
}

const write = (f, b64) => { const b = Buffer.from(b64, 'base64'); writeFileSync(f, b); return { file: resolve(f), bytes: b.length, buf: b }; };
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif', '.avif': 'image/avif', '.gif': 'image/gif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff' };
function jpegFacts(R, w) { const i = R.sheet.jpegInfo(new Uint8Array(w.buf)); return { file: w.file, bytes: w.bytes, w: i && i.w, h: i && i.h, dpi: i && i.dpi }; }

/** Make the photo(s). opts: { people: [photo | {photo, doc}], doc, paper, bg, size, head, glassesOff, baby, out, pro: async () => bool, session } */
export async function make(opts = {}) {
  const P = await plan(opts, opts);
  const { people, custom, paper, bg, R } = P;
  if (P.pro.length) {
    const ok = opts.pro ? await opts.pro() : false;
    if (!ok) throw err(`${P.pro.join(', ').replace(/^./, (c) => c.toUpperCase())} ${P.pro.length > 1 ? 'are' : 'is'} part of Palm Pro (one photo on a document's own background is free). Run \`palm login\` (or set PALM_KEY). About Pro: https://www.yuzool.com/palm/#pro`, 3);
  }
  const out = opts.out || 'palm-passport';
  mkdirSync(out, { recursive: true });
  const first = people[0];
  const s = opts.session || await open();
  const result = { made: new Date().toISOString(), tool: 'palm passport', app: APP(), rulesChecked: R.CHECKED, paper, bg, out: resolve(out), people: [], notes: [...P.notes], ok: true };
  try {
    await s.load(`?doc=${encodeURIComponent(custom ? 'us-passport' : first.docId)}&paper=${paper}`, P.pro.length > 0);
    for (let i = 0; i < people.length; i++) {
      const p = people[i], buf = readFileSync(p.photo);
      const a = await s.page.evaluate(addPhoto, buf.toString('base64'), MIME[extname(p.photo).toLowerCase()] || 'image/jpeg', i === 0);
      const entry = { photo: resolve(p.photo), doc: custom ? { id: 'custom', name: p.d.name, sizeText: sizeText(p.d), headText: headText(p.d), size: p.d.size } : describe(p.d, R) };
      result.people.push(entry);
      if (!a.ok) {
        entry.error = a.err || 'The photo couldn’t be read.';
        entry.faces = a.faces || 0;
        result.ok = false;
        // the app keeps an unread person in its list; take them out so the sheet has only finished photos
        await s.page.evaluate(() => { const S = PP.S; S.people.splice(S.cur, 1); S.cur = Math.max(0, S.people.length - 1); });
        continue;
      }
      const st = await s.page.evaluate(settle, a.n - 1, { docId: p.docId, custom, bg, glassesOff: !!opts.glassesOff, baby: !!opts.baby });
      entry.index = a.n - 1;
      if (st.bgErr) { entry.bgError = st.bgErr; result.notes.push(st.bgErr + ' The photo was made with its own background.'); }
    }
    const done = result.people.filter((e) => e.index != null);
    for (const [k, e] of done.entries()) {
      const r = await s.page.evaluate(readOut, e.index);
      const n = done.length > 1 ? '-' + (k + 1) : '';
      e.verdicts = r.verdicts; e.summary = r.summary; e.measure = r.measure;
      e.ok = !r.verdicts.some((v) => v.state === 'bad');
      if (!e.ok) result.ok = false;
      e.ask = r.verdicts.filter((v) => v.state === 'ask').map((v) => v.detail);
      if (r.one) e.photoFile = jpegFacts(R, write(join(out, r.one.name.replace(/\.jpg$/, `${n}.jpg`)), r.one.b64));
      if (r.digital) { e.digital = { ...jpegFacts(R, write(join(out, r.digital.name.replace(/\.jpg$/, `${n}.jpg`)), r.digital.b64)), fits: r.digital.fits, limits: e.doc.digital || null }; if (!r.digital.fits) result.notes.push(`${e.doc.name}: the digital photo was saved, but it couldn’t meet the file-size limit exactly.`); }
      if (r.look) e.look = write(join(out, `look${n || '-1'}.png`), r.look).file;
      e.checksNote = r.checksFooter; e.bgNote = r.bgFooter; e.docNotes = r.docNotes;
    }
    if (done.length) {
      await s.page.evaluate((i) => { PP.S.cur = i; const c = document.querySelectorAll('.pp-chip'); if (c[i]) c[i].click(); PP.runChecks(); }, done[0].index);
      const el = await s.page.$('.pp-cols');
      if (el) { const f = join(out, 'page.png'); await el.screenshot({ path: f }); result.pageShot = resolve(f); }
      if (done.some((e) => e.doc.printable !== false)) {
        const sh = await s.page.evaluate(buildSheet, paper);
        const w = write(join(out, sh.name), sh.b64);
        result.sheet = { paper, photos: sh.n, file: w.file, bytes: w.bytes, ...(sh.name.endsWith('.pdf') ? { format: 'pdf', page: pdfPage(w.buf), px: sh.px } : { format: 'jpeg', ...jpegFacts(R, w) }) };
      }
    }
    result.network = { hosts: [...s.net.hosts].sort(), blocked: s.net.blocked, uploads: s.net.blocked.filter((b) => !b.startsWith('analytics')).length ? 'blocked (see blocked)' : 'none' };
  } finally { if (!opts.session) await s.close(); }
  for (const e of result.people) for (const k of ['photoFile', 'digital']) if (e[k]) delete e[k].buf;
  result.office = 'The checks are advice against the published rules, not a promise: the office that takes the photo decides.';
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(result, null, 2) + '\n');
  result.manifest = resolve(join(out, 'manifest.json'));
  return result;
}
function pdfPage(buf) {
  const m = /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(buf.toString('latin1'));
  return m ? { wMm: Math.round(+m[1] / 72 * 25.4 * 10) / 10, hMm: Math.round(+m[2] / 72 * 25.4 * 10) / 10 } : null;
}

// ---- Pro: checked against Palm once a day, cached. Only the Palm key goes to Palm, never the photo. ----
export async function proOk({ check, now = Date.now() } = {}) {
  const f = join(passportDir(), 'pro.json');
  try { const c = JSON.parse(readFileSync(f, 'utf8')); if (c.ok && now - c.at < 86400e3) return true; } catch {}
  const ok = !!(await check());
  mkdirSync(passportDir(), { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify({ ok, at: now }), { mode: 0o600 });
  return ok;
}

// ---- text for people (the CLI and the MCP share it) ----
const ICON = { ok: '✓', warn: '!', bad: '✗', ask: '?', info: 'i' };
const kb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');
export function summary(r) {
  const L = [];
  for (const [k, e] of r.people.entries()) {
    const d = e.doc;
    if (r.people.length > 1) L.push(`Person ${k + 1}: ${basename(e.photo)}`);
    L.push(`${d.name}: ${d.sizeText}, ${d.headText}${d.bgName ? ', ' + d.bgName : ''}.${d.source && d.source[0] ? ` Rules: ${d.source[0]} (checked ${d.checked}).` : ''}`);
    if (e.error) { L.push(`✗ ${e.error}`, '  Nothing was made from this photo. Ask for a photo of one person facing the camera, the whole head in the picture.', ''); continue; }
    if (d.takenForYou) L.push(`! USUALLY TAKEN FOR YOU: ${d.diyNote}`);
    else if (d.diy === 'note' && d.diyNote) L.push(`i Before you start: ${d.diyNote}`);
    if (d.headNote) L.push(`i ${d.headNote}`);
    if (e.photoFile) L.push(`Photo: ${e.photoFile.file} (${e.photoFile.w} × ${e.photoFile.h} px, ${e.photoFile.dpi} dpi, ${kb(e.photoFile.bytes)})`);
    if (e.digital) L.push(`Digital (for the online form): ${e.digital.file} (${e.digital.w} × ${e.digital.h} px, ${kb(e.digital.bytes)}${e.digital.fits ? '' : ', COULD NOT MEET THE FILE-SIZE LIMIT'})${e.digital.limits && e.digital.limits.note ? '\n  ' + e.digital.limits.note : ''}`);
    if (e.measure && e.measure.headMm != null) L.push(`Head ${r1(e.measure.headMm)} mm chin to crown${e.measure.crownEstimated ? ' (top of the head estimated)' : ''}${d.head ? ` (rule ${r1(d.head[0])}–${r1(d.head[1])})` : ''}${e.measure.eyesMm != null && d.eyes ? `, eyes ${r1(e.measure.eyesMm)} mm from the bottom` : ''}.`);
    L.push(`Checks: ${e.summary.text} (advice against the published rules, not a promise; the office decides)`);
    for (const v of e.verdicts) L.push(`  ${ICON[v.state] || '-'} ${v.title}${v.state === 'ok' ? '' : ': ' + v.detail}${v.state === 'ask' ? '  (ask the user; --glasses-off once they say so)' : ''}`);
    if (e.bgNote) L.push(`Background: ${e.bgNote}`);
    if (r.bg === 'keep' && e.verdicts.some((v) => ['bg', 'bgColour', 'bgDark'].includes(v.id) && v.state !== 'ok')) L.push('  To fix the background: retake against a plain light wall (best), or run again with --bg plain (cut out on this machine; read the rules\' words on edited photos above first).');
    if (e.look) L.push(`Look: ${e.look} (the photo with the app's guides: the shaded band is where the top of the head may be, solid lines the top of the head and the chin, dashed the eyes; green fine, amber check, red fix)`);
    L.push('');
  }
  if (r.sheet) L.push(`Print sheet (${r.sheet.paper}, ${r.sheet.photos} photo${r.sheet.photos === 1 ? '' : 's'}): ${r.sheet.file} ${r.sheet.format === 'pdf' ? `(PDF, ${r.sheet.page ? r.sheet.page.wMm + ' × ' + r.sheet.page.hMm + ' mm page' : ''}; print at 100 % / Actual size: the 50 mm line at the bottom must measure 50 mm)` : `(${r.sheet.w} × ${r.sheet.h} px, ${r.sheet.dpi} dpi; order it as a ${r.sheet.paper === '4x6' ? '4 × 6 in (10 × 15 cm)' : '5 × 7 in (13 × 18 cm)'} print, no borders, no cropping; cut along the grey lines)`}`);
  for (const n of r.notes) L.push(`note: ${n}`);
  if (r.pageShot) L.push(`The app as the person sees it: ${r.pageShot}`);
  L.push(`Privacy: the photo was processed in Chrome on this machine; uploads: ${r.network ? r.network.uploads : 'none'}.`);
  L.push(r.ok ? 'Nothing flagged as needing a fix. Still advice only: the office that takes the photo decides.' : 'Something needs fixing (✗ above) before this photo is used: tell the user plainly what, and what to do. Never say it will be accepted.');
  L.push(`Manifest: ${r.manifest}`, 'LOOK at each look-N.png and page.png before you tell the user anything.');
  return L.join('\n');
}
