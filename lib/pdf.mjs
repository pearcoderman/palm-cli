// Palm's PDF desk: Yuzool PDF Tools and Redact, driven by an agent on the user's machine. Their own code does the work
// (loaded from yuzool.com/pdf-tools/ and /redact/ into the user's Chrome, headless): Palm adds no PDF rules of its own.
// Files never leave the machine: they go into the page from here and come back from the page to here. The page may
// only fetch (GET) from the site and the PDF libraries' CDN; every other request, and anything that isn't a GET, is
// refused, so nothing the user gives can be uploaded. Palm never sends email: signing requests come with .eml drafts.
//
//   info · merge · extract · split · rotate · compress · password add|remove   free (PDF Tools' own jobs)
//   redact        Redact's find rules, its rebuild as pictures and its check of the saved file             Palm Pro
//   sign request  PDF Tools' Ask others to sign: the request travels inside the PDF (yuzool.com/sign)     Palm Pro
//   sign check    a signed copy checked as PDF Tools checks it (the packet's fingerprint of the original)  Palm Pro
// Every run writes manifest.json; redact and sign request also write look.png to open.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join, resolve, dirname, basename } from 'node:path';
import { configDir } from './client.mjs';
import { findChrome } from './doctor.mjs';
import { hval, henc, hname } from './invoice.mjs';

export const SITE = () => (process.env.PALM_PDF_BASE || 'https://www.yuzool.com').replace(/\/$/, '');
export const SIGN_URL = 'https://www.yuzool.com/sign';
const CDN = 'https://cdn.jsdelivr.net/npm/';
const MAX_BYTES = 150e6;
const err = (msg, code = 2) => Object.assign(new Error(msg), { code });

