// Palm's outreach desk: personal email sequences an agent runs for the user, drafts only. Contacts come in with the
// basis for writing to them (consent, customer, or legitimate interest, recorded per contact); a sequence is a few
// short emails days apart; each day `today` drafts the emails that are due, at most the daily cap, as .eml files and
// mailto links the user reads and sends from their own mailbox. Anyone who replied, unsubscribed or bounced is never
// written to again (a suppression list that outlives lists and sequences). Palm never sends email.
// State on this machine: ~/.config/palm/outreach/state.json (or --state / PALM_OUTREACH_STATE).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { configDir } from './client.mjs';

// Email header values: no control characters (a newline in a name or subject would start a new header, e.g. a Bcc),
// and non-ASCII as RFC 2047 encoded words so every mail app shows "Café" right.
export const hval = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
export const henc = (s) => { const v = hval(s); return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`; };
export const hname = (name, email) => { const n = hval(name).replace(/["\\]/g, ''); const e = hval(email).replace(/[<>\s]/g, ''); return n ? `${/^[\x20-\x7e]*$/.test(n) ? `"${n}"` : henc(n)} <${e}>` : (e ? `<${e}>` : ''); };
const err = (m, code = 2) => Object.assign(new Error(m), { code });
export const BASES = ['consent', 'customer', 'legitimate-interest'];
export const CAP = { default: 20, max: 50 };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }; // the user's local day, as Invoice's TODAY()
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const norm = (e) => String(e || '').trim().toLowerCase();
export const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
const ROLE = /^(info|admin|support|sales|hello|contact|office|team|enquiries|inquiries|help|billing|accounts|noreply|no-reply|postmaster|abuse|webmaster)@/i;

// ---- state ----
export const statePath = (p) => resolve(p || process.env.PALM_OUTREACH_STATE || join(configDir(), 'outreach', 'state.json'));
export function load(p) { try { return JSON.parse(readFileSync(statePath(p), 'utf8')); } catch { return { contacts: {}, sequences: {}, enrolments: [], suppressed: {}, log: [] }; } }
export function save(S, p) { const f = statePath(p); mkdirSync(dirname(f), { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify(S, null, 2) + '\n', { mode: 0o600 }); return f; }

// ---- CSV (quotes, commas or semicolons or tabs; first row is the header) ----
export function parseCsv(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n').replace(/^﻿/, ''), first = src.split('\n')[0] || '';
  const d = first.includes('\t') ? '\t' : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"' && !cell.trim()) { q = true; cell = ''; }
    else if (ch === d) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell.trim()); rows.push(row);
  const all = rows.filter((r) => r.some((c) => c !== ''));
  const head = (all.shift() || []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return all.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// Contacts in. Each row needs an email; name/first/company and any other column become merge fields.
// basis: the user's lawful basis for writing to these people (recorded with the date); a "basis" column overrides it.
export function importContacts(S, rows, { list, basis, source = '', now = today() } = {}) {
  if (!list) throw err('Name the list (--list), e.g. --list cafes-bristol.');
  if (!BASES.includes(basis) && !rows.every((r) => BASES.includes(r.basis))) throw err(`Say why you may email these people: --basis ${BASES.join(' | ')} (or a "basis" column on every row). Consent: they opted in. Customer: they bought from you. Legitimate interest: a relevant business contact (not for private individuals in many countries).`);
  const added = [], skipped = [];
  for (const r of rows) {
    const email = norm(r.email || r.e_mail || r.mail || r.email_address || r['e-mail'] || Object.entries(r).find(([k, v]) => /e-?mail/.test(k) && EMAIL.test(String(v).trim()))?.[1]);
    const why = !email ? 'no email' : !EMAIL.test(email) ? 'not an email address' : S.suppressed[email] ? `suppressed (${S.suppressed[email].why})` : null;
    if (why) { skipped.push({ email: email || '(blank)', why }); continue; }
    const name = r.name || [r.first_name || r.first, r.last_name || r.last].filter(Boolean).join(' ');
    const first = r.first_name || r.first || String(name).trim().split(/\s+/)[0] || '';
    const fields = Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== '' && !/e-?mail|^mail$|^basis$/.test(k)));
    const had = S.contacts[email];
    S.contacts[email] = { email, name: name || had?.name || '', first: first || had?.first || '', company: r.company || had?.company || '', fields: { ...(had?.fields || {}), ...fields }, lists: [...new Set([...(had?.lists || []), list])], basis: BASES.includes(r.basis) ? r.basis : basis, basisAt: now, source: source || had?.source || '', role: ROLE.test(email) };
    added.push(email);
  }
  const role = added.filter((e) => S.contacts[e].role).length;
  return { list, added: added.length, skipped, notes: role ? [`${role} role address${role > 1 ? 'es' : ''} (info@, hello@, …): a named person usually answers better.`] : [] };
}

// ---- templates: {{first}}, {{company}}, {{any_column}}, with a fallback {{first|there}} ----
const MERGE = /\{\{\s*([a-z0-9_]+)\s*(?:\|\s*([^}]*?))?\s*\}\}/gi;
export function fill(text, c, from = {}) {
  const missing = [];
  const out = String(text).replace(MERGE, (m, k, fb) => {
    const key = k.toLowerCase();
    const v = key === 'first' ? c.first : key === 'name' ? c.name : key === 'company' ? c.company : key === 'email' ? c.email : key === 'my_name' ? from.name : c.fields?.[key];
    if (v != null && String(v).trim() !== '') return String(v).trim();
    if (fb != null) return fb.trim();
    missing.push(key); return m;
  });
  return { text: out, missing };
}

// A sequence: {name, from:{name, email, address}, perDay?, unsubscribe?, steps:[{day, subject, body}]}.
// Checked: every step keeps the unsubscribe line and the postal address (added at the foot of every email), merge
// fields have a value or a fallback, days go up, subjects are short and not shouty.
export function checkSequence(q) {
  const problems = [], notes = [];
  if (!q.name) problems.push('name is missing.');
  if (!q.from?.name || !EMAIL.test(q.from?.email || '')) problems.push('from.name and from.email (your own mailbox) are needed.');
  if (!String(q.from?.address || '').trim()) problems.push('from.address (a postal address) is needed: the US CAN-SPAM Act and EU/UK rules for business email expect who you are and where; it is added at the foot of every email.');
  if (!Array.isArray(q.steps) || !q.steps.length) problems.push('steps is empty.');
  if ((q.steps || []).length > 5) problems.push(`${q.steps.length} steps: keep a sequence to 5 emails at most (3 is usual).`);
  let last = -1;
  (q.steps || []).forEach((s, i) => {
    if (!Number.isInteger(+s.day) || +s.day < 0) problems.push(`step ${i + 1}: day must be a whole number of days after the start (0 for the first).`);
    else if (+s.day <= last) problems.push(`step ${i + 1}: day ${s.day} must come after step ${i}'s day ${last}.`);
    else if (i && +s.day - last < 2) notes.push(`step ${i + 1} follows the one before after ${+s.day - last} day: 3 or more is kinder.`);
    last = +s.day;
    if (!String(s.subject || '').trim() && i === 0) problems.push('step 1 needs a subject (later steps reply to it: "Re: …").');
    if (!String(s.body || '').trim()) problems.push(`step ${i + 1} has no body.`);
    const subj = String(s.subject || '');
    if (subj.length > 60) notes.push(`step ${i + 1}: subject is ${subj.length} characters; phones show about 40.`);
    if (/[A-Z]{5,}/.test(subj) || /!!|\$\$|free!|100% free|act now|urgent/i.test(subj)) notes.push(`step ${i + 1}: the subject reads like spam ("${subj}").`);
    const links = (String(s.body || '').match(/https?:\/\//g) || []).length;
    if (links > 2) notes.push(`step ${i + 1}: ${links} links; one is plenty in a personal email.`);
  });
  const per = q.perDay == null ? CAP.default : +q.perDay;
  if (!(per >= 1 && per <= CAP.max)) problems.push(`perDay must be 1 to ${CAP.max} (a personal mailbox sending more gets flagged; default ${CAP.default}).`);
  return { problems, notes, perDay: Math.min(per || CAP.default, CAP.max) };
}
const foot = (q) => `\n\n--\n${q.from.name}\n${String(q.from.address).trim()}\n${q.unsubscribe || 'If you\'d rather not hear from me again, reply "unsubscribe" and I won\'t write again.'}`;

