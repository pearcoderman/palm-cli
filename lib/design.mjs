// Palm's image desk: a Quick Design design (JSON, a Quick Design link, or a filled template) made into the files a
// person posts. Runs on the user's machine in their own Chrome with Quick Design's own drawing, layout and video code
// (loaded from yuzool.com/quick-design/, so the pixels match what the person sees when they open the link). Nothing
// is sent to an AI; the design never goes to Palm's server (only the Palm key, once a day, for the Pro parts).
//
//   templates / fill / render  free
//   sizes   every platform size, laid out again (not stretched), checked: text under each app's buttons (safe zones),
//           text too small at the size people see it, words split, text off the page, overlaps, file-size limits
//   video   MP4 (or GIF) of the design's entrance animations, at a vertical size, checked the same way
//   batch   one design per CSV row (Quick Design's Make many), at the design's size or every --for size
// Every run writes manifest.json (files, sizes, alt text, issues) for a scheduler, and sheet.png to look at.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { configDir } from './client.mjs';
import { findChrome } from './doctor.mjs';

export const SITE = () => (process.env.PALM_DESIGN_BASE || 'https://www.yuzool.com').replace(/\/$/, '');
export const SIZES_CHECKED = '2026-11-23'; // from Palm's data pack design/platform-sizes (palm data design/platform-sizes)