// ---- arguments (pure) ----
// Redact's rules (src/redact/js/find.js RULES ids; pdf-test.mjs checks they still match) and the words people use
export const RULE_IDS = ['email', 'card', 'iban', 'sort', 'phone', 'ni', 'ssn', 'postcode', 'zip', 'date'];
export const RULE_DEFAULT = ['email', 'card', 'iban', 'sort', 'phone', 'ni', 'ssn']; // Redact's "on" rules
const ALIAS = { emails: 'email', 'email-addresses': 'email', cards: 'card', 'card-numbers': 'card', 'credit-cards': 'card', ibans: 'iban', bank: 'sort', 'sort-codes': 'sort', 'sort-code': 'sort', 'account-numbers': 'sort', phones: 'phone', 'phone-numbers': 'phone', telephone: 'phone', 'national-insurance': 'ni', nino: 'ni', ssns: 'ssn', 'social-security': 'ssn', postcodes: 'postcode', zips: 'zip', 'zip-codes': 'zip', dates: 'date', dob: 'date', 'dates-of-birth': 'date' };
export function parseRules(list) {
  const ids = String(list || '').toLowerCase().split(/[,\s]+/).filter(Boolean).flatMap((x) => x === 'all' ? RULE_IDS : x === 'default' || x === 'personal' ? RULE_DEFAULT : [ALIAS[x] || x]);
  const bad = ids.filter((x) => !RULE_IDS.includes(x));
  if (bad.length) throw err(`Unknown kind to find: ${bad.join(', ')}. Kinds: ${RULE_IDS.join(', ')} (or default, all).`);
  return [...new Set(ids)];
}
// --text "Ann Lee, 12 Mill Road" or several --text: Redact's own split (a new line, or a comma followed by more text)
export const parseTerms = (list) => [].concat(list || []).flatMap((s) => String(s).split(/\n|,(?=\s*\S)/)).map((x) => x.trim()).filter((x) => x.length >= 2);
// "1-3,5" → [1,2,3,5] (PDF Tools' parseRanges does the real check in the page; this is for --pages filters)
export function parsePages(txt, max = Infinity) {
  if (txt == null || txt === '' || txt === true) return null;
  const out = new Set();
  for (const part of String(txt).split(/[,;]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(?:-|–|to)\s*(\d+)$/i) || part.match(/^(\d+)$/);
    if (!m) throw err(`"${part}" is not a page or range (e.g. 1-3,5)`);
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || a > b || b > max) throw err(`"${part}" is outside pages 1 to ${max}`);
    for (let i = a; i <= b; i++) out.add(i);
  }
  if (!out.size) throw err('Give at least one page, e.g. 1-3');
  return [...out].sort((x, y) => x - y);
}
// "Sam Lee <sam@example.com>" / "Sam Lee sam@example.com" / "Sam Lee"
export function parsePerson(s) {
  const t = String(s || '').trim(), m = t.match(/^(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/) || t.match(/^(.*?)\s+([^\s@]+@[^\s@]+\.[^\s@]+)$/);
  const name = (m ? m[1] : t).replace(/^["']|["']$/g, '').trim(), email = m ? m[2] : '';
  if (!name) throw err(`"${t}": give a name, e.g. "Sam Lee <sam@example.com>"`);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err(`"${email}" doesn't look like an email address`);
  return { name: name.slice(0, 60), email };
}
// Where the boxes go when the user doesn't say: the bottom of the last page, one block per signer (signature, date,
// name). In PDF Tools' units: points from the page's top left, page 1-based here (the app's packet is 0-based).
export function defaultBoxes(pageSize, signers, page) {
  const { w: W, h: H } = pageSize, M = Math.min(56, W * 0.09), step = 84, out = [];
  for (let i = 0; i < signers; i++) {
    const y = H - M - (signers - i) * step + 8;
    out.push({ page, kind: 'signature', signer: i + 1, x: M, y, w: 180, h: 44 },
      { page, kind: 'date', signer: i + 1, x: M + 200, y: y + 26, w: 110, h: 18 },
      { page, kind: 'name', signer: i + 1, x: M, y: y + 50, w: 180, h: 18 });
  }
  return out;
}
export const KINDS = ['signature', 'initials', 'date', 'name', 'text', 'check'];
export function checkBoxes(boxes, { pages, signers }) {
  if (!Array.isArray(boxes) || !boxes.length) throw err('Boxes: a JSON list like [{"page":1,"kind":"signature","signer":1,"x":56,"y":700,"w":180,"h":44}]');
  return boxes.map((b, i) => {
    const where = `box ${i + 1}`;
    if (!KINDS.includes(b.kind)) throw err(`${where}: kind is one of ${KINDS.join(', ')}`);
    if (!Number.isInteger(b.page) || b.page < 1 || b.page > pages.length) throw err(`${where}: page is 1 to ${pages.length}`);
    if (!Number.isInteger(b.signer) || b.signer < 1 || b.signer > signers) throw err(`${where}: signer is 1 to ${signers} (their place in --signer order)`);
    if (![b.x, b.y, b.w, b.h].every(Number.isFinite) || b.w <= 0 || b.h <= 0) throw err(`${where}: x, y, w, h are numbers in points from the page's top left`);
    const P = pages[b.page - 1];
    if (b.x < 0 || b.y < 0 || b.x + b.w > P.w + 0.5 || b.y + b.h > P.h + 0.5) throw err(`${where}: off page ${b.page} (${Math.round(P.w)}×${Math.round(P.h)} points)`);
    return { page: b.page, kind: b.kind, signer: b.signer, x: b.x, y: b.y, w: b.w, h: b.h };
  });
}
// What was blacked out, without writing it down again: first letter of each word, the rest dotted
export const mask = (s) => String(s).split(/(\s+)/).map((w) => /\s/.test(w) ? w : w.length <= 1 ? '•' : w[0] + '•'.repeat(Math.min(w.length - 1, 12))).join('');

// ---- the browser ----
function loadPuppeteer() {
  for (const base of [process.env.PALM_NODE_MODULES, process.cwd(), join(process.cwd(), 'palm')].filter(Boolean)) {
    try { return createRequire(join(base, 'x.js'))('puppeteer-core'); } catch { /* next */ }
  }
  throw err('The PDF desk needs puppeteer-core in this folder: npm i puppeteer-core (or palm setup). Check with: palm doctor', 4);
}
// only GETs, only to the site and the libraries' CDN: the user's files can't leave the page
export const allowed = (url, method, base) => method === 'GET' && (url.startsWith(base + '/') || url.startsWith(CDN) || /^(data|blob):/.test(url)) && !/\/api\//.test(url);

export async function launch() {
  const puppeteer = loadPuppeteer(), chrome = findChrome();
  if (!chrome) throw err('No Chrome, Edge or Chromium found. Install one or set PALM_CHROME (palm doctor).', 4);
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', timeout: 90000, protocolTimeout: 600000, args: ['--no-first-run', '--no-default-browser-check'] });
  return browser;
}
// The page in the user's YZ (mobile.js): downloads come back to Palm instead of a Downloads folder; nothing paid is
// unlocked (gate says no); for a signing request, the app's own hand-off from another app (os.incoming) carries it.
function PRELOAD(rec) {
  window.__saved = []; window.__pending = 0; window.__finished = null; window.__files = new Map();
  const os = rec && { incoming: () => ({ from: 'palm', fromName: 'Palm', payload: { kind: 'pdf', record: rec } }),
    store: () => ({ put: async (r) => { const id = 'f' + (window.__files.size + 1); window.__files.set(id, r); return Object.assign({ id }, r); }, get: async (id) => window.__files.get(id) || null }),
    finish: async (res) => { window.__finished = res; }, cancel: () => { window.__finished = 'cancel'; }, can: async () => false };
  const wrap = (v) => { if (!v || v.__palm) return v; v.__palm = true;
    v.shareFile = async (blob, name) => { window.__pending++; try { window.__saved.push({ name, bytes: new Uint8Array(await blob.arrayBuffer()) }); } finally { window.__pending--; } return 'downloaded'; };
    if (os) v.os = async () => os;
    v.pro = Object.assign({}, v.pro || {}, { has: () => false, gate: async () => false, onChange: () => () => {}, paywall: () => {} });
    return v; };
  let cur; Object.defineProperty(window, 'YZ', { configurable: true, get: () => cur, set: (v) => { cur = wrap(v); } });
}
async function openPage(browser, path, { rec } = {}) {
  const base = SITE(), page = await browser.newPage();
  await page.setBypassServiceWorker(true);
  await page.setRequestInterception(true);
  const refused = [];
  page.on('request', (r) => { if (allowed(r.url(), r.method(), base)) r.continue(); else { if (r.method() !== 'GET') refused.push(r.method() + ' ' + r.url().slice(0, 80)); r.abort(); } });
  await page.evaluateOnNewDocument(PRELOAD, rec || null);
  await page.setViewport({ width: 1100, height: 900 });
  await page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 60000 });
  page.refused = refused;
  return page;
}

// Runs in the page, PDF Tools: its core.js (the same module the page runs), pdfcrypt.js, and window.PDFT
async function installTools() {
  const C = await import('/pdf-tools/js/core.js'), X = await import('/pdf-tools/js/pdfcrypt.js');
  await C.libs();
  const toB64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); };
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const statusText = () => { const s = document.getElementById('status'); return s && !s.hidden ? s.textContent : ''; };
  const statusErr = () => { const s = document.getElementById('status'); return s && !s.hidden && s.classList.contains('err') ? s.textContent : ''; };
  const reset = () => { try { PDFT.closeSigner(); } catch (e) { /* not open */ } C.S.pages.length = 0; C.files.length = 0; C.S.selecting = false; C.S.imgSize = 'fit'; C.S.quality = 'med'; try { PDFT.render(); } catch (e) { /* none */ } C.status(''); window.__saved.length = 0; };
  const typeOf = (n) => /\.png$/i.test(n) ? 'image/png' : /\.jpe?g$/i.test(n) ? 'image/jpeg' : 'application/pdf';
  // add files as the page does (a protected PDF asks for its password: we give the one we were given, once)
  const add = async (list, password) => {
    const prev = C.hooks.askPassword; let asked = 0, wrong = false;
    C.hooks.askPassword = async (name, again) => { asked++; if (again) { wrong = true; return null; } return password == null ? null : password; };
    try { await C.addFiles(list.map((f) => new File([fromB64(f.b64)], f.name, { type: typeOf(f.name) }))); } finally { C.hooks.askPassword = prev; }
    const e = C.files.length < list.length ? (wrong ? 'The password isn’t right for ' + list.map((f) => f.name).join(', ') + '.' : asked && password == null ? 'This PDF has a password: give it with --password (or PALM_PDF_PASSWORD).' : statusText() || 'A file could not be read.') : '';
    return { error: e, unlocked: C.files.some((f) => f.locked || f.limits) };
  };
  const idle = async () => { await sleep(20); while (C.S.busy || window.__pending) await sleep(40); };   // the job, then the download it started (not awaited by the page)
  const pagesOf = async (bytes) => { try { return (await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount(); } catch (e) { return null; } };
  const take = async () => { const out = []; for (const s of window.__saved.splice(0)) out.push({ name: s.name, b64: toB64(s.bytes), bytes: s.bytes.length, pages: /\.pdf$/i.test(s.name) ? await pagesOf(s.bytes) : null }); return out; };
  const done = async (extra = {}) => { await idle(); const files = await take(); const e = statusErr(); return files.length ? { files, status: statusText(), ...extra } : { error: e || 'Nothing was made.' }; };
  const sha = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const textOf = async (pj) => { const t = []; for (let i = 1; i <= pj.numPages; i++) t.push((await (await pj.getPage(i)).getTextContent()).items.map((x) => x.str).join(' ').replace(/\s+/g, ' ').trim()); return t; };
  window.PALM_PDF = {
    async merge(list, o) { reset(); C.S.imgSize = o.pageSize || 'fit'; const a = await add(list, o.password); if (a.error) return a; await C.saveAll(); return done({ unlocked: a.unlocked }); },
    async rotate(f, o) {
      reset(); const a = await add([f], o.password); if (a.error) return a;
      const n = C.S.pages.length, want = o.pages || C.S.pages.map((_, i) => i + 1);
      if (want.some((p) => p > n)) return { error: `This PDF has ${n} page${n > 1 ? 's' : ''}.` };
      for (let t = 0; t < o.by / 90; t++) want.forEach((p) => { const pg = C.S.pages[p - 1]; pg.rot = (pg.rot + 90) % 360; });   // as the page's Rotate does, 90° at a time
      await C.saveAll(); return done({ unlocked: a.unlocked });
    },
    async extract(f, o) {
      reset(); const a = await add([f], o.password); if (a.error) return a;
      let r; try { r = C.parseRanges(o.ranges, C.S.pages.length); } catch (e) { return { error: e.message }; }
      const list = []; for (const [x, y] of r) for (let i = x; i <= y; i++) list.push(C.S.pages[i - 1]);
      await C.extractSel(list); return done({ unlocked: a.unlocked });
    },
    async split(f, o) {
      reset(); const a = await add([f], o.password); if (a.error) return a;
      if (o.ranges) { const e = C.splitRanges(o.ranges); if (e) return { error: e }; } else C.splitEach();
      await idle(); const z = window.__saved.splice(0)[0]; if (!z) return { error: statusErr() || 'Nothing was made.' };
      const zip = await JSZip.loadAsync(z.bytes), files = [];
      for (const name of Object.keys(zip.files)) { const b = await zip.files[name].async('uint8array'); files.push({ name, b64: toB64(b), bytes: b.length, pages: await pagesOf(b) }); }
      return { files, status: statusText(), unlocked: a.unlocked };
    },
    async compress(f, o) { reset(); const a = await add([f], o.password); if (a.error) return a; C.S.quality = o.quality || 'med'; await C.compress(); return done({ unlocked: a.unlocked }); },
    async protect(f, o) { reset(); const a = await add([f], o.current); if (a.error) return a; await C.protect({ password: o.password, print: o.print !== false, copy: o.copy !== false }); return done(); },
    async unlock(f, o) {
      reset(); const a = await add([f], o.password); if (a.error) return a;
      if (!a.unlocked) return { error: 'This PDF has no password: it opens as it is.', none: true };
      await C.saveUnlocked(); return done();
    },
    // a password check without saving anything: the plain copy opens, and the protected one doesn't without it
    async opens(b64, password) {
      const bytes = fromB64(b64), sec = await X.pdfSecurity(PDFLib, bytes);
      if (!sec) return { encrypted: false };
      try { const plain = await X.decryptPdf(PDFLib, bytes, password || ''); return { encrypted: true, opened: true, pages: await pagesOf(plain), revision: sec.revision, method: sec.method }; }
      catch (e) { return { encrypted: true, opened: false, code: e.code, revision: sec.revision, method: sec.method }; }
    },
    async info(f, password) {
      let bytes = fromB64(f.b64); const size = bytes.length, r = { name: f.name, bytes: size };
      if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) return { error: f.name + ' isn’t a PDF.' };
      let sec = null; try { sec = await X.pdfSecurity(PDFLib, bytes); } catch (e) { sec = null; }
      r.encrypted = !!sec;
      if (sec) {
        r.security = { revision: sec.revision, method: sec.method, needsPassword: !!sec.needsPassword, supported: sec.supported !== false };
        if (sec.supported === false) return { ...r, note: 'A kind of protection PDF Tools can’t open.' };
        try { bytes = await X.decryptPdf(PDFLib, bytes, sec.needsPassword ? (password || '') : ''); r.opened = true; }
        catch (e) { if (sec.needsPassword) return { ...r, opened: false, note: password ? 'That password isn’t right.' : 'It needs a password to open: give it with --password (or PALM_PDF_PASSWORD) to see inside.' }; throw e; }
      }
      const pj = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      r.pages = pj.numPages; r.sizes = []; r.textChars = [];
      for (let i = 1; i <= pj.numPages; i++) {
        const pg = await pj.getPage(i), vp = pg.getViewport({ scale: 1 }), tc = await pg.getTextContent();
        r.sizes.push({ w: Math.round(vp.width * 10) / 10, h: Math.round(vp.height * 10) / 10, rotate: pg.rotate || 0 });
        r.textChars.push(tc.items.reduce((n, x) => n + (x.str || '').replace(/\s/g, '').length, 0));
      }
      r.hasText = r.textChars.some((n) => n > 0); r.textPages = r.textChars.filter((n) => n > 0).length;
      try { const m = await pj.getMetadata(); r.meta = Object.fromEntries(Object.entries(m.info || {}).filter(([k, v]) => /^(Title|Author|Subject|Creator|Producer|CreationDate|ModDate)$/.test(k) && v).map(([k, v]) => [k, String(v).slice(0, 80)])); } catch (e) { r.meta = {}; }
      try { const a = await pj.getAttachments(); r.attachments = a ? Object.keys(a) : []; } catch (e) { r.attachments = []; }
      try { const fo = await pj.getFieldObjects(); r.formFields = fo ? Object.keys(fo).length : 0; } catch (e) { r.formFields = 0; }
      const rq = await PDFT.rqFind(pj);
      if (rq) { const pk = rq.packet, waiting = pk.people.filter((P) => pk.boxes.some((b) => b.s === P.id && !pk.done[b.id])); r.signing = { title: pk.title, from: pk.from.name, people: pk.people.map((P) => P.name), waiting: waiting.map((P) => P.name), fingerprintOk: rq.ok }; }
      pj.destroy();
      return r;
    },
    // PDF Tools opening a signed copy: rqFind (the packet, the original inside, its fingerprint) and who is still to sign
    async check(f, orig) {
      const bytes = fromB64(f.b64); let pj;
      try { pj = await pdfjsLib.getDocument({ data: bytes.slice() }).promise; } catch (e) { return { error: f.name + ' could not be opened as a PDF.' }; }
      const rq = await PDFT.rqFind(pj), text = await textOf(pj); pj.destroy();
      if (!rq) return { request: false };
      const pk = rq.packet, signedAt = (P) => { const l = [...pk.log].reverse().find((x) => x && x.ev === 'signed' && x.who === P.id); return l ? l.at : null; };
      const people = pk.people.map((P) => { const mine = pk.boxes.filter((b) => b.s === P.id); return { name: P.name, email: P.email, boxes: mine.length, filled: mine.filter((b) => pk.done[b.id]).length, signedAt: signedAt(P) }; });
      const waiting = people.filter((P) => P.filled < P.boxes).map((P) => P.name);
      const r = { request: true, id: pk.id, title: pk.title, from: pk.from, order: pk.order, created: pk.created, sha: pk.sha, fingerprintOk: rq.ok, people, waiting, complete: !waiting.length, record: text.some((t) => /Signing record/.test(t) && t.includes(pk.sha.slice(0, 32))), pages: text.length };
      if (orig) {
        const ob = fromB64(orig.b64), osha = await sha(ob);
        if (osha === pk.sha) r.original = { match: 'identical', detail: 'The original you gave is byte for byte the one that was sent for signing.' };
        else {
          let opj = null; try { opj = await pdfjsLib.getDocument({ data: ob.slice() }).promise; } catch (e) { r.original = { match: 'unreadable', detail: orig.name + ' could not be opened.' }; }
          if (opj) {
            const orq = await PDFT.rqFind(opj);
            if (orq) r.original = orq.packet.id === pk.id && orq.packet.sha === pk.sha && orq.ok ? { match: 'same-request', detail: 'The file you gave is the request that was sent (same request id and fingerprint).' } : { match: 'different', detail: 'The file you gave is a different signing request.' };
            else {
              const sent = await pdfjsLib.getDocument({ data: rq.orig.slice() }).promise, a = await textOf(opj), b = await textOf(sent); sent.destroy();
              r.original = a.length === b.length && a.every((t, i) => t === b[i]) ? { match: 'same-content', detail: `Same ${a.length} page${a.length > 1 ? 's' : ''} and text as the original inside the signed copy, but not byte for byte (one of them was saved again along the way). For a byte-for-byte check, give the "to sign" file or the original.pdf that palm pdf sign request saved.` } : { match: 'different', detail: 'The original inside the signed copy is not the document you gave: its pages or text differ.' };
            }
            opj.destroy();
          }
        }
      }
      return r;
    },
  };
  return true;
}