export function addSequence(S, q) {
  const c = checkSequence(q);
  if (c.problems.length) throw err('The sequence needs fixing:\n- ' + c.problems.join('\n- '), 1);
  S.sequences[q.name] = { ...q, perDay: c.perDay, steps: q.steps.map((s) => ({ day: +s.day, subject: String(s.subject || ''), body: String(s.body) })) };
  return { name: q.name, steps: q.steps.length, perDay: c.perDay, notes: c.notes };
}

// Contacts of a list join a sequence (once per sequence; never if suppressed or already in it).
export function enrol(S, sequence, list, { now = today() } = {}) {
  if (!S.sequences[sequence]) throw err(`No sequence "${sequence}". Add it first: palm outreach sequence <file.json>`, 1);
  const people = Object.values(S.contacts).filter((c) => c.lists.includes(list));
  if (!people.length) throw err(`No contacts in list "${list}".`, 1);
  let n = 0; const skipped = [];
  for (const c of people) {
    if (S.suppressed[c.email]) { skipped.push({ email: c.email, why: 'suppressed' }); continue; }
    if (S.enrolments.some((e) => e.email === c.email && e.sequence === sequence)) { skipped.push({ email: c.email, why: 'already in this sequence' }); continue; }
    const active = S.enrolments.find((e) => e.email === c.email && !e.stopped && e.next != null);
    if (active) { skipped.push({ email: c.email, why: `still in "${active.sequence}"` }); continue; }
    S.enrolments.push({ email: c.email, sequence, startedAt: now, next: 0, dueOn: addDays(now, S.sequences[sequence].steps[0].day || 0), drafted: [], stopped: null });
    n++;
  }
  return { sequence, list, enrolled: n, skipped };
}