// Zones: [x, y, w, h] in the target's pixels; level 'error' = the app's own buttons or text cover it, 'warn' = cropped
// somewhere (a grid thumbnail, a badge), 'ads' = only with --ads (Meta's and TikTok's ad guidance).
const band = (W, H, { top = 0, bottom = 0, left = 0, right = 0 }, level, why) => [
  top && { r: [0, 0, W, top], level, why: why + ' (top ' + top + ' px)' },
  bottom && { r: [0, H - bottom, W, bottom], level, why: why + ' (bottom ' + bottom + ' px)' },
  left && { r: [0, 0, left, H], level, why: why + ' (left ' + left + ' px)' },
  right && { r: [W - right, 0, right, H], level, why: why + ' (right ' + right + ' px)' },
].filter(Boolean);
const T = (label, w, h, o = {}) => ({ label, w, h, seen: 390, maxBytes: 8e6, zones: [], ...o });
export const TARGETS = {
  instagram: T('Instagram feed, 3:4', 1080, 1440, { note: 'Instagram\'s newest feed and grid shape.' }),
  'instagram-4x5': T('Instagram feed, 4:5', 1080, 1350, { zones: band(1080, 1350, { left: 34, right: 34 }, 'warn', 'cut off on the 3:4 profile grid') }),
  'instagram-square': T('Instagram feed, square', 1080, 1080, { zones: band(1080, 1080, { left: 135, right: 135 }, 'warn', 'cut off on the 3:4 profile grid') }),
  'instagram-story': T('Instagram story', 1080, 1920, { zones: [...band(1080, 1920, { top: 100, bottom: 200 }, 'error', 'under the story\'s name bar and reply box'), ...band(1080, 1920, { top: 269, bottom: 672, left: 65, right: 65 }, 'ads', 'outside Meta\'s ad safe zone')] }),
  reel: T('Instagram reel / cover', 1080, 1920, { zones: [...band(1080, 1920, { top: 210, bottom: 310, right: 84 }, 'error', 'under the Reels buttons and caption'), ...band(1080, 1920, { top: 269, bottom: 672, left: 65, right: 65 }, 'ads', 'outside Meta\'s ad safe zone')] }),
  tiktok: T('TikTok', 1080, 1920, { maxBytes: 20e6, zones: [...band(1080, 1920, { top: 108, bottom: 320, left: 60, right: 120 }, 'error', 'under TikTok\'s buttons and caption'), ...band(1080, 1920, { top: 240, bottom: 660, left: 120, right: 120 }, 'ads', 'outside TikTok\'s ad safe zone')] }),
  shorts: T('YouTube Shorts', 1080, 1920, { maxBytes: 50e6, zones: band(1080, 1920, { top: 120, bottom: 300, right: 96 }, 'error', 'under the Shorts buttons and title') }),
  facebook: T('Facebook feed', 1080, 1350, { maxBytes: 30e6 }),
  'facebook-story': T('Facebook story', 1080, 1920, { maxBytes: 30e6, zones: band(1080, 1920, { top: 269, bottom: 672, left: 65, right: 65 }, 'error', 'outside the 14% / 35% / 6% Facebook keeps free in stories') }),
  'facebook-reel': T('Facebook reel', 1080, 1920, { zones: band(1080, 1920, { top: 100, bottom: 300 }, 'error', 'under the Reels buttons and caption') }),
  linkedin: T('LinkedIn feed', 1080, 1350, { maxBytes: 5e6 }),
  'linkedin-link': T('LinkedIn link preview', 1200, 627, { seen: 360, maxBytes: 5e6 }),
  x: T('X post', 1600, 900, { seen: 360, maxBytes: 5e6 }),
  'x-card': T('X link card', 1200, 628, { seen: 360, maxBytes: 5e6, note: 'Some X apps lay the title over the image: keep text centred.' }),
  threads: T('Threads', 1080, 1350),
  bluesky: T('Bluesky', 1080, 1350, { maxBytes: 2e6 }),
  pinterest: T('Pinterest pin', 1000, 1500, { seen: 236, maxBytes: 20e6, note: 'Seen 236 px wide in the desktop feed (about 180 on a phone).' }),
  'youtube-thumbnail': T('YouTube thumbnail', 1280, 720, { seen: 360, maxBytes: 2e6, zones: [{ r: [1280 - 150, 720 - 80, 150, 80], level: 'warn', why: 'under the video\'s length badge (bottom right, approximate)' }] }),
  og: T('Link preview (og:image)', 1200, 630, { seen: 300, maxBytes: 8e6, note: 'iMessage, WhatsApp and Slack show it small or cropped: keep text in the centre. Keep it under ~300 KB for WhatsApp.' }),
};
export const PRESETS = {
  social: ['instagram', 'instagram-story', 'facebook', 'linkedin', 'x', 'threads', 'bluesky', 'pinterest'],
  vertical: ['instagram-story', 'reel', 'tiktok', 'shorts'],
  link: ['og', 'x-card', 'linkedin-link'],
  all: Object.keys(TARGETS),
};
export function parseTargets(list) {
  const ids = String(list || '').split(/[,\s]+/).filter(Boolean).flatMap((x) => PRESETS[x] || [x]);
  const bad = ids.filter((x) => !TARGETS[x]);
  if (bad.length) { const e = new Error(`Unknown size: ${bad.join(', ')}. Sizes: ${Object.keys(TARGETS).join(', ')}; or ${Object.keys(PRESETS).join(', ')}.`); e.code = 2; throw e; }
  return [...new Set(ids)];
}