// Runs in the page, Redact: window.RD (loadDoc, scan, build) and its find.js
async function installRedact() {
  const toB64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); };
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  window.PALM_RD = {
    rules: () => RD.F.RULES.map((r) => ({ id: r.id, label: r.label, on: !!r.on })),
    async run(f, o) {
      const bytes = fromB64(f.b64); let D;
      try { D = await RD.loadDoc(new File([bytes], f.name, { type: 'application/pdf' }), bytes); } catch (e) { return { error: e.message }; }
      if (D.kind !== 'pdf') return { error: f.name + ' isn’t a PDF.' };
      const found = RD.scan(D, o.terms, o.rules).filter((r) => !o.pages || o.pages.includes(r.page + 1));
      // as the Find sheet's "Box n matches": every box of every match, carrying the text it covers
      const already = (r) => r.boxes.every((b) => D.pages[r.page].boxes.some((x) => x.x <= b.x + 1 && x.y <= b.y + 1 && x.x + x.w >= b.x + b.w - 1 && x.y + x.h >= b.y + b.h - 1));
      const used = []; for (const r of found) { if (already(r)) continue; used.push(r); for (const b of r.boxes) D.pages[r.page].boxes.push({ ...b, src: 'find', text: r.m.text }); }
      const hits = used.map((r) => ({ page: r.page + 1, kind: r.m.kind, term: r.m.term || null, text: r.m.text, before: r.cx.before.slice(-24), after: r.cx.after.slice(0, 24), boxes: r.boxes.length }));
      const base = { pages: D.pages.length, textPages: D.pages.filter((p) => p.pt.text.trim()).length, hidden: D.hidden };
      if (!used.length) return { ...base, hits };
      const out = await RD.build(D, { style: o.style || 'black', label: o.label || 'Redacted', dpi: o.dpi || 200, log: !!o.log });
      const ob = new Uint8Array(await out.blob.arrayBuffer());
      // and from the outside: the same finding run on the saved file finds nothing
      const D2 = await RD.loadDoc(new File([ob], out.name, { type: 'application/pdf' }), ob);
      const again = RD.scan(D2, o.terms, o.rules).map((r) => ({ page: r.page + 1, kind: r.m.kind, text: r.m.text }));
      try { D2.pdf.destroy(); D.pdf.destroy(); } catch (e) { /* none */ }
      return { ...base, hits, name: out.name, b64: toB64(ob), report: out.report, again };
    },
  };
  return true;
}