// Today's drafts: due steps, oldest first, up to the cap (sequence's perDay, and an overall cap). Merge fields with
// no value and no fallback hold that contact back (listed), rather than send "Hi {{first}}".
export function draftToday(S, { out = 'palm-outreach', now = today(), cap = CAP.max, dry = false } = {}) {
  const due = S.enrolments.filter((e) => !e.stopped && e.next != null && e.dueOn <= now && !S.suppressed[e.email]).sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.startedAt.localeCompare(b.startedAt));
  // the caps are per day, not per run: count what was already drafted today
  const per = {}, drafts = [], held = [], later = [];
  let already = 0;
  for (const e of S.enrolments) for (const x of e.drafted) if (x.on === now) { per[e.sequence] = (per[e.sequence] || 0) + 1; already++; }
  for (const e of due) {
    const q = S.sequences[e.sequence], c = S.contacts[e.email];
    if (!q || !c) continue;
    if (already + drafts.length >= cap || (per[e.sequence] || 0) >= q.perDay) { later.push(e.email); continue; }
    const idx = e.next, st = q.steps[idx], first = q.steps[0];
    const subj = fill(st.subject || ('Re: ' + first.subject), c, q.from), body = fill(st.body, c, q.from);
    const subject = st.subject ? subj.text : 'Re: ' + fill(first.subject, c, q.from).text;
    const missing = [...new Set([...subj.missing, ...body.missing])];
    if (missing.length) { held.push({ email: c.email, step: idx + 1, missing }); continue; }
    const text = body.text + foot(q);
    const file = join(out, now, `${String(drafts.length + 1).padStart(3, '0')}-${c.email.replace(/[^a-z0-9@.-]+/gi, '_')}.eml`);
    const eml = [`To: ${hname(c.name, c.email)}`, `From: ${hname(q.from.name, q.from.email)}`, `Subject: ${henc(subject)}`, 'X-Unsent: 1', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text, ''].join('\r\n');
    if (!dry) {
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, eml);
      e.drafted.push({ step: e.next, on: now });
      const nx = e.next + 1;
      if (nx >= q.steps.length) { e.next = null; e.dueOn = null; e.finishedAt = now; }
      else { e.next = nx; e.dueOn = addDays(now, q.steps[nx].day - q.steps[nx - 1].day); }
    }
    per[e.sequence] = (per[e.sequence] || 0) + 1;
    drafts.push({ to: c.email, name: c.name, sequence: e.sequence, step: idx + 1, of: q.steps.length, subject, file: dry ? null : resolve(file), mailto: `mailto:${encodeURIComponent(c.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`, body: text });
  }
  if (!dry && drafts.length) S.log.push({ on: now, drafted: drafts.length });
  return { drafts, held, later: later.length, dry, note: drafts.length ? 'Drafts only, nothing was sent: open each .eml (Outlook opens it as a new message) or its mailto link, read it, and send it from your own mailbox. Then tell Palm about replies (palm outreach replied <email>) so their sequence stops.' : 'Nothing due today.' };
}