// A design from a file path, '-' (stdin), a Quick Design link (#j= JSON, #d=z deflated), raw JSON text, or an object.
export function readDesign(src) {
  if (src && typeof src === 'object') return src.design || src;
  let s = String(src || '');
  if (s === '-') s = readFileSync(0, 'utf8');
  else if (!/^[\s{]|#[jd]=/.test(s) && existsSync(s)) s = readFileSync(s, 'utf8');
  s = s.trim();
  let m = s.match(/#d=z([A-Za-z0-9_-]+)/);
  if (m) return JSON.parse(inflateRawSync(Buffer.from(m[1], 'base64url')).toString('utf8'));
  m = s.match(/#j=(.+)$/s);
  if (m) { const p = m[1]; return JSON.parse(/^(%7B)/i.test(p) ? decodeURIComponent(p) : p[0] === '{' ? p : Buffer.from(p, 'base64url').toString('utf8')); }
  const j = JSON.parse(s);
  return j.design || j;
}
export const slug = (s) => String(s || 'design').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'design';
export const editLink = (doc) => SITE() + '/quick-design/#j=' + encodeURIComponent(JSON.stringify(doc));

// ---- templates (no browser) ----
let tplCache = null;
async function templatesJson(f = globalThis.fetch) {
  if (tplCache) return tplCache;
  const r = await f(SITE() + '/quick-design/templates.json');
  if (!r.ok) { const e = new Error('Quick Design templates unavailable (' + r.status + ')'); e.code = 4; throw e; }
  return (tplCache = await r.json());
}
export async function templates({ query = '', category = '', fetch: f } = {}) {
  const d = await templatesJson(f), q = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return d.templates.filter((t) => (!category || t.category === category) && q.every((w) => (t.name + ' ' + (t.keywords || '') + ' ' + t.category).toLowerCase().includes(w)))
    .map(({ doc, keywords, ...t }) => ({ ...t, fillable: !!doc }));
}
export async function fill(name, replacements = {}, { fetch: f } = {}) {
  const d = await templatesJson(f), n = String(name).toLowerCase();
  const t = d.templates.find((x) => x.name.toLowerCase() === n) || d.templates.find((x) => x.name.toLowerCase().includes(n));
  if (!t) { const e = new Error(`No template called "${name}". See: palm design templates`); e.code = 2; throw e; }
  if (!t.doc) { const e = new Error(`"${t.name}" is a Quick Design Pro template; only the free ones can be filled here.`); e.code = 2; throw e; }
  const doc = JSON.parse(JSON.stringify(t.doc)), unknown = [];
  for (const [k, v] of Object.entries(replacements)) {
    const m = /^p(\d+)e(\d+)$/.exec(k); let hit = false;
    if (m) { const e = doc.pages[+m[1] - 1]?.els[+m[2]]; if (e && e.t === 'text') { e.txt = String(v); hit = true; } }
    else for (const p of doc.pages) for (const e of p.els) if (e.t === 'text' && e.txt === k) { e.txt = String(v); hit = true; }
    if (!hit) unknown.push(k);
  }
  doc.name = replacements.name || t.name;
  return { design: doc, template: t.name, unknown, fields: t.fields };
}

// ---- the browser ----
function loadPuppeteer() {
  for (const base of [process.env.PALM_NODE_MODULES, process.cwd(), join(process.cwd(), 'palm')].filter(Boolean)) {
    try { return createRequire(join(base, 'x.js'))('puppeteer-core'); } catch { /* next */ }
  }
  const e = new Error('The image desk needs puppeteer-core in this folder: npm i puppeteer-core (or palm setup). Check with: palm doctor'); e.code = 4; throw e;
}

// Installed in the page once: Quick Design's modules and Palm's measuring. Runs in the browser.
async function install() {
  const F = await import('/quick-design/format.js'), R = await import('/quick-design/js/resize.js');
  const V = await import('/quick-design/js/video.js'), B = await import('/quick-design/js/bulk.js');
  const lists = (await (await fetch('/quick-design/templates.json')).json()).lists;
  const uid = () => Math.random().toString(36).slice(2, 9);
  const Q = { fitText: (e) => QD.fitText(e), layoutText: (e) => QD.layoutText(e), uid };
  const ids = (doc) => { doc.pages.forEach((p) => { p.id ||= uid(); p.els.forEach((e) => { e.id ||= uid(); }); }); return doc; };
  const ready = async (doc) => { await QD.docFonts(doc); await document.fonts.ready; doc.pages.forEach((p) => p.els.forEach((e) => { if (e.t === 'text' && !e.cv) QD.fitText(e); })); try { await QD.assetsReady(doc); } catch { /* empty photo frames */ } return doc; };
  const at = async (doc, w, h) => ready(doc.w === w && doc.h === h ? structuredClone(doc) : R.relayoutDoc(doc, w, h, Q));
  const blobB64 = (b) => new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.readAsDataURL(b); });
  const canvasOut = async (cv, maxBytes, photo) => {
    let type = 'png', d = cv.toDataURL('image/png');
    const bytes = (x) => Math.floor((x.length - x.indexOf(',') - 1) * 3 / 4);
    if (photo && bytes(d) > 1.5e6 || bytes(d) > maxBytes) for (const q of [0.92, 0.85, 0.75]) { d = cv.toDataURL('image/jpeg', q); type = 'jpg'; if (bytes(d) <= maxBytes) break; }
    return { type, b64: d.split(',')[1], bytes: bytes(d) };
  };
  // what's wrong with this design at this size, measured with Quick Design's own text layout
  const measure = (doc, t, ads) => {
    const issues = [], W = doc.w, H = doc.h, k = (t.seen || 390) / W;
    const hit = (a, r) => Math.max(0, Math.min(a.x + a.w, r[0] + r[2]) - Math.max(a.x, r[0])) * Math.max(0, Math.min(a.y + a.h, r[1] + r[3]) - Math.max(a.y, r[1]));
    doc.pages.forEach((p, pi) => {
      const texts = [];
      p.els.forEach((e) => {
        if (e.hid || !['text', 'qr'].includes(e.t)) return;
        const what = e.t === 'qr' ? 'the QR code' : '"' + String(e.txt).replace(/\s+/g, ' ').trim().slice(0, 40) + '"';
        const box = { x: e.x, y: e.y, w: e.w, h: e.h };
        if (e.x < -2 || e.y < -2 || e.x + e.w > W + 2 || e.y + e.h > H + 2) issues.push({ page: pi + 1, level: 'error', rule: 'off-page', msg: `${what} runs off the page.` });
        for (const z of t.zones || []) {
          if (z.level === 'ads' && !ads) continue;
          if (hit(box, z.r) > 0.04 * box.w * box.h) issues.push({ page: pi + 1, level: z.level === 'ads' ? 'error' : z.level, rule: 'safe-zone', msg: `${what} is ${z.why}.` });
        }
        if (e.t !== 'text') return;
        texts.push({ e, what, box });
        const L = QD.layoutText(e), lines = L.lines.map((l) => l.s);
        const words = String(e.up ? String(e.txt).toUpperCase() : e.txt).split(/\s+/).filter((w) => w.length > 1);
        const broken = words.filter((w) => !lines.some((l) => l.split(/\s+/).includes(w)));
        if (broken.length) issues.push({ page: pi + 1, level: 'error', rule: 'word-break', msg: `"${broken.slice(0, 3).join('", "')}" is split across lines in ${what}.` });
        const px = e.fs * k;
        if (px < 7) issues.push({ page: pi + 1, level: 'error', rule: 'too-small', msg: `${what} is ${px.toFixed(1)} px where people see it (${t.seen || 390} px wide): unreadable. Make it bigger or cut it.` });
        else if (px < 9.5) issues.push({ page: pi + 1, level: 'warn', rule: 'small', msg: `${what} is ${px.toFixed(1)} px where people see it (${t.seen || 390} px wide).` });
      });
      // overlapping boxes are normal (line spacing); what matters is letters drawn over letters, so compare ink
      const ink = new Map(), mk = 0.25, cw = Math.ceil(W * mk), ch = Math.ceil(H * mk);
      const inkOf = (e) => {
        if (!ink.has(e)) {
          const c = QD.renderToCanvas({ ...p, bg: 'rgba(0,0,0,0)', els: [{ ...e, an: null }] }, doc, mk, { export: true });
          const d = c.getContext('2d').getImageData(0, 0, cw, ch).data, m = new Uint8Array(cw * ch);
          let n = 0; for (let i = 0; i < m.length; i++) if (d[i * 4 + 3] > 90) { m[i] = 1; n++; }
          ink.set(e, { m, n });
        }
        return ink.get(e);
      };
      for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i].box, b = texts[j].box;
        if (!hit(a, [b.x, b.y, b.w, b.h])) continue;
        const A = inkOf(texts[i].e), Bk = inkOf(texts[j].e);
        let both = 0; for (let q = 0; q < A.m.length; q++) both += A.m[q] & Bk.m[q];
        const share = both / Math.max(1, Math.min(A.n, Bk.n));
        if (share > 0.15) issues.push({ page: pi + 1, level: 'error', rule: 'overlap', msg: `${texts[i].what} and ${texts[j].what} are drawn over each other (${Math.round(share * 100)}% of the smaller one's letters).` });
        else if (share > 0.02) issues.push({ page: pi + 1, level: 'warn', rule: 'touch', msg: `${texts[i].what} touches ${texts[j].what} (${Math.round(share * 100)}% of the letters): fine if it's meant to be layered.` });
      }
    });
    return issues;
  };
  // page 1 at the size people see it, safe zones shaded, for the contact sheet
  const seenCanvas = (doc, t, ads) => {
    const sw = Math.round((t.seen || 390) * 2), k = sw / doc.w, c = QD.renderToCanvas(doc.pages[0], doc, k, { export: true });
    const x = c.getContext('2d'); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1;
    for (const z of t.zones || []) { if (z.level === 'ads' && !ads) continue; x.fillStyle = z.level === 'warn' ? 'rgba(255,170,0,.28)' : 'rgba(255,0,60,.28)'; x.fillRect(z.r[0] * k, z.r[1] * k, z.r[2] * k, z.r[3] * k); }
    return c;
  };
  const altText = (doc) => doc.pages.map((p) => p.els.filter((e) => e.t === 'text' && !e.hid).sort((a, b) => a.y - b.y || a.x - b.x).map((e) => String(e.txt).replace(/\s+/g, ' ').trim()).join(' · ')).filter(Boolean);
  window.PALM_QD = {
    async prepare(input) {
      const s = F.sanitize(input, lists);
      if (!s.doc) return { errors: s.errors, warnings: s.warnings };
      const doc = await ready(ids(s.doc));
      return { doc, warnings: s.warnings };
    },
    async still(doc, t, o = {}) {
      const d = await at(doc, t.w, t.h), photo = d.pages.some((p) => p.els.some((e) => e.t === 'img' && e.src));
      const pages = [];
      for (const p of d.pages) pages.push(await canvasOut(QD.renderToCanvas(p, d, 1, { export: true }), t.maxBytes || 8e6, photo));
      const sc = seenCanvas(d, t, o.ads);
      return { pages, issues: measure(d, t, o.ads), seen: { w: sc.width, h: sc.height, b64: sc.toDataURL('image/png').split(',')[1] }, alt: altText(d), w: d.w, h: d.h };
    },
    async video(doc, t, o = {}) {
      const d = await at(doc, t.w, t.h);
      const blob = o.gif ? await V.makeGIF(QD, d, { hold: o.hold || 3, long: 600 }) : await V.makeVideo(QD, d, { hold: o.hold || 3, long: Math.max(t.w, t.h) });
      const cover = await canvasOut(QD.renderToCanvas(d.pages[0], d, 1, { export: true }), t.maxBytes || 8e6, false);
      const sc = seenCanvas(d, t, o.ads);
      return { ext: blob.ext, b64: await blobB64(blob), bytes: blob.size, seconds: V.timeline(d, d.pages.map((p, i) => i), o.hold || 3).total, cover, issues: measure(d, t, o.ads), seen: { w: sc.width, h: sc.height, b64: sc.toDataURL('image/png').split(',')[1] }, alt: altText(d), w: d.w, h: d.h };
    },
    rows(doc, csv) {
      const P = B.parse(csv), out = [];
      const maps = doc.pages.map((p) => B.mapFor(p.els, P.cols));
      const C = P.cols.map((c) => c.trim().toLowerCase()), norm = (x) => String(x || '').trim().toLowerCase();
      const fills = [];
      doc.pages.forEach((p, i) => p.els.forEach((e) => {
        const how = maps[i][e.id]; if (how == null || how === -1) return;
        const exact = (e.t === 'text' || e.t === 'qr') && ([...String(e.t === 'qr' ? e.v : e.txt).matchAll(/\{([^{}]+)\}/g)].some((m) => C.includes(norm(m[1]))) || C.includes(norm(e.bk)) || C.includes(norm(e.txt)));
        fills.push({ page: i + 1, text: String(e.t === 'qr' ? 'QR ' + e.v : e.txt).replace(/\s+/g, ' ').slice(0, 40), from: typeof how === 'number' ? P.cols[how] : how === 'ph1' ? P.cols[0] : '{placeholders}', guessed: !exact });
      }));
      if (!fills.length) return { error: `Nothing in the design can take the rows. Put {${P.cols[0]}} in a text box, or make a text box's text "${P.cols[0]}".` };
      for (const row of P.rows) out.push({ ...doc, id: uid(), name: row[0] || doc.name, pages: doc.pages.map((p, i) => B.fillPage(Q, p, maps[i], row, P.cols)) });
      return { cols: P.cols, more: P.more, docs: out, fills, guessed: fills.some((f) => f.guessed) };
    },
    sheet(items) { // [{label, w, h, b64}] → one PNG, side by side, labelled
      return Promise.all(items.map((it) => new Promise((ok) => { const im = new Image(); im.onload = () => ok(im); im.src = 'data:image/png;base64,' + it.b64; }))).then((ims) => {
        const gap = 28, top = 34, H = Math.max(...ims.map((i) => i.height)) + top, Wt = ims.reduce((s, i) => s + i.width + gap, gap);
        const c = document.createElement('canvas'); c.width = Math.min(Wt, 16000); c.height = H + gap; const x = c.getContext('2d');
        x.fillStyle = '#e9e9ee'; x.fillRect(0, 0, c.width, c.height); x.font = '600 20px -apple-system, Segoe UI, sans-serif'; x.fillStyle = '#222';
        let px = gap; ims.forEach((im, i) => { x.fillText(items[i].label, px, 24); x.drawImage(im, px, top); px += im.width + gap; });
        return c.toDataURL('image/png').split(',')[1];
      });
    },
  };
  return true;
}

