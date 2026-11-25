// Palm's invoice desk: an agent makes an invoice that a client can open and pay, keeps a ledger of what's owed, and
// drafts polite reminders when it's late. Runs on the user's machine. The invoice opens in Yuzool Invoice's viewer
// (yuzool.com/invoice/#v=…: the invoice travels inside the link, nothing is stored on a server); the PDF is that same
// page printed by the user's Chrome. Palm never sends email: reminders are .eml drafts the user opens and sends from
// their own mail app. The ledger stays on this machine (~/.config/palm/invoice/ledger.json, or --ledger).
//   make   free · list, paid, chase: Palm Pro (checked once a day)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { configDir } from './client.mjs';
import { findChrome } from './doctor.mjs';

export const SITE = () => (process.env.PALM_INVOICE_BASE || 'https://www.yuzool.com').replace(/\/$/, '');
export const CURRENCIES = ['GBP', 'USD', 'EUR', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'JPY', 'CNY', 'HKD', 'SGD', 'INR', 'ZAR', 'AED', 'ILS', 'TRY', 'BRL', 'MXN'];
// Email header values: no control characters (a newline in a name or subject would start a new header, e.g. a Bcc),
// and non-ASCII as RFC 2047 encoded words so every mail app shows "Café" right.
export const hval = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
export const henc = (s) => { const v = hval(s); return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`; };
export const hname = (name, email) => { const n = hval(name).replace(/["\\]/g, ''); const e = hval(email).replace(/[<>\s]/g, ''); return n ? `${/^[\x20-\x7e]*$/.test(n) ? `"${n}"` : henc(n)} <${e}>` : (e ? `<${e}>` : ''); };
const err = (m, code = 2) => Object.assign(new Error(m), { code });

// ---- money, exactly as Invoice does it (src/invoice/index.html: digits, toMinor, totals) ----
export const digits = (c) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
export const toMinor = (v, c) => Math.round((+v || 0) * 10 ** digits(c));
export const toMajor = (m, c) => (+m || 0) / 10 ** digits(c);
export const fmt = (m, c) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(toMajor(m, c));
const lineAmt = (l) => Math.round((+l.qty || 0) * (+l.unit || 0));
const discOf = (d, sub) => { if (!(sub > 0)) return 0; const p = +d.discountPct || 0, a = Math.round(+d.discountAmt || 0); return Math.min(sub, Math.max(0, p > 0 ? Math.round(sub * Math.min(100, p) / 100) : a)); };
const lineRate = (l, d) => { const v = l && l.taxRate; return Math.max(0, Math.min(100, v != null && v !== '' && !isNaN(+v) ? +v : (+d.taxRate || 0))); };
function spread(n, w) {
  const W = w.reduce((a, x) => a + x, 0), out = w.map(() => 0); if (!n || !(W > 0)) return out;
  const N = BigInt(n), BW = BigInt(W), rem = []; let left = n;
  w.forEach((x, i) => { const p = N * BigInt(x); out[i] = Number(p / BW); rem.push(p % BW); left -= out[i]; });
  w.map((_, i) => i).sort((a, b) => (rem[b] > rem[a] ? 1 : rem[b] < rem[a] ? -1 : a - b)).slice(0, left).forEach((i) => out[i]++);
  return out;
}
const pctOf = (n, r) => { const x = n * r / 100; return (x < 0 ? -1 : 1) * Math.round(Math.abs(x) + 1e-9); };
export function totals(d) {
  const sub = (d.lines || []).reduce((a, l) => a + lineAmt(l), 0), disc = discOf(d, sub);
  if (d.taxMode !== 'line') { const tax = Math.round((sub - disc) * (+d.taxRate || 0) / 100); return { sub, disc, tax, total: sub - disc + tax }; }
  const lines = d.lines || [], amts = lines.map(lineAmt), sh = spread(disc, amts.map((a) => Math.max(0, a))), g = new Map();
  lines.forEach((l, i) => { const k = lineRate(l, d); g.set(k, (g.get(k) || 0) + amts[i] - sh[i]); });
  const groups = [...g].sort((a, b) => b[0] - a[0]).map(([rate, net]) => ({ rate, net, tax: pctOf(net, rate) })), tax = groups.reduce((a, x) => a + x.tax, 0);
  return { sub, disc, tax, total: sub - disc + tax, groups };
}

// ---- dates (plain YYYY-MM-DD, compared as days) ----
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }; // the user's local day, as Invoice's TODAY()
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3);
const nice = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

// ---- the ledger ----
export const ledgerPath = (p) => resolve(p || process.env.PALM_INVOICE_LEDGER || join(configDir(), 'invoice', 'ledger.json'));
export function loadLedger(p) { try { return JSON.parse(readFileSync(ledgerPath(p), 'utf8')); } catch { return { invoices: [] }; } }
export function saveLedger(L, p) { const f = ledgerPath(p); mkdirSync(dirname(f), { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify(L, null, 2) + '\n', { mode: 0o600 }); return f; }
export function nextNumber(L, prefix = 'INV-') {
  let max = 0; for (const r of L.invoices) { const n = String(r.number); if (n.startsWith(prefix)) { const v = parseInt(n.slice(prefix.length), 10); if (v > max) max = v; } }
  return prefix + String(max + 1).padStart(4, '0');
}

// What an agent writes. Prices in normal money (450 or 450.50), not minor units.
//   { number?, issued?, due? | terms? (days), currency, from:{name, address, email, phone, taxId, payLink, payNote},
//     to:{name, address, email, taxId}, lines:[{desc, qty, price, taxRate?}], taxRate?, taxName?, taxMode?, discountPct?, discount?, notes? }
export function normalise(input, { ledger = { invoices: [] }, now = today() } = {}) {
  const x = typeof input === 'string' ? JSON.parse(input) : input, problems = [], notes = [];
  const c = String(x.currency || '').toUpperCase();
  if (!CURRENCIES.includes(c)) problems.push(`currency "${x.currency || ''}" isn't one Invoice handles (${CURRENCIES.join(', ')}).`);
  const dg = digits(c || 'USD');
  if (!x.from?.name) problems.push('from.name (your business name) is missing.');
  if (!x.to?.name) problems.push('to.name (the client) is missing.');
  if (!Array.isArray(x.lines) || !x.lines.length) problems.push('lines is empty.');
  const lines = (x.lines || []).map((l, i) => {
    const price = l.price ?? l.rate ?? l.unitPrice, qty = l.qty ?? l.quantity ?? 1;
    if (!String(l.desc || l.description || '').trim()) problems.push(`line ${i + 1} has no description.`);
    if (!Number.isFinite(+price)) problems.push(`line ${i + 1}: price "${price}" isn't a number.`);
    if (!(+qty > 0)) problems.push(`line ${i + 1}: qty must be above 0.`);
    if (Number.isFinite(+price) && Math.abs(+price * 10 ** dg - Math.round(+price * 10 ** dg)) > 1e-6) problems.push(`line ${i + 1}: ${price} has more decimals than ${c} uses (${dg}).`);
    const o = { desc: String(l.desc || l.description || '').trim(), qty: +qty, unit: toMinor(price, c) };
    if (l.taxRate != null) o.taxRate = +l.taxRate;
    return o;
  });
  const issued = x.issued || now;
  if (!ISO.test(issued) || isNaN(Date.parse(issued + 'T00:00:00Z'))) problems.push(`issued "${issued}" must be a real date as YYYY-MM-DD.`);
  const okIssued = ISO.test(issued) && !isNaN(Date.parse(issued + 'T00:00:00Z'));
  let due = x.due || (okIssued && Number.isFinite(+x.terms) && x.terms !== '' && x.terms != null ? addDays(issued, +x.terms) : '');
  if (!due && okIssued) { due = addDays(issued, 14); notes.push('No due date or terms given: due in 14 days.'); }
  if (due && (!ISO.test(due) || isNaN(Date.parse(due + 'T00:00:00Z')))) problems.push(`due "${due}" must be a real date as YYYY-MM-DD.`);
  else if (ISO.test(issued) && due < issued) problems.push(`due ${due} is before issued ${issued}.`);
  const number = String(x.number || nextNumber(ledger, x.prefix || 'INV-'));
  if (ledger.invoices.some((r) => r.number === number && r.client !== x.to?.name)) problems.push(`invoice number ${number} is already used in the ledger (for ${ledger.invoices.find((r) => r.number === number).client}).`);
  // Invoice prints its tax name only in per-line mode ("VAT 20% on £635.85"); with one rate the total is the same.
  const tm = x.taxMode === 'line' || x.taxName || lines.some((l) => l.taxRate != null) ? 'line' : undefined;
  const pay = String(x.from?.payLink || x.payLink || '').trim();
  if (!pay) notes.push('No payment link (from.payLink, e.g. a Stripe payment link or PayPal.me): the client sees the invoice but no Pay button.');
  else if (!/^https:\/\//i.test(pay)) notes.push(`The payment link "${pay}" isn't https://.`);
  if (!x.to?.email) notes.push('No client email (to.email): reminders will need an address filled in.');
  if (+x.taxRate && !x.taxName) notes.push(`Tax is shown as "Tax (${+x.taxRate}%)"; set taxName (e.g. "VAT", "GST") to show that word.`);
  const d = { number, issued, due, currency: c, lines, taxRate: +x.taxRate || 0, taxMode: tm, taxName: x.taxName, discountPct: +x.discountPct || 0, discountAmt: x.discount != null ? toMinor(x.discount, c) : 0, notes: x.notes || '', payNote: x.from?.payNote || '', payLink: pay, status: 'sent', qr: true };
  Object.keys(d).forEach((k) => d[k] === undefined && delete d[k]);
  return { problems, notes, data: d, from: x.from || {}, to: x.to || {}, totals: problems.length ? null : totals(d) };
}

// The view link: Invoice's viewer payload {k:"i", b, c, i}, deflated ("z" + base64url), as shareInv() makes it.
export function viewLink({ data: d, from: b, to: c }) {
  const v = { k: 'i', b: { name: b.name, address: b.address, email: b.email, phone: b.phone, taxId: b.taxId, payNote: b.payNote, payLink: d.payLink }, c: { name: c.name, address: c.address, email: c.email, taxId: c.taxId },
    i: { number: d.number, issued: d.issued, due: d.due, currency: d.currency, lines: d.lines, taxRate: d.taxRate, taxMode: d.taxMode, taxName: d.taxName, discountPct: d.discountPct, discountAmt: d.discountAmt, notes: d.notes, payNote: d.payNote, payLink: d.payLink, status: d.status, qr: d.qr } };
  return SITE() + '/invoice/#v=z' + deflateRawSync(Buffer.from(JSON.stringify(v))).toString('base64url');
}

// The pay link with the amount filled in where the service takes one (Invoice's payUrl: PayPal.me, Monzo.me in GBP).
export function payUrl(link, total, c) {
  let u = String(link || '').trim(); if (!u) return ''; if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const v = String(+toMajor(total, c).toFixed(digits(c)));
  if (/paypal\.me\/[^/]+\/?$/i.test(u)) u = u.replace(/\/$/, '') + '/' + v + c; else if (/monzo\.me\/[^/]+\/?$/i.test(u) && c === 'GBP') u = u.replace(/\/$/, '') + '/' + v;
  return u;
}

// ---- emails (drafts only) ----
const eml = ({ to, from, subject, body }) => [`To: ${hname('', to)}`, ...(from ? [`From: ${hname('', from)}`] : []), `Subject: ${henc(subject)}`, 'X-Unsent: 1', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', body, ''].join('\r\n');
const sign = (b) => [b.name, b.email, b.phone].filter(Boolean).join('\n');
export const STAGES = [
  { id: 'before', at: -3, label: 'a friendly heads-up 3 days before it\'s due' },
  { id: 'due', at: 0, label: 'on the due date' },
  { id: 'late7', at: 7, label: '7 days late' },
  { id: 'late14', at: 14, label: '14 days late' },
  { id: 'final', at: 30, label: '30 days late, the last reminder' },
];
export function emailFor(r, stage, now = today()) {
  const amt = fmt(r.total, r.currency), first = String(r.clientContact || r.client).split(/\s+/)[0], late = Math.max(0, daysBetween(r.due, now));
  const pay = r.payLink ? `\n\nYou can pay here: ${payUrl(r.payLink, r.total, r.currency)}` : '';
  const view = `\n\nThe invoice: ${r.link}`;
  const T = {
    send: [`Invoice ${r.number} from ${r.from.name}: ${amt}`, `Hi ${first},\n\nHere's invoice ${r.number} for ${amt}, due on ${nice(r.due)}.${view}${pay}\n\nThank you,\n${sign(r.from)}`],
    before: [`Invoice ${r.number} is due on ${nice(r.due)}`, `Hi ${first},\n\nA quick note that invoice ${r.number} for ${amt} is due on ${nice(r.due)}. If it's already on its way, thank you, and please ignore this.${view}${pay}\n\nBest,\n${sign(r.from)}`],
    due: late ? [`Invoice ${r.number} was due on ${nice(r.due)}`, `Hi ${first},\n\nA quick note that invoice ${r.number} for ${amt} was due on ${nice(r.due)}. If you've already paid, thank you, and please ignore this.${view}${pay}\n\nBest,\n${sign(r.from)}`]
      : [`Invoice ${r.number} is due today`, `Hi ${first},\n\nInvoice ${r.number} for ${amt} is due today. If you've already paid, thank you, and please ignore this.${view}${pay}\n\nBest,\n${sign(r.from)}`],
    late7: [`Invoice ${r.number}: ${amt}, now overdue`, `Hi ${first},\n\nI haven't seen payment for invoice ${r.number} (${amt}, due ${nice(r.due)}) yet. Could you check it's with the right person? If there's a problem with it, just reply and I'll sort it out.${view}${pay}\n\nThanks,\n${sign(r.from)}`],
    late14: [`Invoice ${r.number}: ${amt}, two weeks overdue`, `Hi ${first},\n\nInvoice ${r.number} for ${amt} was due on ${nice(r.due)} and is now ${late} days overdue. Could you let me know when it will be paid?${view}${pay}\n\nThanks,\n${sign(r.from)}`],
    final: [`Invoice ${r.number}: final reminder`, `Hi ${first},\n\nInvoice ${r.number} for ${amt} is now ${late} days overdue (due ${nice(r.due)}), and I've written about it before. Please pay it this week, or reply to agree a date.${view}${pay}\n\nRegards,\n${sign(r.from)}`],
  }[stage];
  const mailto = `mailto:${encodeURIComponent(r.clientEmail || '')}?subject=${encodeURIComponent(T[0])}&body=${encodeURIComponent(T[1])}`;
  return { subject: T[0], body: T[1], mailto, eml: eml({ to: r.clientEmail, from: r.from.email, subject: T[0], body: T[1] }) };
}

// ---- the browser: the client's view, printed to PDF ----
function loadPuppeteer() {
  for (const base of [process.env.PALM_NODE_MODULES, process.cwd(), join(process.cwd(), 'palm')].filter(Boolean)) { try { return createRequire(join(base, 'x.js'))('puppeteer-core'); } catch { /* next */ } }
  return null;
}
export async function pdfOf(link, file) {
  const puppeteer = loadPuppeteer(), chrome = findChrome();
  if (!puppeteer || !chrome) return { skipped: !puppeteer ? 'puppeteer-core is not installed here (npm i puppeteer-core), so no PDF; the link works without it.' : 'No Chrome found, so no PDF; the link works without it.' };
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-first-run', '--lang=en-US'] });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (r) => (/tinylytics|googletagmanager|\/api\/yuzool\//.test(r.url()) ? r.abort() : r.continue()));
    await page.goto(link, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForSelector('#viewer .paperwrap .paper', { timeout: 30000 });
    const shown = await page.evaluate(() => {
      const top = document.querySelector('#viewer p.mut')?.textContent || '';
      const wrap = document.querySelector('#viewer .paperwrap');
      document.body.replaceChildren(wrap); document.body.style.cssText = 'margin:0;background:#fff';
      wrap.style.cssText = 'margin:0;padding:0;box-shadow:none'; return top;
    });
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({ path: file, format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } });
    return { file: resolve(file), shown };
  } finally { await browser.close(); }
}

// ---- commands ----
export async function make(input, { out = 'palm-invoices', ledger: lp, record = true, pdf = true, now = today(), status = 'sent', extra = {} } = {}) {
  const L = loadLedger(lp), n = normalise(input, { ledger: L, now });
  if (n.problems.length) throw err('The invoice needs fixing:\n- ' + n.problems.join('\n- '), 1);
  const link = viewLink(n), t = n.totals, dir = join(out, n.data.number.replace(/[^\w.-]+/g, '-'));
  mkdirSync(dir, { recursive: true });
  const r = { number: n.data.number, client: n.to.name, clientEmail: n.to.email || '', clientContact: n.to.contact || '', from: { name: n.from.name, email: n.from.email || '', phone: n.from.phone || '' }, currency: n.data.currency, total: t.total, issued: n.data.issued, due: n.data.due, payLink: n.data.payLink, link, status, paidAt: null, chased: {}, ...extra };
  let p = { skipped: 'not asked for' };
  if (pdf) p = await pdfOf(link, join(dir, `${r.number}.pdf`));
  if (p.file && !p.shown) throw err('Invoice\'s viewer page has changed (no total line found), so Palm can\'t confirm the total. Not recorded; please report this.', 4);
  if (p.shown && !p.shown.includes(fmt(t.total, r.currency))) throw err(`The viewer shows "${p.shown}" but Palm worked out ${fmt(t.total, r.currency)}. Not recorded; please report this.`, 1);
  const send = emailFor(r, 'send'), sendFile = join(dir, `${r.number}-send.eml`);
  writeFileSync(sendFile, send.eml); writeFileSync(join(dir, 'invoice.json'), JSON.stringify({ ...n.data, from: n.from, to: n.to }, null, 2) + '\n');
  if (record) { const i = L.invoices.findIndex((x) => x.number === r.number); if (i >= 0) L.invoices[i] = { ...L.invoices[i], ...r, chased: L.invoices[i].chased }; else L.invoices.push(r); saveLedger(L, lp); }
  return { number: r.number, client: r.client, total: fmt(t.total, r.currency), subtotal: fmt(t.sub, r.currency), discount: t.disc ? fmt(t.disc, r.currency) : null, tax: t.tax ? fmt(t.tax, r.currency) : null, issued: r.issued, due: r.due, link, pdf: p.file || null, pdfNote: p.skipped || null, viewerShows: p.shown || null, email: resolve(sendFile), mailto: send.mailto, notes: n.notes, ledger: record ? ledgerPath(lp) : null };
}

export function list({ ledger: lp, now = today() } = {}) {
  const L = loadLedger(lp), rows = L.invoices.map((r) => ({ ...r, state: r.paidAt ? 'paid' : r.status === 'draft' ? 'draft' : r.due < now ? 'overdue' : 'open', late: r.paidAt || r.status === 'draft' ? 0 : Math.max(0, daysBetween(r.due, now)) }));
  const owed = {}; for (const r of rows) if (r.state !== 'paid' && r.state !== 'draft') owed[r.currency] = (owed[r.currency] || 0) + r.total;
  const proposals = (L.proposals || []).map((r) => ({ number: r.number, title: r.title, client: r.client, total: fmt(r.total, r.currency), status: r.status === 'sent' && r.valid && now > r.valid ? 'expired' : r.status, issued: r.issued, valid: r.valid, invoices: r.invoices || [] }));
  return { rows, proposals, owed: Object.fromEntries(Object.entries(owed).map(([c, m]) => [c, fmt(m, c)])), overdue: rows.filter((r) => r.state === 'overdue').length };
}

export function paid(number, { date = today(), ledger: lp } = {}) {
  const L = loadLedger(lp), r = L.invoices.find((x) => x.number === number);
  if (!r) throw err(`No invoice ${number} in the ledger.`, 1);
  r.paidAt = date; r.status = 'paid'; saveLedger(L, lp); return r;
}

// Which reminder each unpaid invoice is due for today (the latest stage reached that hasn't been drafted), written as
// .eml drafts. A stage is recorded as drafted, never as sent: the user sends it.
export function chase({ out = 'palm-invoices', ledger: lp, now = today(), dry = false } = {}) {
  const L = loadLedger(lp), drafts = [];
  for (const r of L.invoices) {
    if (r.paidAt || r.status === 'draft') continue;
    const d = daysBetween(r.due, now);
    const reached = STAGES.filter((s) => d >= s.at && !(s.id === 'before' && daysBetween(r.issued, r.due) < 5));
    const stage = reached[reached.length - 1];
    if (!stage || r.chased?.[stage.id]) continue;
    const e = emailFor(r, stage.id, now), file = join(out, 'chase', `${r.number}-${stage.id}.eml`);
    if (!dry) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, e.eml); r.chased = { ...(r.chased || {}), [stage.id]: now }; }
    drafts.push({ number: r.number, client: r.client, to: r.clientEmail || '(no email in the ledger)', stage: stage.id, why: stage.label, subject: e.subject, file: dry ? null : resolve(file), mailto: e.mailto, body: e.body });
  }
  // proposals not yet answered: a nudge 5 days after sending, and a note 3 days before it expires (each once)
  for (const r of L.proposals || []) {
    if (r.status !== 'sent' || (r.valid && now > r.valid)) continue;
    const since = daysBetween(r.issued, now), left = r.valid ? daysBetween(now, r.valid) : 99;
    const stage = r.valid && left <= 3 && daysBetween(r.issued, r.valid) >= 10 ? 'p-expiring' : since >= 5 ? 'p-nudge' : null;
    if (!stage || r.chased?.[stage]) continue;
    const first = String(r.clientContact || r.client).split(/\s+/)[0], amt = fmt(r.total, r.currency), who = [r.from.name, r.from.email, r.from.phone].filter(Boolean).join('\n');
    const [subject, body] = stage === 'p-nudge'
      ? [`Proposal: ${r.title}`, `Hi ${first},\n\nJust checking the proposal for ${r.title} (${amt}) reached you. If you have any questions, or would like anything changed, I'm happy to help.\n\n${r.link}\n\nThanks,\n${who}`]
      : [`Proposal: ${r.title}, valid until ${nice(r.valid)}`, `Hi ${first},\n\nA quick note that the proposal for ${r.title} (${amt}) is valid until ${nice(r.valid)}. If you'd like to go ahead, you can accept it here:\n\n${r.link}\n\nIf the timing isn't right, just let me know.\n\nThanks,\n${who}`];
    const file = join(out, 'chase', `${r.number}-${stage}.eml`);
    if (!dry) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, eml({ to: r.clientEmail, from: r.from.email, subject, body })); r.chased = { ...(r.chased || {}), [stage]: now }; }
    drafts.push({ number: r.number, client: r.client, to: r.clientEmail || '(no email in the ledger)', stage, why: stage === 'p-nudge' ? 'no answer 5 days after the proposal' : 'the proposal expires in 3 days', subject, file: dry ? null : resolve(file), mailto: `mailto:${encodeURIComponent(r.clientEmail || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, body });
  }
  if (!dry && drafts.length) saveLedger(L, lp);
  return { drafts, dry, note: drafts.length ? 'Drafts only, nothing was sent: open each .eml (Outlook opens it as a new message) or its mailto link (a new message in the default mail app), read it, and send it yourself.' : 'Nothing to chase today.' };
}

// ---- Pro: checked against Palm once a day, cached. Only the Palm key goes to Palm, never the invoices. ----
export async function proOk({ check, now = Date.now() } = {}) {
  const dir = join(configDir(), 'invoice'), f = join(dir, 'pro.json');
  try { const c = JSON.parse(readFileSync(f, 'utf8')); if (c.ok && now - c.at < 86400e3) return true; } catch {}
  const ok = !!(await check());
  mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify({ ok, at: now }), { mode: 0o600 });
  return ok;
}
export const exists = existsSync;

// ---- every morning: `palm invoice schedule` ----
// macOS: a LaunchAgent that runs `palm invoice chase --notify` at the hour given (drafts only, a notification when
// there are some). Elsewhere: the line to add to cron / Task Scheduler, printed, not installed.
export const AGENT = 'com.yuzool.palm.invoice-chase';
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function scheduleCommand({ node = process.execPath, bin = process.argv[1], out, ledger } = {}) {
  // run through npx when this copy lives in npx's throwaway cache
  const viaNpx = /[\\/]_npx[\\/]/.test(String(bin));
  const base = viaNpx ? [join(dirname(node), 'npx'), '-y', 'github:pearcoderman/palm-cli'] : [node, bin];
  return [...base, 'invoice', 'chase', '--notify', '--out', resolve(out || 'palm-invoices'), ...(ledger ? ['--ledger', resolve(ledger)] : [])];
}
export function plist({ hour = 9, minute = 0, weekday, label = AGENT, args, path = process.env.PATH, log, config = process.env.XDG_CONFIG_HOME }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path || '/usr/bin:/bin')}</string>${config ? `<key>XDG_CONFIG_HOME</key><string>${xml(config)}</string>` : ''}</dict>
  <key>StartCalendarInterval</key><dict>${weekday != null ? `<key>Weekday</key><integer>${weekday}</integer>` : ''}<key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}
export function cronLine({ hour = 9, minute = 0, args }) {
  const q = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return `${minute} ${hour} * * * ${args.map(q).join(' ')}`;
}
// A notification on macOS when there are drafts (osascript; arguments passed safely, never through a shell).
export function notifyArgs(drafts) {
  const n = drafts.length, s = `${n} reminder draft${n > 1 ? 's' : ''} ready: ${drafts.map((d) => d.number).join(', ')}`;
  return ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Palm invoices"', '-e', 'end run', s];
}

// A draft invoice (a later payment of an accepted proposal) goes out: it becomes 'sent' and is chased from now on.
export function send(number, { ledger: lp, now = today() } = {}) {
  const L = loadLedger(lp), r = L.invoices.find((x) => x.number === number);
  if (!r) throw err(`No invoice ${number} in the ledger.`, 1);
  if (r.status === 'draft') { r.status = 'sent'; r.sentAt = now; saveLedger(L, lp); }
  return { ...r, email: emailFor(r, 'send', now) };
}

// ---- proposals: Invoice's proposal pages, opened from a view link ({k:"p"}), then the payment schedule's invoices ----
const pid = () => Math.random().toString(36).slice(2, 9);
export function proposalTotals(d) { // YZProposal.priceTotals
  const ch = new Set(d.chosen || []); let req = 0, opt = 0, picked = 0;
  for (const l of d.lines || []) { const a = lineAmt(l); if (l.optional) { opt += a; if (ch.has(l.id)) picked += a; } else req += a; }
  const sub = req + picked, tax = Math.round(sub * (+d.taxRate || 0) / 100);
  return { req, opt, picked, sub, tax, total: sub + tax };
}
function split(total, pcts) { // YZProposal.split: parts add up exactly
  const w = pcts.map((p) => Math.max(0, +p || 0)), W = w.reduce((a, b) => a + b, 0);
  if (!(W > 0)) return pcts.map((_, i) => (i === 0 ? total : 0));
  const raw = w.map((x) => total * x / W), out = raw.map(Math.floor); let left = total - out.reduce((a, b) => a + b, 0);
  raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, left).forEach(([, i]) => out[i]++);
  return out;
}
export function payments(d, signedOn) { // YZProposal.payments
  const sch = (d.schedule || []).filter((x) => +x.pct > 0), t = proposalTotals(d), pc = sch.map((x) => x.pct), amts = split(t.total, pc), nets = split(t.sub, pc);
  const ms = new Map((d.milestones || []).map((m) => [m.id, m]));
  return sch.map((x, i) => { const m = x.milestoneId ? ms.get(x.milestoneId) : null; return { id: x.id, label: x.label || (m ? m.title : 'Payment'), pct: +x.pct, amount: amts[i], net: nets[i], due: m ? m.date || '' : signedOn || '', milestone: m ? m.title : '', onSigning: !m }; });
}

//   { number?, issued?, valid? | validDays? (30), currency, title, subtitle?, letter?, theme?, from:{name, contact, email, phone, address},
//     to:{name, contact, email, address}, sections:[{h, text}], milestones:[{title, date | days}], lines:[{desc, qty, price, optional?, note?}],
//     taxRate?, schedule:[{label, pct, at: "sign" | milestone number (1-based) | milestone title}], terms? (true), clauses?, jurisdiction? }
export const THEMES = ['indigo', 'forest', 'coral', 'ink', 'gold', 'plum'];
export function normaliseProposal(input, { ledger = { invoices: [] }, now = today() } = {}) {
  const x = typeof input === 'string' ? JSON.parse(input) : input, problems = [], notes = [];
  const c = String(x.currency || '').toUpperCase();
  if (!CURRENCIES.includes(c)) problems.push(`currency "${x.currency || ''}" isn't one Invoice handles.`);
  const dg = digits(c || 'USD');
  if (!x.title) problems.push('title is missing (the proposal\'s name, e.g. "Brand identity").');
  if (!x.from?.name) problems.push('from.name is missing.');
  if (!x.to?.name) problems.push('to.name is missing.');
  const issued = x.issued || now;
  if (!ISO.test(issued) || isNaN(Date.parse(issued + 'T00:00:00Z'))) problems.push(`issued "${issued}" must be a real date as YYYY-MM-DD.`);
  const okDate = (v) => ISO.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z'));
  const valid = x.valid || (okDate(issued) ? addDays(issued, Number.isFinite(+x.validDays) && x.validDays != null ? +x.validDays : 30) : '');
  if (valid && !okDate(valid)) problems.push(`valid "${valid}" must be YYYY-MM-DD.`);
  const milestones = (x.milestones || []).map((m, i) => {
    const date = m.date || (okDate(issued) && Number.isFinite(+m.days) && m.days != null ? addDays(issued, +m.days) : '');
    if (!String(m.title || '').trim()) problems.push(`milestone ${i + 1} has no title.`);
    if (date && !okDate(date)) problems.push(`milestone ${i + 1}: date "${date}" must be YYYY-MM-DD.`);
    if (!date) notes.push(`Milestone "${m.title}" has no date (date, or days after the proposal).`);
    return { id: pid(), title: String(m.title || '').trim(), date };
  });
  if (!Array.isArray(x.lines) || !x.lines.length) problems.push('lines is empty.');
  const lines = (x.lines || []).map((l, i) => {
    const price = l.price ?? l.rate, qty = l.qty ?? 1;
    if (!String(l.desc || '').trim()) problems.push(`line ${i + 1} has no description.`);
    if (!Number.isFinite(+price)) problems.push(`line ${i + 1}: price "${price}" isn't a number.`);
    if (!(+qty > 0)) problems.push(`line ${i + 1}: qty must be above 0.`);
    if (Number.isFinite(+price) && Math.abs(+price * 10 ** dg - Math.round(+price * 10 ** dg)) > 1e-6) problems.push(`line ${i + 1}: ${price} has more decimals than ${c} uses (${dg}).`);
    return { id: pid(), desc: String(l.desc || '').trim(), qty: +qty, unit: toMinor(price, c), optional: !!l.optional, ...(l.note ? { note: String(l.note) } : {}) };
  });
  if (lines.length && lines.every((l) => l.optional)) problems.push('every line is optional, so the total is nothing until the client picks.');
  const schedule = (x.schedule || [{ label: 'On signing', pct: 100, at: 'sign' }]).map((p, i) => {
    let mid = '';
    if (p.at != null && p.at !== 'sign' && p.at !== '') {
      const m = typeof p.at === 'number' ? milestones[p.at - 1] : milestones.find((q) => q.title.toLowerCase() === String(p.at).toLowerCase());
      if (!m) problems.push(`payment ${i + 1} ("${p.label || ''}") is at "${p.at}", which isn't a milestone (use "sign", a milestone's number from 1, or its title).`); else mid = m.id;
    }
    return { id: pid(), label: String(p.label || (mid ? milestones.find((m) => m.id === mid).title : 'On signing')), pct: +p.pct || 0, milestoneId: mid };
  });
  const sum = schedule.reduce((a, p) => a + p.pct, 0);
  if (Math.abs(sum - 100) > 1e-9) problems.push(`the payment schedule adds up to ${sum}%, not 100%.`);
  const number = String(x.number || nextProposal(ledger));
  if ((ledger.proposals || []).some((r) => r.number === number && r.client !== x.to?.name)) problems.push(`proposal number ${number} is already used (for ${(ledger.proposals || []).find((r) => r.number === number).client}).`);
  if (x.theme && !THEMES.includes(x.theme)) notes.push(`theme "${x.theme}" isn't one of ${THEMES.join(', ')}; using indigo.`);
  if (!x.from?.email) notes.push('No from.email: the client\'s page has no "Accept by email" button.');
  if (!x.to?.email) notes.push('No client email (to.email): the email draft needs an address filled in.');
  if (x.terms !== false && !x.jurisdiction) notes.push('The terms say "governed by the laws of [jurisdiction]": set jurisdiction (e.g. "England and Wales"), or terms: false to leave the terms out.');
  const d = { kind: 'proposal', template: 'custom', number, title: String(x.title || ''), subtitle: String(x.subtitle || ''), letter: String(x.letter || ''), theme: THEMES.includes(x.theme) ? x.theme : undefined,
    sections: (x.sections || []).map((q) => ({ id: pid(), h: String(q.h || q.heading || ''), text: String(q.text || '') })), milestones, lines, chosen: [], taxRate: +x.taxRate || 0, currency: c,
    schedule, terms: x.terms !== false, clauses: x.clauses, jurisdiction: x.jurisdiction, valid, issued };
  Object.keys(d).forEach((k) => d[k] === undefined && delete d[k]);
  return { problems, notes, data: d, from: x.from || {}, to: x.to || {}, totals: problems.length ? null : proposalTotals(d) };
}
export function nextProposal(L, prefix = 'P-') {
  let max = 0; for (const r of L.proposals || []) { const n = String(r.number); if (n.startsWith(prefix)) { const v = parseInt(n.slice(prefix.length), 10); if (v > max) max = v; } }
  return prefix + String(max + 1).padStart(4, '0');
}
export function proposalLink({ data: d, from: b, to: c }) {
  const v = { k: 'p', b: { name: b.name, contact: b.contact, address: b.address, email: b.email, phone: b.phone }, c: { name: c.name, contact: c.contact, address: c.address, email: c.email }, p: d };
  return SITE() + '/invoice/#v=z' + deflateRawSync(Buffer.from(JSON.stringify(v))).toString('base64url');
}
async function proposalPdf(link, file) {
  const puppeteer = loadPuppeteer(), chrome = findChrome();
  if (!puppeteer || !chrome) return { skipped: !puppeteer ? 'puppeteer-core is not installed here (npm i puppeteer-core), so no PDF; the link works without it.' : 'No Chrome found, so no PDF; the link works without it.' };
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-first-run', '--lang=en-US'] });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (r) => (/tinylytics|googletagmanager|\/api\/yuzool\//.test(r.url()) ? r.abort() : r.continue()));
    await page.setViewport({ width: 794, height: 1123 });
    await page.goto(link, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForSelector('#viewer .ppw .pp', { timeout: 30000 });
    const r = await page.evaluate(() => {
      const top = document.querySelector('#viewer p.mut')?.textContent || '', ppw = document.querySelector('#viewer .ppw'), n = ppw.querySelectorAll('.pp').length;
      const st = document.createElement('style'); st.textContent = '@page{size:794px 1123px;margin:0}html,body{margin:0;padding:0;background:#fff}.ppw{display:block!important;margin:0!important;max-width:none!important;width:794px}.pp{width:794px!important;border-radius:0!important;box-shadow:none!important;border:0!important;break-after:page}';
      document.head.appendChild(st); document.body.replaceChildren(ppw); return { top, n };
    });
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({ path: file, width: '794px', height: '1123px', printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
    return { file: resolve(file), shown: r.top, pages: r.n };
  } finally { await browser.close(); }
}
export async function makeProposal(input, { out = 'palm-invoices', ledger: lp, record = true, pdf = true, now = today() } = {}) {
  const L = loadLedger(lp), n = normaliseProposal(input, { ledger: L, now });
  if (n.problems.length) throw err('The proposal needs fixing:\n- ' + n.problems.join('\n- '), 1);
  const link = proposalLink(n), t = n.totals, d = n.data, dir = join(out, d.number.replace(/[^\w.-]+/g, '-'));
  mkdirSync(dir, { recursive: true });
  let p = { skipped: 'not asked for' };
  if (pdf) p = await proposalPdf(link, join(dir, `${d.number}.pdf`));
  if (p.file && !p.shown) throw err('Invoice\'s viewer page has changed (no total line found), so Palm can\'t confirm the total. Not recorded; please report this.', 4);
  if (p.shown && !p.shown.includes(fmt(t.total, d.currency))) throw err(`The viewer shows "${p.shown}" but Palm worked out ${fmt(t.total, d.currency)}. Not recorded; please report this.`, 1);
  const first = String(n.to.contact || n.to.name).split(/\s+/)[0], amt = fmt(t.total, d.currency);
  const subject = `Proposal: ${d.title}`, body = `Hi ${first},\n\nHere's my proposal for ${d.title}: ${amt}${t.opt ? ` (plus options you can choose from)` : ''}${d.valid ? `, valid until ${nice(d.valid)}` : ''}.\n\n${link}\n\nYou can accept it from that page, or sign the PDF's last page and send it back. Any questions, just reply.\n\nThanks,\n${[n.from.contact || n.from.name, n.from.name !== n.from.contact ? n.from.contact ? n.from.name : '' : '', n.from.email, n.from.phone].filter(Boolean).join('\n')}`;
  const sendFile = join(dir, `${d.number}-send.eml`);
  writeFileSync(sendFile, eml({ to: n.to.email, from: n.from.email, subject, body }));
  writeFileSync(join(dir, 'proposal.json'), JSON.stringify({ ...d, from: n.from, to: n.to }, null, 2) + '\n');
  if (record) {
    L.proposals ||= [];
    const r = { number: d.number, title: d.title, client: n.to.name, clientEmail: n.to.email || '', clientContact: n.to.contact || '', from: { name: n.from.name, email: n.from.email || '', phone: n.from.phone || '', payLink: n.from.payLink || '' }, currency: d.currency, total: t.total, issued: d.issued, valid: d.valid, link, status: 'sent', data: d, invoices: [] };
    const i = L.proposals.findIndex((x) => x.number === r.number); if (i >= 0) L.proposals[i] = r; else L.proposals.push(r);
    saveLedger(L, lp);
  }
  return { number: d.number, title: d.title, client: n.to.name, total: amt, options: t.opt ? fmt(t.opt, d.currency) : null, tax: t.tax ? fmt(t.tax, d.currency) : null, valid: d.valid,
    payments: payments(d, '').map((x) => ({ label: x.label, pct: x.pct, amount: fmt(x.amount, d.currency), when: x.milestone ? `${x.milestone}${x.due ? ' · ' + x.due : ''}` : 'on signing' })),
    link, pdf: p.file || null, pages: p.pages || null, pdfNote: p.skipped || null, viewerShows: p.shown || null, email: resolve(sendFile), mailto: `mailto:${encodeURIComponent(n.to.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, notes: n.notes, ledger: record ? ledgerPath(lp) : null };
}

// The client said yes: the proposal is accepted (with the options they chose) and its payment schedule becomes
// invoices, as Invoice's "Draft the invoices" does. The on-signing payment goes out now; the rest wait as drafts
// until `palm invoice send` (they are never chased while drafts).
export async function acceptProposal(number, { chosen = [], date = today(), out = 'palm-invoices', ledger: lp, pdf = false, terms = 14 } = {}) {
  const L = loadLedger(lp), r = (L.proposals || []).find((x) => x.number === number);
  if (!r) throw err(`No proposal ${number} in the ledger.`, 1);
  if (r.status === 'accepted') throw err(`${number} was already accepted on ${r.acceptedAt}; its invoices: ${r.invoices.join(', ') || 'none'}.`, 1);
  // An acceptance that stopped partway (a PDF timed out, the disk filled) resumes: same options and date, and every
  // payment that already has its invoice keeps it, so a retry never bills a payment twice.
  const resuming = r.status === 'accepting';
  if (resuming) { chosen = []; date = r.acceptedAt; }
  const opts = r.data.lines.filter((l) => l.optional), want = chosen.map((s) => String(s).toLowerCase()), picked = resuming ? [...(r.chosen || [])] : [];
  for (const w of want) { const l = opts.find((o) => o.desc.toLowerCase() === w) || opts.find((o) => o.desc.toLowerCase().includes(w)); if (!l) throw err(`"${w}" isn't one of the options: ${opts.map((o) => o.desc).join('; ') || 'there are none'}.`, 2); picked.push(l.id); }
  if (!resuming) { Object.assign(r, { status: 'accepting', acceptedAt: date, chosen: picked }); saveLedger(L, lp); }
  const d = { ...r.data, chosen: picked }, pays = payments(d, date), made = [];
  for (const p of pays) {
    const have = loadLedger(lp).invoices.find((i) => i.proposal === r.number && i.payId === p.id);
    if (have) { made.push({ number: have.number, total: fmt(have.total, have.currency), due: have.due, label: p.label, status: have.status, milestone: p.milestone || null, email: null, resumed: true }); continue; }
    const due = p.due && p.due > date ? p.due : addDays(date, terms);
    // The client saw each payment's amount with tax (p.amount, the exact split of the total). Invoice's tax is
    // round(net × rate), so net + tax can land a penny off; pick the net within a few pence that lands exactly.
    const rate = +d.taxRate || 0, gross = (n) => n + Math.round(n * rate / 100);
    // When no net lands exactly (some rates skip a total), the nearest lower one plus a zero-rated rounding line.
    let net = p.net, fix = 0; if (gross(net) !== p.amount) {
      const k = [1, -1, 2, -2, 3, -3].find((k) => gross(p.net + k) === p.amount);
      if (k != null) net = p.net + k; else { while (gross(net) > p.amount) net--; fix = p.amount - gross(net); }
    }
    const main = { desc: `${p.label} (${p.pct}%): ${d.title}`, qty: 1, price: toMajor(net, d.currency), ...(fix ? { taxRate: rate } : {}) };
    const inv = { currency: d.currency, issued: date, due, from: { ...r.from }, to: { name: r.client, contact: r.clientContact, email: r.clientEmail }, lines: fix ? [main, { desc: 'Rounding (to match the proposal)', qty: 1, price: toMajor(fix, d.currency), taxRate: 0 }] : [main], taxRate: d.taxRate, notes: `Ref. proposal ${r.number}.` };
    const x = await make(inv, { out, ledger: lp, pdf, now: date, status: p.onSigning ? 'sent' : 'draft', extra: { proposal: r.number, payId: p.id } });
    made.push({ ...x, label: p.label, status: p.onSigning ? 'sent' : 'draft', milestone: p.milestone || null });
  }
  const L2 = loadLedger(lp), r2 = L2.proposals.find((x) => x.number === number);
  Object.assign(r2, { status: 'accepted', acceptedAt: date, chosen: picked, total: proposalTotals(d).total, invoices: made.map((m) => m.number) }); r2.data.chosen = picked;
  saveLedger(L2, lp);
  return { number, total: fmt(proposalTotals(d).total, d.currency), invoices: made, resumed: resuming };
}
export function declineProposal(number, { date = today(), ledger: lp } = {}) {
  const L = loadLedger(lp), r = (L.proposals || []).find((x) => x.number === number);
  if (!r) throw err(`No proposal ${number} in the ledger.`, 1);
  r.status = 'declined'; r.declinedAt = date; saveLedger(L, lp); return r;
}