// Stop someone: they replied (stops the sequence), unsubscribed or bounced (never written to again, in any sequence).
export function stop(S, email, why, { now = today() } = {}) {
  const e = norm(email);
  if (!['replied', 'unsubscribed', 'bounced'].includes(why)) throw err('why: replied, unsubscribed or bounced.');
  const hit = S.enrolments.filter((x) => x.email === e && !x.stopped && x.next != null);
  for (const x of hit) { x.stopped = why; x.stoppedAt = now; }
  if (why !== 'replied') S.suppressed[e] = { why, at: now };
  if (!hit.length && why === 'replied' && !S.contacts[e]) throw err(`${e} isn't a contact.`, 1);
  return { email: e, stopped: hit.map((x) => x.sequence), suppressed: why !== 'replied' };
}

export function status(S, { now = today() } = {}) {
  const seq = Object.keys(S.sequences).map((name) => {
    const es = S.enrolments.filter((e) => e.sequence === name);
    const c = (f) => es.filter(f).length;
    return { name, steps: S.sequences[name].steps.length, perDay: S.sequences[name].perDay, people: es.length, active: c((e) => !e.stopped && e.next != null), dueToday: c((e) => !e.stopped && e.next != null && e.dueOn <= now), replied: c((e) => e.stopped === 'replied'), unsubscribed: c((e) => e.stopped === 'unsubscribed'), bounced: c((e) => e.stopped === 'bounced'), finished: c((e) => e.next == null && !e.stopped), drafted: es.reduce((a, e) => a + e.drafted.length, 0) };
  });
  const lists = {}; for (const c of Object.values(S.contacts)) for (const l of c.lists) lists[l] = (lists[l] || 0) + 1;
  return { sequences: seq.map((s) => ({ ...s, replyRate: s.people ? Math.round(100 * s.replied / s.people) + '%' : '–' })), lists, contacts: Object.keys(S.contacts).length, suppressed: Object.keys(S.suppressed).length };
}

export async function proOk({ check, now = Date.now() } = {}) {
  const dir = join(configDir(), 'outreach'), f = join(dir, 'pro.json');
  try { const c = JSON.parse(readFileSync(f, 'utf8')); if (c.ok && now - c.at < 86400e3) return true; } catch {}
  const ok = !!(await check());
  mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify({ ok, at: now }), { mode: 0o600 });
  return ok;
}
export const isDate = (d) => ISO.test(d);