export async function open({ base = SITE() } = {}) {
  const puppeteer = loadPuppeteer(), chrome = findChrome();
  if (!chrome) { const e = new Error('No Chrome, Edge or Chromium found. Install one or set PALM_CHROME (palm doctor).'); e.code = 4; throw e; }
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', timeout: 90000, protocolTimeout: 600000, args: ['--no-first-run', '--no-default-browser-check'] });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (r) => (/tinylytics|googletagmanager|\/api\/yuzool\//.test(r.url()) ? r.abort() : r.continue()));
    await page.setViewport({ width: 800, height: 600 });
    await page.goto(base + '/quick-design/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.QD && typeof QD.renderToCanvas === 'function' && typeof QD.layoutText === 'function', { timeout: 30000 });
    await page.evaluate(install);
    return { page, close: () => browser.close() };
  } catch (e) { await browser.close(); throw e; }
}

const write = (f, b64) => { writeFileSync(f, Buffer.from(b64, 'base64')); return resolve(f); };
async function prepared(s, design) {
  const r = await s.page.evaluate((d) => PALM_QD.prepare(d), design);
  if (!r.doc) { const e = new Error('Quick Design could not read the design: ' + (r.errors || []).join('; ')); e.code = 1; throw e; }
  return r;
}
const own = (doc) => ({ label: 'As designed', w: doc.w, h: doc.h, seen: 390, maxBytes: 8e6, zones: [] });