// Runs in either page (after its PDF.js is loaded): pages of a PDF side by side, with labels, as one PNG
async function lookSheet(b64, pages, label) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), pj = await pdfjsLib.getDocument({ data: bytes }).promise;
  const list = (pages && pages.length ? pages : Array.from({ length: pj.numPages }, (_, i) => i + 1)).filter((p) => p <= pj.numPages).slice(0, 12);
  const ims = [];
  for (const p of list) {
    const pg = await pj.getPage(p), v = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: 620 / Math.max(v.width, v.height) });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: x, viewport: vp }).promise; ims.push({ c, p });
  }
  pj.destroy();
  const gap = 24, top = 32, perRow = Math.min(4, ims.length), rows = Math.ceil(ims.length / perRow), cw = Math.max(...ims.map((i) => i.c.width)), ch = Math.max(...ims.map((i) => i.c.height));
  const out = document.createElement('canvas'); out.width = gap + perRow * (cw + gap); out.height = rows * (ch + top + gap) + gap;
  const x = out.getContext('2d'); x.fillStyle = '#e9e9ee'; x.fillRect(0, 0, out.width, out.height); x.font = '600 18px -apple-system, Segoe UI, sans-serif'; x.fillStyle = '#222';
  ims.forEach((im, i) => { const cx = gap + (i % perRow) * (cw + gap), cy = gap + Math.floor(i / perRow) * (ch + top + gap); x.fillText(`${label} page ${im.p}`, cx, cy + 18); x.strokeStyle = '#bbb'; x.strokeRect(cx - 0.5, cy + top - 0.5, im.c.width + 1, im.c.height + 1); x.drawImage(im.c, cx, cy + top); });
  return out.toDataURL('image/png').split(',')[1];
}

async function session(app, { rec } = {}) {
  const browser = await launch();
  try {
    if (app === 'redact') {
      const page = await openPage(browser, '/redact/');
      await page.waitForFunction(() => window.RD && typeof RD.build === 'function', { timeout: 30000 });
      await page.evaluate(installRedact);
      return { page, close: () => browser.close() };
    }
    const page = await openPage(browser, rec ? '/pdf-tools/?yzos=1' : '/pdf-tools/', { rec });
    await page.waitForFunction(() => window.PDFT && typeof PDFT.rqFind === 'function', { timeout: 30000 });
    await page.evaluate(installTools);
    return { page, close: () => browser.close() };
  } catch (e) { await browser.close(); throw e.code ? e : err('Couldn’t open ' + (app === 'redact' ? 'Redact' : 'PDF Tools') + ' at ' + SITE() + ': ' + e.message, 4); }
}