function finish(out, base, entries, doc, warnings) {
  const issues = entries.flatMap((x) => x.issues.map((i) => ({ target: x.target, ...i })));
  const errors = issues.filter((i) => i.level === 'error').length;
  const manifest = { made: new Date().toISOString(), tool: 'palm design', design: doc.name, sizesChecked: SIZES_CHECKED, link: editLink(doc), ok: errors === 0, errors, warnings: issues.length - errors, files: entries, designWarnings: warnings || [] };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { ...manifest, out: resolve(out), manifest: resolve(join(out, 'manifest.json')), sheet: base.sheet, look: 'Open sheet.png before you finish: every size at the width people see it, with the zones that apps cover shaded red (amber: cropped in places). Fix every error, then run again.' };
}

// one design, one or more sizes (no targets: its own size)
export async function stills(design, { targets = [], out = 'palm-design', ads = false, session } = {}) {
  const s = session || await open();
  try {
    const { doc, warnings } = await prepared(s, design);
    mkdirSync(out, { recursive: true });
    const name = slug(doc.name), entries = [], seen = [];
    for (const id of targets.length ? targets : [null]) {
      const t = id ? TARGETS[id] : own(doc);
      const r = await s.page.evaluate((d, t, o) => PALM_QD.still(d, t, o), doc, t, { ads });
      const dir = id ? join(out, id) : out; mkdirSync(dir, { recursive: true });
      const files = r.pages.map((p, i) => ({ file: write(join(dir, `${name}${r.pages.length > 1 ? '-' + (i + 1) : ''}.${p.type}`), p.b64), bytes: p.bytes, format: p.type, overLimit: p.bytes > t.maxBytes }));
      const issues = [...r.issues, ...files.filter((f) => f.overLimit).map((f) => ({ page: 0, level: 'error', rule: 'file-size', msg: `${f.file.split('/').pop()} is ${(f.bytes / 1e6).toFixed(1)} MB; ${t.label} takes up to ${(t.maxBytes / 1e6).toFixed(1)} MB.` }))];
      entries.push({ target: id || 'design', label: t.label, w: r.w, h: r.h, files, alt: r.alt, note: t.note, issues });
      seen.push({ label: `${t.label} ${r.w}×${r.h}${issues.some((i) => i.level === 'error') ? '  ✗' : ''}`, b64: r.seen.b64 });
    }
    const sheet = write(join(out, 'sheet.png'), await s.page.evaluate((x) => PALM_QD.sheet(x), seen));
    return finish(out, { sheet }, entries, doc, warnings);
  } finally { if (!session) await s.close(); }
}

export async function video(design, { targets = ['reel'], out = 'palm-design', hold = 3, gif = false, ads = false, session } = {}) {
  const s = session || await open();
  try {
    const { doc, warnings } = await prepared(s, design);
    mkdirSync(out, { recursive: true });
    const name = slug(doc.name), entries = [], seen = [];
    for (const id of targets) {
      const t = TARGETS[id];
      const r = await s.page.evaluate((d, t, o) => PALM_QD.video(d, t, o), doc, t, { hold, gif, ads });
      const dir = join(out, id); mkdirSync(dir, { recursive: true });
      const files = [{ file: write(join(dir, `${name}.${r.ext}`), r.b64), bytes: r.bytes, format: r.ext, seconds: +r.seconds.toFixed(2) },
        { file: write(join(dir, `${name}-cover.${r.cover.type}`), r.cover.b64), bytes: r.cover.bytes, format: r.cover.type, cover: true }];
      const issues = [...r.issues];
      if (!doc.pages.some((p) => p.els.some((e) => e.an))) issues.push({ page: 0, level: 'warn', rule: 'no-animation', msg: 'Nothing in the design is animated, so the video is a still. Give elements an entrance (an: rise, fade, pop, slide, wipe, spin or type).' });
      if (r.ext !== 'mp4' && !gif) issues.push({ page: 0, level: 'warn', rule: 'format', msg: `This Chrome made ${r.ext.toUpperCase()}, not MP4.` });
      entries.push({ target: id, label: t.label, w: r.w, h: r.h, files, alt: r.alt, note: t.note, issues });
      seen.push({ label: `${t.label} ${r.w}×${r.h}${issues.some((i) => i.level === 'error') ? '  ✗' : ''}`, b64: r.seen.b64 });
    }
    const sheet = write(join(out, 'sheet.png'), await s.page.evaluate((x) => PALM_QD.sheet(x), seen));
    return finish(out, { sheet }, entries, doc, warnings);
  } finally { if (!session) await s.close(); }
}