// ---- files ----
export function readInput(file) {
  if (!file) throw err('Give a PDF.');
  if (!existsSync(file)) throw err(`No such file: ${file}`);
  const st = statSync(file); if (!st.isFile()) throw err(`${file} isn't a file`);
  if (st.size > MAX_BYTES) throw err(`${file} is ${(st.size / 1e6).toFixed(0)} MB; the desk takes up to ${MAX_BYTES / 1e6} MB.`);
  const b = readFileSync(file);
  return { name: basename(file), b64: b.toString('base64'), bytes: b.length, path: resolve(file) };
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
// --out: a folder (default palm-pdf), or a file name ending .pdf for a one-file result
function outPlan(out, def) {
  const o = out || 'palm-pdf';
  if (/\.pdf$/i.test(o)) return { dir: dirname(resolve(o)), file: resolve(o) };
  return { dir: resolve(o), file: null, def };
}
function writeOut(plan, files) {
  mkdirSync(plan.dir, { recursive: true });
  if (plan.file && files.length !== 1) throw err('This makes more than one file: give --out a folder, not a .pdf name.');
  return files.map((f) => { const p = plan.file || join(plan.dir, f.name.replace(/[\\/:*?"<>|]+/g, '-')); const b = Buffer.from(f.b64, 'base64'); writeFileSync(p, b); return { file: p, bytes: b.length, pages: f.pages ?? null, sha256: sha256(b) }; });
}
function manifest(dir, m) {
  const file = join(dir, 'manifest.json');
  const clean = JSON.parse(JSON.stringify(m, (k, v) => (k === 'b64' ? undefined : v)));
  writeFileSync(file, JSON.stringify({ made: new Date().toISOString(), ...clean }, null, 2) + '\n');
  return file;
}
const inputsOf = (list) => list.map((f) => ({ file: f.path, bytes: f.bytes }));

async function withTools(fn, opt = {}) { const s = opt.session || await session('tools'); try { return await fn(s.page); } finally { if (!opt.session) await s.close(); } }
function finish(op, plan, inputs, r, extra = {}) {
  if (r.error) throw err(r.error, 1);
  const files = writeOut(plan, r.files);
  const notes = [...(extra.notes || [])];
  if (r.unlocked) notes.push('An input had a password; what was made has none. Add one with: palm pdf password add');
  const m = { tool: 'palm pdf ' + op, ok: true, inputs: inputsOf(inputs), files, notes, ...(extra.fields || {}) };
  return { ...m, manifest: manifest(plan.dir, m), out: plan.dir };
}

// ---- free: PDF Tools' own jobs ----
export async function info(file, { password, session: s } = {}) {
  const f = readInput(file);
  const r = await withTools((p) => p.evaluate((f, pw) => PALM_PDF.info(f, pw), f, password ?? null), { session: s });
  if (r.error) throw err(r.error, 1);
  return { tool: 'palm pdf info', ok: true, file: f.path, sha256: sha256(Buffer.from(f.b64, 'base64')), ...r };
}
export async function merge(list, { out, password, pageSize = 'fit', session: s } = {}) {
  if (!list || list.length < 1) throw err('Give the PDFs (or JPG/PNG photos) to merge, in order.');
  if (!['fit', 'a4', 'letter'].includes(pageSize)) throw err('--page-size is fit, a4 or letter (how photos are placed)');
  const ins = list.map(readInput);
  const r = await withTools((p) => p.evaluate((l, o) => PALM_PDF.merge(l, o), ins, { password, pageSize }), { session: s });
  if (!r.error && r.files[0]) r.files[0].name = 'merged.pdf';
  return finish('merge', outPlan(out), ins, r);
}
export async function extract(file, { pages, out, password, session: s } = {}) {
  if (!pages) throw err('Give --pages, e.g. 1-3,5');
  const f = readInput(file);
  return finish('extract', outPlan(out), [f], await withTools((p) => p.evaluate((f, o) => PALM_PDF.extract(f, o), f, { ranges: String(pages), password }), { session: s }));
}
export async function split(file, { pages, each = false, out, password, session: s } = {}) {
  if (!pages && !each) throw err('Give --pages 1-3,4-6 (one file per range) or --each (one file per page).');
  const f = readInput(file);
  const plan = outPlan(out); if (plan.file) throw err('split makes several files: give --out a folder.');
  return finish('split', plan, [f], await withTools((p) => p.evaluate((f, o) => PALM_PDF.split(f, o), f, { ranges: each ? null : String(pages), password }), { session: s }));
}
export async function rotate(file, { by = 90, pages, out, password, session: s } = {}) {
  by = ((Number(by) % 360) + 360) % 360;
  if (![90, 180, 270].includes(by)) throw err('--by is 90, 180 or 270 (clockwise)');
  const f = readInput(file), list = parsePages(pages);
  return finish('rotate', outPlan(out), [f], await withTools((p) => p.evaluate((f, o) => PALM_PDF.rotate(f, o), f, { by, pages: list, password }), { session: s }), { fields: { by, pages: list || 'all' } });
}
export async function compress(file, { quality = 'med', out, password, session: s } = {}) {
  if (!['high', 'med', 'low'].includes(quality)) throw err('--quality is high, med or low');
  const f = readInput(file);
  const r = await withTools((p) => p.evaluate((f, o) => PALM_PDF.compress(f, o), f, { quality, password }), { session: s });
  return finish('compress', outPlan(out), [f], r, { notes: ['Compressed pages are pictures now: their text can no longer be selected or searched.'], fields: { quality, from: f.bytes, to: r.files?.[0]?.bytes } });
}
export const pw = (password) => password ?? process.env.PALM_PDF_PASSWORD ?? null;
export async function protect(file, { password, current, print = true, copy = true, out, session: s } = {}) {
  if (!password) throw err('Give the new password with --password or PALM_PDF_PASSWORD (it is never printed).');
  const f = readInput(file);
  const r = await withTools(async (p) => {
    const x = await p.evaluate((f, o) => PALM_PDF.protect(f, o), f, { password, current, print, copy });
    if (x.error) return x;
    // the check: the saved file is encrypted, opens with the password, and not without it
    x.check = { withPassword: await p.evaluate((b, pw) => PALM_PDF.opens(b, pw), x.files[0].b64, password), without: await p.evaluate((b) => PALM_PDF.opens(b, ''), x.files[0].b64) };
    return x;
  }, { session: s });
  if (!r.error && !(r.check.withPassword.opened && r.check.without.encrypted && !r.check.without.opened)) throw err('The protected file didn’t pass the check (opens with the password, not without), so it wasn’t saved.', 1);
  const notes = ['AES-256 (PDF 2.0): opens in Preview, Acrobat, Chrome and Edge once the password is typed. There is no reset if it is lost.'];
  if (password.length < 8) notes.push('Short passwords can be guessed by someone with the file: use 10 characters or more.');
  if (!print || !copy) notes.push('No printing / no copying are requests most PDF apps follow, not a lock: the password is what keeps it private.');
  return finish('password add', outPlan(out), [f], r, { notes, fields: { checked: { opensWithPassword: true, opensWithout: false, method: r.check?.withPassword?.method }, allow: { print, copy } } });
}
export async function unprotect(file, { password, out, session: s } = {}) {
  const f = readInput(file);
  const r = await withTools((p) => p.evaluate((f, o) => PALM_PDF.unlock(f, o), f, { password }), { session: s });
  return finish('password remove', outPlan(out), [f], r, { notes: ['The copy made opens with no password. Keep it somewhere private.'] });
}

// ---- Pro: Redact ----
// Palm Pro includes Redact Pro's choices (owner, 2026-11-26): 150/200/300 dpi, a redaction log page, the label's words.
export async function redact(file, { rules = [], terms = [], pages, style = 'black', dpi = 200, log = false, label = 'Redacted', out, session: s } = {}) {
  dpi = Number(dpi); if (![150, 200, 300].includes(dpi)) throw err('--dpi is 150, 200 or 300.');
  label = String(label || 'Redacted').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 40) || 'Redacted';
  if (!rules.length && !terms.length) throw err('Say what to black out: --find emails,phones,… and/or --text "exact words".');
  if (!['black', 'white', 'label'].includes(style)) throw err('--style is black, white or label');
  const f = readInput(file), plan = outPlan(out); const pageList = parsePages(pages);
  const ss = s || await session('redact');
  try {
    const r = await ss.page.evaluate((f, o) => PALM_RD.run(f, o), f, { rules, terms, pages: pageList, style, dpi, log, label });
    if (r.error) throw err(/password/i.test(r.error) ? r.error + ' (palm pdf password remove makes a copy without it.)' : r.error, 1);
    mkdirSync(plan.dir, { recursive: true });
    // the words round each match, with every other match masked too, even one cut off at the edge
    const secrets = [...new Set(r.hits.map((h) => h.text))].sort((x, y) => y.length - x.length), scrub = (t) => secrets.reduce((a, x) => a.split(x).join(mask(x)), t);
    const edge = (t, end) => { for (let k = t.length; k >= 2; k--) { const part = end ? t.slice(-k) : t.slice(0, k); if (secrets.some((x) => end ? x.startsWith(part) : x.endsWith(part))) return end ? t.slice(0, -k) + mask(part) : mask(part) + t.slice(k); } return t; };
    const hits = r.hits.map(({ text, term, before, after, ...h }) => ({ ...h, masked: mask(text), before: edge(scrub(before), false), after: edge(scrub(after), true) }));
    const byKind = {}; for (const h of r.hits) byKind[h.kind] = (byKind[h.kind] || 0) + 1;
    const base = { tool: 'palm pdf redact', inputs: inputsOf([f]), asked: { find: rules, text: terms.length, pages: pageList || 'all', style }, pages: r.pages, textPages: r.textPages, found: hits.length, byKind, hits };
    if (!r.hits.length) {
      const why = r.textPages ? 'Nothing matched, so nothing was blacked out and no file was made.' : 'This PDF has no text layer (a scan or pictures), so Redact can’t find words in it. Box those by hand in Redact (https://www.yuzool.com/redact/).';
      const m = { ...base, ok: false, verified: false, reason: why, files: [] };
      return { ...m, manifest: manifest(plan.dir, m), out: plan.dir };
    }
    const outBytes = Buffer.from(r.b64, 'base64'), lo = outBytes.toString('latin1').toLowerCase();
    // the app's check (report.left: words under the boxes still in the text, the raw bytes, or still showing on a page),
    // the same finding run on the saved file (r.again), and the raw bytes searched here for each matched text
    const raw = [...new Set(r.hits.map((h) => h.text))].filter((t) => t.replace(/\s/g, '').length >= 6 && lo.includes(t.toLowerCase()));
    const left = r.report.left.map((x) => ({ masked: mask(x.t), pages: x.pages, inFile: x.inFile }));
    const verified = !r.report.left.length && !r.again.length && !raw.length;
    const verification = { ok: verified, checkedWords: r.report.terms, stillFound: left, foundAgain: r.again.map((x) => ({ page: x.page, kind: x.kind, masked: mask(x.text) })), rawBytes: raw.map(mask), metadataStillSet: r.report.meta, rebuiltPages: r.report.rebuilt, keptPages: r.report.kept, hiddenRemoved: r.report.hidden };
    const lookName = join(plan.dir, 'look.png');
    writeFileSync(lookName, Buffer.from(await ss.page.evaluate(lookSheet, r.b64, r.report.rebuilt, 'Redacted'), 'base64'));
    let files = [];
    if (verified) files = writeOut(plan, [{ name: r.name, b64: r.b64, pages: r.report.rebuilt.length + r.report.kept.length }]);
    const reason = verified ? '' : pageList && r.report.left.some((x) => x.pages.some((p) => !pageList.includes(p))) ? 'Some of what was blacked out is still readable on pages outside --pages. Redact those pages too (or drop --pages), then run again. The file was not saved.' : 'Some of what was blacked out can still be found in the saved file, so it was not saved. Box the rest (more --text or --find) and run again.';
    const m = { ...base, ok: verified, verified, verification, reason, look: lookName, files, notes: [verified ? 'Pages with boxes are pictures now (their text can’t be selected); other pages keep their text. Document info, attachments, forms and scripts are not copied.' : 'Nothing was saved except look.png and this manifest.'] };
    return { ...m, manifest: manifest(plan.dir, m), out: plan.dir, lookHint: 'Open look.png before you finish: every redacted page as it now looks. Check each box covers what it should and nothing else is showing.' };
  } finally { if (!s) await ss.close(); }
}

// ---- Pro: Ask others to sign ----
const emlMixed = ({ to, from, subject, body, file, name }) => {
  const b = 'palm-' + Math.random().toString(36).slice(2), data = readFileSync(file).toString('base64').replace(/.{76}/g, '$&\r\n');
  const fn = hval(name).replace(/["\\]/g, '');
  return [`To: ${hname(to.name, to.email)}`, ...(from.email ? [`From: ${hname(from.name, from.email)}`] : []), `Subject: ${henc(subject)}`, 'X-Unsent: 1', 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', body, '',
    `--${b}`, `Content-Type: application/pdf; name="${/^[\x20-\x7e]*$/.test(fn) ? fn : 'to-sign.pdf'}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${/^[\x20-\x7e]*$/.test(fn) ? fn : 'to-sign.pdf'}"`, '', data, `--${b}--`, ''].join('\r\n');
};
export function askEmail(pk, P) { // the words PDF Tools' "Email" button uses (sign.js rqAsk)
  const first = String(P.name || '').trim().split(/\s+/)[0] || 'there';
  const next = pk.order === 'order' && pk.people.length > 1 ? 'Send the signed copy on as it says when you finish' : 'Send the signed copy back to me' + (pk.from.email ? ' at ' + pk.from.email : '');
  return { subject: 'Please sign: ' + pk.title, body: `Hi ${first},\n\nPlease sign "${pk.title}". It's attached as a PDF.\n\n1. Save the attached PDF.\n2. Open ${SIGN_URL} and choose the file. It's free, and the file stays on your device.\n3. Fill each box with your name on it, then press Finish.\n4. ${next}.\n\nThanks,\n${pk.from.name}` };
}
export async function signRequest(file, { signers = [], from, title, boxes, order = true, out } = {}) {
  const people = [].concat(signers).map(parsePerson);
  if (!people.length) throw err('Give who signs: --signer "Sam Lee <sam@example.com>" (once per person, in signing order).');
  // Palm Pro includes more than two signers (owner, 2026-11-26; in the app it's Yuzool Plus); PDF Tools has six signer colours
  if (people.length > 6) throw err('At most six people can sign one request (PDF Tools has six signer colours). Send the signed copy on as a new request for the others.');
  const sender = parsePerson(from || '');
  const f = readInput(file), plan = outPlan(out); if (plan.file) throw err('sign request writes several files: give --out a folder.');
  const meta = await info(file);
  if (meta.encrypted) throw err('This PDF has a password: make a copy without it first (palm pdf password remove), then ask for signatures.', 1);
  if (meta.signing) throw err('This PDF is already a signing request. Open it at ' + SIGN_URL + ' to sign it, or check it with palm pdf sign check.', 1);
  const list = boxes ? checkBoxes(typeof boxes === 'string' ? JSON.parse(readFileSync(boxes, 'utf8')) : boxes, { pages: meta.sizes, signers: people.length }) : defaultBoxes(meta.sizes[meta.sizes.length - 1], people.length, meta.pages);
  for (let i = 0; i < people.length; i++) if (!list.some((b) => b.signer === i + 1 && (b.kind === 'signature' || b.kind === 'initials'))) throw err(`${people[i].name} has no signature or initials box.`);
  const rec = { dataUrl: 'data:application/pdf;base64,' + f.b64, name: f.name, request: { title: title || f.name.replace(/\.pdf$/i, ''), from: sender, signers: people, boxes: list.map((b) => ({ page: b.page - 1, x: b.x, y: b.y, w: b.w, h: b.h, kind: b.kind, who: b.signer - 1 })) } };
  const s = await session('tools', { rec });
  try {
    const p = s.page;
    await p.waitForFunction(() => (window.PDFT && PDFT.RQ.on && PDFT.SG.items.length) || /couldn.t/i.test(document.getElementById('status')?.textContent || ''), { timeout: 60000 });
    const opened = await p.evaluate(() => PDFT.RQ.on && PDFT.SG.items.filter((i) => i.type === 'slot').length);
    if (!opened) throw err('PDF Tools couldn’t open the PDF for signing.', 1);
    // "Get the file to send": the app's own sheet, filled in as the sender would
    const e = await p.evaluate(async (o) => {
      const s = document.getElementById('sgSave'); (s.offsetParent ? s : document.getElementById('sgDone')).click();
      // the sheet opens inside the page's "Saving" job: wait for that job to end, or "Make the file" is ignored as busy
      for (let i = 0; i < 200 && (!document.getElementById('rqOk') || PDFT.S.busy); i++) await new Promise((r) => setTimeout(r, 50));
      if (!document.getElementById('rqOk')) return document.getElementById('status')?.textContent || 'The send sheet didn’t open.';
      document.getElementById('rqTitle').value = o.title; document.getElementById('rqFrom').value = o.from.name; document.getElementById('rqFromE').value = o.from.email || '';
      const ord = document.getElementById('rqOrder'); if (ord) ord.checked = o.order;
      document.getElementById('rqOk').click();
      return document.getElementById('rqErr')?.textContent || '';
    }, { title: rec.request.title, from: sender, order });
    if (e) throw err('PDF Tools: ' + e, 1);
    try { await p.waitForFunction(() => window.__finished, { timeout: 120000 }); }
    catch (e) { throw err('PDF Tools didn’t make the file to send: ' + (await p.evaluate(() => [document.getElementById('status')?.textContent, document.getElementById('rqErr')?.textContent, document.getElementById('sgHelp')?.textContent].filter(Boolean).join(' / '))), 1); }
    const r = await p.evaluate(async () => {
      const res = window.__finished; if (!res || res === 'cancel') return { error: 'PDF Tools didn’t make the file.' };
      const toB64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); };
      const rec = res.fileId && window.__files.get(res.fileId), bytes = rec ? new Uint8Array(await rec.data.blob.arrayBuffer()) : Uint8Array.from(atob(res.dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
      const pj = await pdfjsLib.getDocument({ data: bytes.slice() }).promise, f = await PDFT.rqFind(pj);
      // boxes over the page's text (the default places are at the bottom of the last page; the user's may be anywhere)
      const covers = [], od = await pdfjsLib.getDocument({ data: f.orig.slice() }).promise;
      for (const b of f.packet.boxes) {
        const pg = await od.getPage(b.p + 1), vp = pg.getViewport({ scale: 1 }), tc = await pg.getTextContent();
        for (const it of tc.items) { if (!it.str.trim()) continue; const t = pdfjsLib.Util.transform(vp.transform, it.transform), fh = Math.hypot(t[2], t[3]) || 10, x = t[4], y = t[5] - fh * 0.84, w = it.width;
          if (x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + fh > b.y) { covers.push({ box: b.id, page: b.p + 1, text: it.str.slice(0, 40) }); break; } }
      }
      pj.destroy(); od.destroy();
      return { name: res.name, b64: toB64(bytes), orig: toB64(f.orig), packet: f.packet, ok: f.ok, covers, pages: [...new Set(f.packet.boxes.map((b) => b.p + 1))] };
    });
    if (r.error) throw err(r.error, 1);
    if (!r.ok) throw err('The file PDF Tools made failed its own fingerprint check, so it wasn’t saved.', 1);
    const pk = r.packet;
    mkdirSync(plan.dir, { recursive: true });
    const files = writeOut(plan, [{ name: r.name, b64: r.b64, pages: null }, { name: 'original.pdf', b64: r.orig, pages: meta.pages }]);
    const look = join(plan.dir, 'look.png');
    writeFileSync(look, Buffer.from(await p.evaluate(lookSheet, r.b64, r.pages, 'To sign:'), 'base64'));
    const first = pk.order === 'order' ? [pk.people[0]] : pk.people, drafts = [], notes = [];
    for (const P of first) {
      if (!P.email) { notes.push(`${P.name} has no email address: send them the file yourself.`); continue; }
      const m = askEmail(pk, P), dfile = join(plan.dir, `email-${P.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.eml`);
      writeFileSync(dfile, emlMixed({ to: P, from: pk.from, subject: m.subject, body: m.body, file: files[0].file, name: r.name }));
      drafts.push({ to: P.name, file: dfile });
    }
    if (pk.boxes.length < list.length) notes.push(`${list.length - pk.boxes.length} box(es) were dropped by PDF Tools (off the page or not valid).`);
    if (!boxes) notes.push('The boxes were placed at the bottom of the last page. If look.png shows them over text, give --boxes boxes.json with your own places and run again.');
    for (const c of r.covers) notes.push(`Box ${c.box} on page ${c.page} sits over the page's text ("${c.text}"): move it with --boxes.`);
    const m = { tool: 'palm pdf sign request', ok: true, inputs: inputsOf([f]), request: { id: pk.id, title: pk.title, from: pk.from, order: pk.order, sha256: pk.sha, people: pk.people.map((P) => ({ name: P.name, email: P.email, boxes: pk.boxes.filter((b) => b.s === P.id).map((b) => ({ page: b.p + 1, kind: { sig: 'signature', init: 'initials' }[b.t] || b.t, x: b.x, y: b.y, w: b.w, h: b.h })) })) },
      files, look, drafts, signAt: SIGN_URL, notes,
      next: `Send "${r.name}" to ${first.map((P) => P.name).join(' and ')}${pk.order === 'order' && pk.people.length > 1 ? ' first; each passes it on to the next' : ''}. They open it at ${SIGN_URL}, fill their boxes and Finish; the last copy gets a Signing record page. Check what comes back with: palm pdf sign check <signed.pdf> --original "${files[1].file}". The email drafts (.eml) are for the user to read and send: Palm sends nothing.` };
    return { ...m, manifest: manifest(plan.dir, m), out: plan.dir, lookHint: 'Open look.png: each signer\'s boxes as they will see them. Make sure none covers the document\'s text.' };
  } finally { await s.close(); }
}
export async function signCheck(file, { original, out, session: s } = {}) {
  const f = readInput(file), o = original ? readInput(original) : null;
  const r = await withTools((p) => p.evaluate((f, o) => PALM_PDF.check(f, o), f, o), { session: s });
  if (r.error) throw err(r.error, 1);
  const plan = outPlan(out);
  if (!r.request) {
    const m = { tool: 'palm pdf sign check', ok: false, inputs: inputsOf([f, ...(o ? [o] : [])]), request: false, reason: 'This PDF carries no Yuzool signing request (no yuzool-signing.json and original.pdf inside), so there is nothing to check it against.' };
    mkdirSync(plan.dir, { recursive: true }); return { ...m, manifest: manifest(plan.dir, m), out: plan.dir };
  }
  const problems = [];
  if (!r.fingerprintOk) problems.push('The original inside this copy doesn’t match the request’s fingerprint: it was changed after it was sent.');
  if (o && r.original && r.original.match === 'different') problems.push(r.original.detail);
  if (o && r.original && r.original.match === 'unreadable') problems.push(r.original.detail);
  if (!r.complete) problems.push('Still to sign: ' + r.waiting.join(', ') + '.');
  else if (!r.record) problems.push('Everyone has signed, but the Signing record page with the fingerprint is missing.');
  const m = { tool: 'palm pdf sign check', ok: !problems.length, inputs: inputsOf([f, ...(o ? [o] : [])]), ...r, problems };
  mkdirSync(plan.dir, { recursive: true });
  return { ...m, manifest: manifest(plan.dir, m), out: plan.dir };
}

// ---- Pro: checked against Palm once a day, cached. Only the Palm key goes to Palm, never a file. ----
export const pdfDir = () => join(configDir(), 'pdf');
export async function proOk({ check, now = Date.now() } = {}) {
  const f = join(pdfDir(), 'pro.json');
  try { const c = JSON.parse(readFileSync(f, 'utf8')); if (c.ok && now - c.at < 86400e3) return true; } catch {}
  const ok = !!(await check());
  mkdirSync(pdfDir(), { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify({ ok, at: now }), { mode: 0o600 });
  return ok;
}

// ---- text for people (the CLI and the MCP share it) ----
const kb = (n) => n == null ? '' : n < 1e6 ? (n / 1e3).toFixed(0) + ' KB' : (n / 1e6).toFixed(1) + ' MB';
export function summary(r) {
  const L = [];
  if (r.tool === 'palm pdf info') {
    if (r.opened === false || r.pages == null) return `${r.file}: ${kb(r.bytes)}, ${r.encrypted ? `encrypted (${r.security?.method || '?'}, revision ${r.security?.revision ?? '?'})` : 'not encrypted'}. ${r.note || ''}`.trim();
    L.push(`${r.file}: ${r.pages} page${r.pages > 1 ? 's' : ''}, ${kb(r.bytes)}${r.encrypted ? `, encrypted (${r.security.method}${r.security.needsPassword ? ', opened with the password' : ', limits only: opens without a password'})` : ', no password'}`);
    const sz = [...new Set(r.sizes.map((x) => `${Math.round(x.w)}×${Math.round(x.h)}${x.rotate ? ' turned ' + x.rotate + '°' : ''}`))];
    L.push(`  page size${sz.length > 1 ? 's' : ''}: ${sz.join(', ')} points`);
    L.push(`  text: ${r.hasText ? `${r.textPages} of ${r.pages} pages have a text layer` : 'none (a scan or pictures: nothing to search or redact by words)'}`);
    if (Object.keys(r.meta || {}).length) L.push(`  document info: ${Object.entries(r.meta).map(([k, v]) => `${k} "${v}"`).join(', ')}`);
    if (r.formFields) L.push(`  form fields: ${r.formFields}`);
    if (r.attachments?.length) L.push(`  attachments: ${r.attachments.join(', ')}`);
    if (r.signing) L.push(`  a Yuzool signing request: "${r.signing.title}" from ${r.signing.from}; ${r.signing.waiting.length ? 'still to sign: ' + r.signing.waiting.join(', ') : 'everyone has signed'}; fingerprint ${r.signing.fingerprintOk ? 'matches' : 'DOES NOT MATCH'}`);
    return L.join('\n');
  }
  if (r.tool === 'palm pdf redact') {
    if (!r.found) return `Nothing blacked out. ${r.reason}\nManifest: ${r.manifest}`;
    L.push(`${r.verified ? '✓' : '✗'} Found ${r.found} thing${r.found > 1 ? 's' : ''} to black out (${Object.entries(r.byKind).map(([k, n]) => `${n} ${k === 'term' ? 'of your words' : k}`).join(', ')}):`);
    for (const h of r.hits.slice(0, 40)) L.push(`    p${h.page} ${h.kind.padEnd(6)} …${h.before}[${h.masked}]${h.after}…`);
    if (r.hits.length > 40) L.push(`    … and ${r.hits.length - 40} more (manifest.json)`);
    const v = r.verification;
    if (r.verified) L.push(`✓ Verified as Redact checks it: the saved file was opened again and searched for the ${v.checkedWords} word${v.checkedWords === 1 ? '' : 's'} that were under the boxes (its text, its raw bytes, and what each rebuilt page still shows); none is there, and the same search finds nothing in it.`, `  Rebuilt as pictures: page${v.rebuiltPages.length > 1 ? 's' : ''} ${v.rebuiltPages.join(', ')}${v.keptPages.length ? `; kept as text: ${v.keptPages.join(', ')}` : ''}.${v.hiddenRemoved?.length ? ` Hidden data removed: ${v.hiddenRemoved.join(', ')}.` : ''}`, `File: ${r.files[0].file}`);
    else {
      L.push(`✗ NOT SAFE: ${r.reason}`);
      for (const x of v.stillFound) L.push(`    still found: ${x.masked}${x.pages.length ? ' on page ' + x.pages.join(', ') : ''}${x.inFile ? ' (in the file)' : ''}`);
      for (const x of v.foundAgain) L.push(`    found again: p${x.page} ${x.kind} ${x.masked}`);
      for (const x of v.rawBytes) L.push(`    in the raw bytes: ${x}`);
    }
    if (v.metadataStillSet?.length) L.push(`  note: still set in the document info: ${v.metadataStillSet.join(', ')}`);
    L.push(`Look: ${r.look}`, `Manifest: ${r.manifest}`); if (r.lookHint) L.push(r.lookHint);
    return L.join('\n');
  }
  if (r.tool === 'palm pdf sign request') {
    L.push(`✓ "${r.request.title}" ready to sign, ${r.request.order === 'order' ? 'one after another' : 'in any order'}:`);
    for (const P of r.request.people) L.push(`    ${P.name}${P.email ? ' <' + P.email + '>' : ''}: ${P.boxes.map((b) => `${b.kind} p${b.page}`).join(', ')}`);
    L.push(`File to send: ${r.files[0].file}`, `Original (fingerprinted, SHA-256 ${r.request.sha256.slice(0, 16)}…): ${r.files[1].file}`);
    if (r.drafts.length) L.push(`Email drafts (Palm sends nothing; open, read, attach-check and send yourself): ${r.drafts.map((d) => d.file).join(', ')}`);
    for (const n of r.notes) L.push('  note: ' + n);
    L.push(r.next, `Look: ${r.look}`, `Manifest: ${r.manifest}`, r.lookHint);
    return L.join('\n');
  }
  if (r.tool === 'palm pdf sign check') {
    if (!r.request) return `✗ ${r.reason}`;
    L.push(`${r.ok ? '✓' : '✗'} "${r.title}" from ${r.from.name}${r.from.email ? ' <' + r.from.email + '>' : ''} (request ${r.id})`);
    L.push(`  fingerprint of the original inside: ${r.fingerprintOk ? 'matches the request (SHA-256 ' + r.sha.slice(0, 16) + '…)' : 'DOES NOT MATCH: changed after it was sent'}`);
    if (r.original) L.push(`  the original you gave: ${r.original.match} — ${r.original.detail}`);
    for (const P of r.people) L.push(`  ${P.filled === P.boxes ? '✓' : '·'} ${P.name}: ${P.filled}/${P.boxes} boxes${P.signedAt ? ', signed ' + P.signedAt : ''}`);
    L.push(r.complete ? `  everyone has signed${r.record ? '; the Signing record page is there' : ''}` : `  still to sign: ${r.waiting.join(', ')}`);
    for (const p of r.problems) L.push('  ✗ ' + p);
    L.push('  (Like PDF Tools, this checks the document and who filled which boxes; it doesn\'t check who anyone is.)');
    return L.join('\n');
  }
  for (const f of r.files || []) L.push(`✓ ${f.file} (${f.pages != null ? f.pages + ' page' + (f.pages === 1 ? '' : 's') + ', ' : ''}${kb(f.bytes)})`);
  if (r.tool === 'palm pdf compress' && r.from) L.push(`  ${kb(r.from)} → ${kb(r.to)}`);
  if (r.checked) L.push(`  checked: opens with the password, not without (${r.checked.method || 'AES-256'})`);
  for (const n of r.notes || []) L.push('  note: ' + n);
  L.push(`Manifest: ${r.manifest}`);
  return L.join('\n');
}

export const HELP = `palm pdf: Palm's PDF desk. Yuzool PDF Tools' and Redact's own code runs here in your Chrome; your files never leave this machine.
  palm pdf info <in.pdf> [--password …]                       pages, sizes, text layer, password, form fields, attachments (free)
  palm pdf merge <a.pdf> <b.pdf|photo.jpg>… [--out merged.pdf] [--page-size fit|a4|letter]   (free)
  palm pdf extract <in.pdf> --pages 1-3,5 [--out x.pdf]        one PDF of those pages (free)
  palm pdf split <in.pdf> --pages 1-3,4-6 | --each [--out dir]  one PDF per range, or per page (free)
  palm pdf rotate <in.pdf> [--by 90|180|270] [--pages 2,4] [--out x.pdf]   (free)
  palm pdf compress <in.pdf> [--quality high|med|low] [--out x.pdf]        pages become pictures (free)
  palm pdf password add <in.pdf> [--no-print] [--no-copy] [--out x.pdf]    AES-256, checked after (free)
  palm pdf password remove <in.pdf> [--out x.pdf]              a copy with no password (free)
  palm pdf redact <in.pdf> --find emails,phones,… | --text "exact words" [--pages 1-2] [--style black|white|label] [--label "Personal data"] [--dpi 150|200|300] [--log] [--out dir]
                                                              Redact's rules; the saved file is verified, look.png to open (Pro)
  palm pdf sign request <in.pdf> --signer "Name <email>" [--signer …] --from "Your name <email>" [--title …] [--boxes boxes.json] [--any-order]
                                                              PDF Tools' Ask others to sign: they sign at yuzool.com/sign (Pro)
  palm pdf sign check <signed.pdf> [--original in.pdf]        who signed, fingerprint, record page (Pro)
Passwords: --password or PALM_PDF_PASSWORD (never printed). For password add it is the new one; --current opens a protected input.
--find kinds: ${RULE_IDS.join(', ')} (default = ${RULE_DEFAULT.join(', ')}; all). --out: a folder (default palm-pdf) or a .pdf name.
boxes.json: [{"page":1,"kind":"signature|initials|date|name|text|check","signer":1,"x":56,"y":700,"w":180,"h":44}] in points from the page's top left.
Every run writes manifest.json. Needs Chrome and puppeteer-core (palm doctor). Palm never sends email.`;

// The CLI: `palm pdf …` (bin/palm.mjs passes the words after "pdf"). Returns the exit code.
export async function cli(a, { print, fail, pro }) {
  const VAL = ['--out', '--pages', '--by', '--quality', '--password', '--current', '--find', '--text', '--style', '--signer', '--from', '--title', '--boxes', '--original', '--page-size', '--dpi', '--label'];
  const opt = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  const all = (n) => a.flatMap((x, i) => x === '--' + n && a[i + 1] != null ? [a[i + 1]] : []);
  const has = (n) => a.includes('--' + n);
  const pos = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && VAL.includes(a[i - 1])));
  const [sub, ...p] = pos;
  if (!sub || sub === 'help') { fail(HELP); return 2; }
  const run = async (f) => { try { return await f(); } catch (e) { fail(e.message, e.code || 4); return e.code || 4; } };
  const out = opt('out'), password = pw(opt('password'));
  const done = (r) => { if (!r || typeof r !== 'object') return r; print(summary(r), r); return r.ok ? 0 : 1; };
  const needPro = async (what) => { if (await pro()) return true; print(`${what} is part of Palm Pro (info, merge, extract, split, rotate, compress and passwords are free). Run \`palm login\` (or set PALM_KEY). About Pro: https://www.yuzool.com/palm/#pro`, { locked: true }); return false; };
  switch (sub) {
    case 'info': return done(await run(() => info(p[0], { password })));
    case 'merge': return done(await run(() => merge(p, { out, password, pageSize: opt('page-size', 'fit') })));
    case 'extract': return done(await run(() => extract(p[0], { pages: opt('pages'), out, password })));
    case 'split': return done(await run(() => split(p[0], { pages: opt('pages'), each: has('each'), out, password })));
    case 'rotate': return done(await run(() => rotate(p[0], { by: opt('by', 90), pages: opt('pages'), out, password })));
    case 'compress': return done(await run(() => compress(p[0], { quality: opt('quality', 'med'), out, password })));
    case 'password': {
      if (p[0] === 'add') return done(await run(() => protect(p[1], { password, current: opt('current') ?? null, print: !has('no-print'), copy: !has('no-copy'), out })));
      if (p[0] === 'remove') return done(await run(() => { if (!password) throw err('Give the password with --password or PALM_PDF_PASSWORD (it is never printed).'); return unprotect(p[1], { password, out }); }));
      fail(HELP); return 2;
    }
    case 'redact': {
      if (!(await needPro('Redacting'))) return 3;
      return done(await run(() => redact(p[0], { rules: opt('find') ? parseRules(all('find').join(',')) : [], terms: parseTerms(all('text')), pages: opt('pages'), style: opt('style', 'black'), dpi: opt('dpi', 200), log: has('log'), label: opt('label', 'Redacted'), out })));
    }
    case 'sign': {
      if (!['request', 'check'].includes(p[0])) { fail(HELP); return 2; }
      if (!(await needPro('Signing requests and checks'))) return 3;
      if (p[0] === 'request') return done(await run(() => signRequest(p[1], { signers: all('signer'), from: opt('from'), title: opt('title'), boxes: opt('boxes'), order: !has('any-order'), out })));
      return done(await run(() => signCheck(p[1], { original: opt('original'), out })));
    }
    default: fail(HELP); return 2;
  }
}