export async function batch(design, csv, { targets = [], out = 'palm-design', ads = false, limit = 200, session } = {}) {
  const s = session || await open();
  try {
    const { doc, warnings } = await prepared(s, design);
    const r = await s.page.evaluate((d, c) => PALM_QD.rows(d, c), doc, csv);
    if (r.error) { const e = new Error(r.error); e.code = 1; throw e; }
    const docs = r.docs.slice(0, limit), all = [], sheets = [];
    mkdirSync(out, { recursive: true });
    for (let i = 0; i < docs.length; i++) {
      const sub = join(out, String(i + 1).padStart(3, '0') + '-' + slug(docs[i].name));
      const one = await stills(docs[i], { targets, out: sub, ads, session: s });
      all.push({ row: i + 1, name: docs[i].name, out: one.out, ok: one.ok, files: one.files });
      sheets.push(one.sheet);
    }
    const errors = all.reduce((n, x) => n + x.files.reduce((m, f) => m + f.issues.filter((i) => i.level === 'error').length, 0), 0);
    const manifest = { made: new Date().toISOString(), tool: 'palm design batch', design: doc.name, columns: r.cols, rows: all.length, fills: r.fills, guessed: r.guessed, skipped: Math.max(0, r.docs.length - docs.length) + (r.more || 0), ok: errors === 0, errors, items: all, designWarnings: warnings };
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { ...manifest, out: resolve(out), manifest: resolve(join(out, 'manifest.json')), sheets, look: 'Open a few rows\' sheet.png (the longest names first): a long value is where a batch breaks.' };
  } finally { if (!session) await s.close(); }
}

// ---- Pro: checked against Palm once a day, cached. Only the Palm key goes to Palm, never the design. ----
export const designDir = () => join(configDir(), 'design');
export async function proOk({ check, now = Date.now() } = {}) {
  const f = join(designDir(), 'pro.json');
  try { const c = JSON.parse(readFileSync(f, 'utf8')); if (c.ok && now - c.at < 86400e3) return true; } catch {}
  const ok = !!(await check());
  mkdirSync(designDir(), { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify({ ok, at: now }), { mode: 0o600 });
  return ok;
}

// Text for people (the CLI and the MCP share it).
export function summary(r) {
  if (r.items) return `${r.rows} designs from ${r.columns.length} columns → ${r.out}${r.skipped ? ` (${r.skipped} rows skipped)` : ''}\n${r.fills.map((f) => `  ${f.from} → "${f.text}"${f.guessed ? '  (guessed: no column or {placeholder} matched, so the first column fills the biggest text)' : ''}`).join('\n')}\n${r.ok ? 'No errors.' : r.errors + ' errors: see each row\'s manifest.json.'}\n${r.items.map((x) => `  ${x.ok ? '✓' : '✗'} ${String(x.row).padStart(3)} ${x.name}`).join('\n')}\nManifest: ${r.manifest}\n${r.look}`;
  const L = [];
  for (const f of r.files) {
    L.push(`${f.issues.some((i) => i.level === 'error') ? '✗' : '✓'} ${f.label} ${f.w}×${f.h}: ${f.files.map((x) => `${x.file} (${x.format}, ${(x.bytes / 1e3).toFixed(0)} KB${x.seconds ? ', ' + x.seconds + ' s' : ''})`).join(', ')}`);
    for (const i of f.issues) L.push(`    ${i.level}${i.page ? ' p' + i.page : ''}: ${i.msg}`);
    if (f.note) L.push(`    note: ${f.note}`);
  }
  L.push('', r.ok ? 'No errors.' : `${r.errors} error(s), ${r.warnings} warning(s).`, `Sheet: ${r.sheet}`, `Manifest: ${r.manifest}`, `Edit in Quick Design: ${r.link.length > 140 ? r.link.slice(0, 120) + '… (full link in manifest.json)' : r.link}`, r.look);
  return L.join('\n');
}
