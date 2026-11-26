#!/usr/bin/env node
// palm: Palm for any agent or terminal. Same Palm as the MCP server (https://www.yuzool.com/palm/mcp); Palm runs no AI.
// Exit codes: 0 ok · 1 a check/tool failed · 2 usage · 3 needs a Palm Pro key · 4 Palm or the network failed.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { callTool, saveKey, forgetKey } from '../lib/client.mjs';
import { checks } from '../lib/doctor.mjs';
import * as asc from '../lib/asc.mjs';
import { serve as ascServe, defaultPro } from '../lib/asc-mcp.mjs';
import * as search from '../lib/search.mjs';
import { serve as searchServe, defaultPro as searchPro } from '../lib/search-mcp.mjs';
import * as design from '../lib/design.mjs';
import { serve as designServe, defaultPro as designPro } from '../lib/design-mcp.mjs';
import * as pages from '../lib/pages.mjs';
import { serve as pagesServe, defaultPro as pagesPro } from '../lib/pages-mcp.mjs';
import * as passport from '../lib/passport.mjs';
import * as pdf from '../lib/pdf.mjs';
import { serve as pdfServe, defaultPro as pdfPro } from '../lib/pdf-mcp.mjs';
import { serve as passportServe, defaultPro as passportPro } from '../lib/passport-mcp.mjs';
import * as invoice from '../lib/invoice.mjs';
import { serve as invoiceServe, defaultPro as invoicePro } from '../lib/invoice-mcp.mjs';
import * as outreach from '../lib/outreach.mjs';
import * as briefs from '../lib/brief.mjs';
import { serve as outreachServe, defaultPro as outreachPro } from '../lib/outreach-mcp.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const yes = argv.includes('--yes') || argv.includes('-y');
const args = argv.filter((a) => !['--json', '--yes', '-y'].includes(a));
const [cmd, ...rest] = args;

const HELP = {
  '': `palm: Palm for any agent or terminal. Tested job sheets, dated platform data, and local tools that let an agent see what it makes.

  palm start "<request>"         the job sheet for a request (start here)
  palm sheet <id>                one job sheet
  palm menu                      every sheet, data pack and tool
  palm data <pack> [match]       dated, sourced data (e.g. palm data design/platform-sizes instagram)
  palm tool <name>               save a local tool to ./palm/tools/<name>.mjs
  palm check <tool> [args…]      fetch (if needed) and run a local tool, e.g. palm check web-icons check ./site
  palm watch add|list|report|remove [url]   Palm Watch (Pro): Palm re-checks your pages daily
  palm doctor                    what the local tools need on this machine, and how to install it
  palm asc …                     App Store desk (Pro): reviews, reply drafts, sales, version status, a weekly digest (palm asc --help)
  palm asc-mcp                   the App Store desk as a local MCP server (stdio)
  palm search …                  search desk (Pro): Search Console, Bing, page indexing, IndexNow, llms.txt, a weekly digest (palm search --help)
  palm search-mcp                the search desk as a local MCP server (stdio)
  palm design …                  image desk: Quick Design designs to every platform size, MP4 and one per CSV row, checked (palm design --help)
  palm design-mcp                the image desk as a local MCP server (stdio)
  palm pages …                   pages desk: live pages with no hosting, QR codes checked to scan (palm pages --help)
  palm pages-mcp                 the pages desk as a local MCP server (stdio)
  palm pdf …                     PDF desk: merge, split, rotate, compress, passwords; redact (verified) and signing requests (Pro) (palm pdf --help)
  palm pdf-mcp                   the PDF desk as a local MCP server (stdio)
  palm passport …                passport photo desk: a passport, visa or ID photo from your photo, checked, print sheet + digital file (palm passport --help)
  palm passport-mcp              the passport photo desk as a local MCP server (stdio)
  palm invoice …                 invoice desk: a link the client pays from, a PDF, a ledger, reminder drafts (palm invoice --help)
  palm proposal …                a proposal the client opens, accepts and signs; accepted → its invoices (palm proposal --help)
  palm invoice-mcp               the invoice and proposal desk as a local MCP server (stdio)
  palm brief [--save] · brief schedule   the week across every desk, what to do today on top (Pro)
  palm outreach …                outreach desk (Pro): personal email sequences, drafted daily within a cap; stops on replies (palm outreach --help)
  palm outreach-mcp              the outreach desk as a local MCP server (stdio)
  palm setup                     npm i puppeteer-core jsqr in this project
  palm login [key] · palm logout Palm Pro key (or set PALM_KEY)

Flags: --json (machine-readable output) · --yes (don't ask) · --help
Free without a key; Pro sheets and tools need a Palm Pro key: https://www.yuzool.com/palm/#pro`,
  start: 'palm start "<request>"   Give Palm the request in one sentence; it prints the job sheet to follow, start to finish.',
  sheet: 'palm sheet <id>   Print one job sheet (ids: palm menu).',
  menu: 'palm menu   Every job sheet, data pack and local tool, with Pro marked.',
  data: 'palm data <pack> [match]   Dated, sourced data. e.g. palm data design/platform-sizes "instagram story"',
  tool: 'palm tool <name>   Save a local tool (and anything it needs beside it) to ./palm/tools/. Then: node palm/tools/<name>.mjs',
  check: 'palm check <tool> [args…]   Fetch the tool if it is missing or Palm\'s library changed, then run it here with node. e.g. palm check a11y-check index.html',
  watch: 'palm watch add <url> | list | report | remove <url> | forget   Palm Watch (Pro).',
  doctor: 'palm doctor   Checks Node, Chrome, puppeteer-core, jsqr, ffmpeg, a PDF renderer, the Palm server and your key; prints how to install what is missing.',
  setup: 'palm setup [--yes]   Installs puppeteer-core and jsqr in this project (npm).',
  login: 'palm login [key]   Saves your Palm Pro key to ~/.config/palm/key (only you can read it). Without a key argument, paste it when asked.',
  logout: 'palm logout   Removes the saved key.',
  asc: `palm asc: Palm's App Store desk (Pro). Runs here with your App Store Connect API key; the key and your App Store data never go to Palm.

  palm asc apps [filter]                          your apps
  palm asc reviews [--days 30] [--app x] [--unanswered] [--rating 1,2] [--territory GBR]
  palm asc draft <reviewId> "<reply>"            save a reply draft (nothing is sent)
  palm asc drafts                                 saved drafts
  palm asc approve <draftId> [--send]            show, then (with --send) post one draft: the only write
  palm asc sales [--days 7]                       downloads, in-app, proceeds, subscription events vs the period before
  palm asc status [app]                           App Store version state and latest builds
  palm asc digest [--days 7]                      all of the above as a markdown digest

Key: ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH (+ ASC_VENDOR_NUMBER for sales), or ~/.config/palm/asc/config.json, or ~/.appstoreconnect/.`,
  search: `palm search: Palm's search desk (Pro). Runs here with your own Search Console and Bing credentials; they and your search data never go to Palm.

  palm search sites                               Search Console properties you can read
  palm search report [--days 28] [--site s]       clicks, impressions, CTR, position vs the period before; top queries and pages; pages that lost clicks
  palm search pages <url> [--site s]              is this page indexed? (Google URL Inspection: verdict, canonical, last crawl)
  palm search bing [--site s]                     Bing Webmaster Tools: clicks, impressions, top queries, crawl
  palm search llms <site>                         check llms.txt: shape, size, broken links
  palm search indexnow <url…> | --sitemap <origin> [--days 1] [--send] [--key k --key-location url]
                                                  list (and with --send, submit) changed URLs to IndexNow: the only write
  palm search digest [--days 7] [--site s]        all of it as a markdown digest with next steps

Google: PALM_GSC_KEY or GOOGLE_APPLICATION_CREDENTIALS (a service-account JSON key added as a user on the property). Bing: PALM_BING_KEY.
Or ~/.config/palm/search/config.json {gscKeyPath, bingKeyPath, site, indexnow: {host, key, keyLocation}}.`,
  design: `palm design: Palm's image desk. Quick Design's own drawing and layout code runs here in your Chrome; the design and files stay on this machine.

  palm design templates [words] [--category ig]   Quick Design templates (free ones list their text fields)
  palm design fill "<template>" p1e2="New text" … [--out design.json]   a free template with your text (free)
  palm design render <design> [--out dir]          PNG per page, sheet.png at phone size, measured checks (free)
  palm design sizes <design> --for social[,reel,…] [--ads] [--out dir]   every platform size laid out again, checked (Pro)
  palm design video <design> [--for reel,tiktok] [--hold 3] [--gif]    MP4 of its entrance animations + cover (Pro)
  palm design batch <design> <rows.csv> [--for …] [--limit 200]        one design per row (Pro)

<design>: a design .json (Quick Design format v1), a Quick Design link, or - for stdin.
Sizes (checked ${design.SIZES_CHECKED}): ${Object.keys(design.TARGETS).join(', ')}.
Presets: ${Object.entries(design.PRESETS).filter(([k]) => k !== 'all').map(([k, v]) => k + ' = ' + v.join(' ')).join('; ')}; all.
Every run writes manifest.json (files, sizes, alt text, issues) and sheet.png. Exit 1 when a check fails.
Needs Chrome and puppeteer-core in this folder (palm doctor).`,
  pages: `palm pages: Palm's pages desk. A live page with no hosting: Link in Bio, Website Maker, Business Card and Menu Maker
pages travel inside their own yuzool.com link (nothing uploaded), so the page is live, and public to anyone with the link,
the moment the link exists. Checked with each app's own code; looked at in your Chrome; the preview is never counted as a visit.

  palm pages example --kind link-in-bio|website|card|menu [--template id]   a page in the app's format to start from (free)
  palm pages make <page.json|link|-> --kind <kind> [--out dir]   validate (unsafe links refused, Pro looks → free ones), the link,
                                                  phone (390 px) and desktop screenshots, console errors, every link checked,
                                                  link length vs a QR code and a bio field; manifest.json (free)
  palm pages qr <url|text> [--size 30mm|3cm|1.2in|600px] [--out qr.png]   a QR (PNG at 300 dpi + SVG) decoded with jsQR at that
                                                  size; fails unless it reads back the same text; Palm's phone test (20 cm) (free)
  palm pages qr --page <dir> [--size 30mm] [--contact]   a made page's QR, as its app makes it (a card: its link, or the vCard) (free)
  palm pages cards <people.csv> [--base card.json] [--qr-size 25mm] [--out dir]   a business card per row (name, title, company,
                                                  phone, email, website, address), each looked at, each QR checked (Pro)
  palm pages qrs <list.csv> [--size 30mm] [--out dir]   a QR per row (url/link/text column; name for file names), each checked (Pro)

Short links (yuzool.com/bio/<name>, /site/, /card/, /menu/) are each app's own Pro, made in the app; Palm never makes them.
Exit 1 when a check fails. Screenshots need Chrome and puppeteer-core in this folder (palm doctor); QR codes need neither.`,
  pdf: pdf.HELP,
  'pdf-mcp': 'palm pdf-mcp   The PDF desk as a local MCP server over stdio. Claude Code: claude mcp add palm-pdf -- npx -y github:pearcoderman/palm-cli pdf-mcp',
  passport: `palm passport: Palm's passport photo desk. Yuzool Passport Photo's own rules and code run here in your Chrome; the photo never leaves this machine.

  palm passport docs [words]                       documents: size, head, background, digital file, official source + date checked; "taken for you" when the office takes it (free)
  palm passport doc <id>                           every rule for one document (free)
  palm passport make <photo> --doc <id> [--paper 4x6|5x7|a4|letter] [--bg keep|plain|white|#hex] [--glasses-off] [--baby] [--out dir]
                                                   the photo at the document's size (300 dpi JPEG), the app's checks, a print sheet,
                                                   the digital upload file, look-1.png with the app's guides, page.png (free: one photo)
  palm passport make <a.jpg> <b.jpg> --docs uk-passport,us-passport   several people on one sheet (Pro)
  palm passport make <photo> --size 30x40 [--head 24-30]               a custom size for a form with its own rules (Pro)

--bg: keep (default; best on a plain light wall), plain (the document's own colour, cut out on this machine), white or a
colour: free when the document allows it, any other is Pro. The checks are advice against the published rules, never a
promise: the office that takes the photo decides. Exit 1 when no face is found or a check says fix.
Needs Chrome and puppeteer-core (palm doctor); the face finder and cut-out models download once.`,
  'passport-mcp': 'palm passport-mcp   The passport photo desk as a local MCP server over stdio. Claude Code: claude mcp add palm-passport -- npx -y github:pearcoderman/palm-cli passport-mcp',
  invoice: `palm invoice: Palm's invoice desk. Runs here; the ledger stays on this machine; Palm never sends email.

  palm invoice make <invoice.json> [--out dir] [--no-record] [--no-pdf]   check it, total it, and make the client's link
                                                  (they view and pay; nothing stored on a server), a PDF and an email draft (free)
  palm invoice list                               open, overdue and paid; what's owed per currency (Pro)
  palm invoice paid <number> [--date YYYY-MM-DD]  mark paid (Pro)
  palm invoice send <number>                      a draft invoice (a later proposal payment) goes out: chased from now on (Pro)
  palm invoice chase [--dry] [--out dir]          today's reminder drafts (.eml): 3 days before, on the day, 7, 14, 30 days late; each once (Pro)
  palm invoice schedule [--hour 9] [--remove]     draft them every morning (a Mac LaunchAgent with a notification; prints a cron line elsewhere) (Pro)

invoice.json (prices in normal money): {"currency":"GBP","terms":14,"from":{"name":"…","email":"…","payLink":"https://…"},
  "to":{"name":"…","contact":"Sam","email":"…"},"lines":[{"desc":"Logo design","qty":1,"price":450}],"taxRate":20,"taxName":"VAT"}
Ledger: ~/.config/palm/invoice/ledger.json (or --ledger / PALM_INVOICE_LEDGER). The PDF needs Chrome and puppeteer-core (palm doctor).`,
  proposal: `palm proposal: proposals with Yuzool Invoice's proposal pages (cover, letter, sections, timeline, price table with
options, payment schedule, terms, acceptance page). Runs here; Palm never sends email.

  palm proposal make <proposal.json> [--out dir] [--no-pdf]   the client's link (they read it, accept by email or sign the
                                                  PDF's last page; nothing stored on a server), a PDF and an email draft (free)
  palm proposal accepted <number> [--options "Photo booth, Lighting"] [--date YYYY-MM-DD]
                                                  accepted: its payment schedule becomes invoices (the on-signing one is sent;
                                                  milestone ones wait as drafts until palm invoice send) (Pro)
  palm proposal declined <number>                 declined: no more follow-ups (Pro)
  palm invoice chase                              also drafts a nudge 5 days after a proposal and a note 3 days before it expires

proposal.json (prices in normal money): {"currency":"GBP","title":"Brand identity","from":{"name":"…","contact":"Alex","email":"…"},
  "to":{"name":"…","contact":"Sam","email":"…"},"letter":"…","sections":[{"h":"Scope","text":"…"}],
  "milestones":[{"title":"Final files","days":42}],"lines":[{"desc":"Logo","qty":1,"price":2400},{"desc":"Extras","price":450,"optional":true}],
  "taxRate":20,"schedule":[{"label":"On signing","pct":40,"at":"sign"},{"label":"On delivery","pct":60,"at":1}],"validDays":30,
  "jurisdiction":"England and Wales","theme":"forest"}`,
  outreach: `palm outreach: Palm's outreach desk (Pro). Personal email sequences, drafted each day for you to send from your own
mailbox. Palm never sends email. Everyone has a recorded basis; replies stop their sequence; unsubscribes and bounces are never
written to again.

  palm outreach import <contacts.csv> --list <name> --basis consent|customer|legitimate-interest [--source "…"]
  palm outreach sequence <sequence.json>          add or update a sequence (checked: postal address, ≤5 steps, days, subjects)
  palm outreach start <sequence> --list <name>    enrol a list (first emails due today)
  palm outreach today [--dry] [--out dir]         today's drafts (.eml + mailto), at most the daily cap (default 20, max 50)
  palm outreach replied|unsubscribed|bounced <email>   stop them
  palm outreach status                            each sequence: people, due, replied (rate), unsubscribed, bounced, finished

sequence.json: {"name":"cafes","from":{"name":"Alex Moore","email":"alex@…","address":"12 Mill Lane, Bristol BS1 4AA"},"perDay":15,
  "steps":[{"day":0,"subject":"Menus for {{company}}","body":"Hi {{first|there}},\n\n…"},{"day":4,"body":"…"},{"day":10,"body":"…"}]}
State: ~/.config/palm/outreach/state.json (or --state / PALM_OUTREACH_STATE).`,
  brief: `palm brief: one page for the week across Palm's desks, with what to do today on top (Pro). Money (owed, overdue,
proposals waiting, reminders due), outreach (due, replies), the App Store (unanswered reviews, sales), search (clicks, pages
that lost them) and Palm Watch; each part only when that desk is set up. Read here with your own keys.

  palm brief [--days 7] [--save [dir]]            print it (--save writes ~/Documents/Palm/brief-YYYY-MM-DD.md)
  palm brief schedule [--day mon] [--hour 9] [--remove]   every week on a Mac (a LaunchAgent: saves it and shows a notification)`,
  'outreach-mcp': 'palm outreach-mcp   The outreach desk as a local MCP server over stdio. Claude Code: claude mcp add palm-outreach -- npx -y github:pearcoderman/palm-cli outreach-mcp',
  'invoice-mcp': 'palm invoice-mcp   The invoice desk as a local MCP server over stdio. Claude Code: claude mcp add palm-invoice -- npx -y github:pearcoderman/palm-cli invoice-mcp',
  'design-mcp': 'palm design-mcp   The image desk as a local MCP server over stdio. Claude Code: claude mcp add palm-design -- npx -y github:pearcoderman/palm-cli design-mcp',
  'search-mcp': 'palm search-mcp   The search desk as a local MCP server over stdio. Claude Code: claude mcp add palm-search -- npx -y github:pearcoderman/palm-cli search-mcp',
  'asc-mcp': 'palm asc-mcp   The App Store desk as a local MCP server over stdio. Claude Code: claude mcp add palm-asc -- npx -y github:pearcoderman/palm-cli asc-mcp',
};

const print = (text, obj) => { if (json) console.log(JSON.stringify(obj ?? { text }, null, 2)); else console.log(text); };
const fail = (msg, code = 2) => { if (json) console.log(JSON.stringify({ error: msg, code })); else console.error(msg); process.exit(code); };
const need = (v, help) => { if (!v) fail(HELP[help] || HELP['']); return v; };
async function tool(name, a) {
  try {
    const r = await callTool(name, a);
    if (r.locked) { print(r.text, { text: r.text, locked: true }); process.exit(3); }
    if (r.isError) fail(r.text, 1);
    return r.text;
  } catch (e) { fail(e.message, e.code || 4); }
}
const ask = (q) => new Promise((ok) => { const rl = createInterface({ input: process.stdin, output: process.stderr }); rl.question(q, (a) => { rl.close(); ok(a.trim()); }); });

// Saves a tool and anything its note says must sit beside it; returns the saved path.
async function saveTool(name, seen = new Set()) {
  if (seen.has(name)) return; seen.add(name);
  const text = await tool('palm_tool', { name });
  const cut = text.indexOf('\n\n');
  const note = text.slice(0, cut), src = text.slice(cut + 2);
  mkdirSync('palm/tools', { recursive: true });
  const path = join('palm', 'tools', name + '.mjs');
  writeFileSync(path, src);
  for (const m of note.matchAll(/([a-z0-9-]+)\.mjs beside it/g)) await saveTool(m[1], seen);
  return { path, note: note.replace(/^Save as [^.]+\.mjs and run with node\.\s*/, '').trim() };
}
async function libraryVersion() { const t = await tool('palm_menu', {}); return (t.match(/^Palm library (\S+)/) || [])[1] || ''; }

if (!cmd || cmd === 'help' || args.includes('--help') || args.includes('-h')) { print(HELP[args.includes('--help') || args.includes('-h') ? (cmd || '') : (rest[0] || '')] || HELP['']); process.exit(0); }

switch (cmd) {
  case 'start': print(await tool('palm_start', { request: need(rest.join(' '), 'start') })); break;
  case 'sheet': print(await tool('palm_get', { id: need(rest[0], 'sheet') })); break;
  case 'menu': print(await tool('palm_menu', {})); break;
  case 'data': print(await tool('palm_data', { pack: need(rest[0], 'data'), ...(rest[1] ? { match: rest.slice(1).join(' ') } : {}) })); break;
  case 'tool': {
    const s = await saveTool(need(rest[0], 'tool'));
    print(`Saved ${s.path}. Run: node ${s.path}${s.note ? '\n' + s.note : ''}`, { saved: s.path, needs: s.note });
    break;
  }
  case 'check': {
    const name = need(rest[0], 'check');
    const ver = await libraryVersion(), stamp = join('palm', 'tools', '.palm-library');
    const have = existsSync(join('palm', 'tools', name + '.mjs')) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === ver;
    if (!have) { await saveTool(name); writeFileSync(stamp, ver + '\n'); }
    const r = spawnSync(process.execPath, [join('palm', 'tools', name + '.mjs'), ...rest.slice(1)], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  case 'watch': {
    const [action, url] = rest;
    if (!['add', 'list', 'report', 'remove', 'forget'].includes(action)) fail(HELP.watch);
    if ((action === 'add' || action === 'remove') && !url) fail(HELP.watch);
    print(await tool('palm_watch', { action, ...(url ? { url } : {}) }));
    break;
  }
  case 'doctor': {
    const list = await checks();
    if (json) console.log(JSON.stringify(list, null, 2));
    else for (const c of list) console.log(`${c.ok ? '✓' : '✗'} ${c.id.padEnd(15)} ${c.detail}${c.ok ? '' : `\n  needed for: ${c.need}\n  fix: ${c.fix}`}`);
    process.exit(list.some((c) => !c.ok && ['node', 'palm-server'].includes(c.id)) ? 1 : 0);
  }
  case 'setup': {
    if (!yes && !(await ask('Install puppeteer-core and jsqr in this folder with npm? [y/N] ')).match(/^y/i)) fail('Not installed.', 1);
    const r = spawnSync('npm', ['i', 'puppeteer-core', 'jsqr'], { stdio: 'inherit', shell: process.platform === 'win32' });
    process.exit(r.status ?? 1);
  }
  case 'login': {
    const key = rest[0] || (await ask('Palm Pro key: '));
    if (!key) fail(HELP.login);
    const path = saveKey(key);
    let ok = false;
    try { const r = await callTool('palm_get', { id: 'review-check' }, { key }); ok = !r.locked; } catch { ok = false; }
    print(ok ? `Saved to ${path}. Pro is on.` : `Saved to ${path}, but Palm doesn't accept it as an active Palm Pro key (check it in your Polar email or portal).`, { saved: path, pro: ok });
    process.exit(ok ? 0 : 3);
  }
  case 'logout': print(forgetKey() ? 'Key removed.' : 'No saved key.', { removed: true }); break;
  case 'asc-mcp': { ascServe(); break; }
  case 'asc': {
    const [sub, ...a] = rest;
    if (!sub || sub === 'help') fail(HELP.asc);
    const opt = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
    const has = (n) => a.includes('--' + n);
    const pos = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--') && !['--unanswered', '--send'].includes(a[i - 1])));
    const needPro = async () => { if (!(await defaultPro())) { print('The App Store desk is part of Palm Pro. Run `palm login` (or set PALM_KEY). About Pro: https://www.yuzool.com/palm/#pro', { locked: true }); process.exit(3); } };
    const run = async (f) => { try { return await f(); } catch (e) { fail(e.message, e.code || 4); } };
    const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
    if (sub === 'drafts') { const d = asc.loadDrafts(); print(d.map((x) => `${x.id}  hash ${x.hash}  review ${x.reviewId}  ${x.sentAt ? 'sent ' + x.sentAt.slice(0, 10) : 'not sent'}\n  ${x.text.replace(/\n/g, '\n  ')}`).join('\n\n') || 'No drafts.', d); break; }
    if (sub === 'draft') { const d = await run(() => asc.addDraft(pos[0], pos.slice(1).join(' '))); print(`Saved draft ${d.id} (hash ${d.hash}). Nothing was sent. To post it: palm asc approve ${d.id} --send`, d); break; }
    await needPro();
    if (sub === 'approve') {
      const r = await run(() => asc.approve(asc.client(), need(pos[0], 'asc'), { send: has('send') }));
      print(r.dryRun ? `Would post to review ${r.draft.reviewId}:\n\n${r.draft.text}\n\nAdd --send to post it.` : `Posted (state ${r.draft.state}). Apple checks replies before they appear.`, r); break;
    }
    const cl = asc.client();
    if (sub === 'apps') { const x = await run(() => asc.apps(cl, pos[0] || '')); print(x.map((y) => `${y.name}  ${y.bundleId}  (${y.id})`).join('\n') || 'No apps.', x); break; }
    if (sub === 'reviews') {
      const x = await run(() => asc.reviews(cl, { days: Number(opt('days', 30)), app: opt('app', ''), unanswered: has('unanswered'), rating: opt('rating'), territory: opt('territory') }));
      print(x.map((r) => `${stars(r.rating)}  ${r.app} · ${r.date} · ${r.territory}${r.reply ? '' : ' · NO REPLY'}\n  ${r.title}${r.body ? '\n  ' + r.body.replace(/\n/g, '\n  ') : ''}${r.reply ? `\n  ↳ ${r.reply.state.toLowerCase()}: ${r.reply.body.replace(/\n/g, '\n    ')}` : ''}\n  id ${r.id}`).join('\n\n') + `\n\n${x.length} reviews, ${x.filter((r) => !r.reply).length} without a reply.`, x); break;
    }
    if (sub === 'sales') { const x = await run(() => asc.sales(cl, { days: Number(opt('days', 7)) })); print(JSON.stringify(x, null, 2), x); break; }
    if (sub === 'status') { const x = await run(() => asc.status(cl, pos[0] || '')); print(x.map((y) => `${y.app}: ${y.versions.map((v) => `${v.platform} ${v.version} ${v.state}`).join('; ')}${y.builds[0] ? ` · build ${y.builds[0].build} ${y.builds[0].processing}` : ''}`).join('\n'), x); break; }
    if (sub === 'digest') { const x = await run(() => asc.digest(cl, { days: Number(opt('days', 7)), app: opt('app', '') })); print(x.markdown, x); break; }
    fail(HELP.asc);
    break;
  }
  case 'search-mcp': { searchServe(); break; }
  case 'search': {
    const [sub, ...a] = rest;
    if (!sub || sub === 'help') fail(HELP.search);
    const opt = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
    const has = (n) => a.includes('--' + n);
    const pos = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--') && a[i - 1] !== '--send'));
    if (!(await searchPro())) { print('The search desk is part of Palm Pro. Run `palm login` (or set PALM_KEY). About Pro: https://www.yuzool.com/palm/#pro', { locked: true }); process.exit(3); }
    const run = async (f) => { try { return await f(); } catch (e) { fail(e.message, e.code || 4); } };
    const cl = search.client(), site = opt('site');
    const num = (x) => (x == null ? '–' : Math.round(x).toLocaleString('en-GB'));
    if (sub === 'sites') { const x = await run(() => search.sites(cl)); print(x.map((y) => `${y.site}  (${y.permission})`).join('\n') || 'No properties.', x); break; }
    if (sub === 'report') {
      const x = await run(() => search.report(cl, { site, days: Number(opt('days', 28)) }));
      const t = x.totals, p = x.previousTotals;
      print([`${x.site}, ${x.period.start} to ${x.period.end}: ${num(t.clicks)} clicks (was ${num(p.clicks)}), ${num(t.impressions)} impressions (was ${num(p.impressions)}), CTR ${(t.ctr * 100).toFixed(1)}%, position ${t.position ? t.position.toFixed(1) : '–'}`,
        '', 'Top queries (impressions · clicks · position):', ...x.topQueries.map((q) => `  ${q.key.slice(0, 50).padEnd(50)} ${num(q.impressions).padStart(7)} · ${num(q.clicks).padStart(5)} · ${q.position.toFixed(1)}`),
        '', 'Top pages:', ...x.topPages.map((q) => `  ${q.key.slice(0, 70).padEnd(70)} ${num(q.impressions).padStart(7)} · ${num(q.clicks).padStart(5)}`),
        '', x.dropped.length ? 'Lost clicks (now · before):' : 'No page lost 2+ clicks.', ...x.dropped.map((d) => `  ${d.page}  ${d.clicks} · ${d.before}`)].join('\n'), x);
      break;
    }
    if (sub === 'pages' || sub === 'inspect') { const x = await run(() => search.inspect(cl, need(pos[0], 'search'), { site })); print(`${x.url}\n  ${x.verdict} · ${x.coverage || ''}\n  last crawl ${x.lastCrawl || '–'} · robots ${x.robots || '–'} · fetch ${x.fetch || '–'}\n  canonical: Google ${x.googleCanonical || '–'} · yours ${x.userCanonical || '–'}${x.canonicalMismatch ? '  ← different' : ''}`, x); break; }
    if (sub === 'bing') { const x = await run(() => search.bingSummary(cl, { site })); print(x.site ? `${x.site} (${x.verified ? 'verified' : 'NOT verified'}): ${num(x.clicks)} clicks, ${num(x.impressions)} impressions${x.crawl ? `; crawl: ${num(x.crawl.crawled)} pages, ${num(x.crawl.inIndex)} in index, ${num(x.crawl.errors)} errors` : ''}` : x.note, x); break; }
    if (sub === 'llms') { const x = await run(() => search.llms(cl, need(pos[0], 'search'))); print(x.present ? `${x.origin}/llms.txt: ${Math.round(x.bytes / 1000)} KB, ${x.links} links, ${x.broken.length} broken of ${x.checked} checked${x.issues.length ? '\n' + x.issues.map((i) => `  ${i.level}: ${i.msg}`).join('\n') : ''}` : x.issues[0].msg, x); process.exit(x.broken?.length ? 1 : 0); }
    if (sub === 'indexnow') {
      const origin = opt('sitemap');
      const urls = origin ? await run(() => search.sitemapUrls(cl, origin.replace(/\/$/, ''), { days: Number(opt('days', 0)) })) : pos;
      const x = await run(() => search.indexnow(cl, urls, { send: has('send'), key: opt('key'), keyLocation: opt('key-location') }));
      print(x.dryRun ? `Dry run: ${x.count} URL(s)${x.host ? ' on ' + x.host : ''} would be submitted:\n${(x.urls || []).map((u) => '  ' + u).join('\n')}${x.count > 50 ? `\n  … and ${x.count - 50} more` : ''}\nAdd --send to submit.` : `IndexNow: ${x.results.map((r) => `${r.count} URLs → ${r.status}${r.ok ? ' accepted' : ''}`).join('; ')}`, x);
      break;
    }
    if (sub === 'digest') { const x = await run(() => search.digest(cl, { site, days: Number(opt('days', 7)) })); print(x.markdown, x); break; }
    fail(HELP.search);
    break;
  }
  case 'proposal': {
    const [sub, ...a] = rest;
    if (!sub || sub === 'help') fail(HELP.proposal);
    const VAL = ['--out', '--ledger', '--date', '--options'];
    const opt = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
    const has = (n) => a.includes('--' + n);
    const pos = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && VAL.includes(a[i - 1])));
    const run = async (f) => { try { return await f(); } catch (e) { fail(e.message, e.code || 4); } };
    const ledger = opt('ledger'), out = opt('out', 'palm-invoices');
    if (sub === 'make') {
      const src = need(pos[0], 'proposal');
      const x = await run(() => invoice.makeProposal(JSON.parse(readFileSync(src === '-' ? 0 : src, 'utf8')), { out, ledger, pdf: !has('no-pdf') }));
      print([`${x.number} "${x.title}" for ${x.client}: ${x.total}${x.tax ? ` (tax ${x.tax})` : ''}${x.options ? `, options worth ${x.options} not in the total` : ''}, valid until ${x.valid}`,
        ...x.payments.map((p) => `  ${p.label} ${p.pct}%: ${p.amount} (${p.when})`),
        `Client's link (they read it and accept; nothing stored on a server): ${x.link}`, x.pdf ? `PDF (${x.pages} pages; the last is for signing): ${x.pdf}` : `PDF: ${x.pdfNote}`,
        `Email draft (open it, read it, send it yourself): ${x.email}`, ...x.notes.map((n) => 'note: ' + n), x.ledger ? `Recorded in ${x.ledger}. When they say yes: palm proposal accepted ${x.number}` : ''].filter(Boolean).join('\n'), x);
      break;
    }
    if (!['accepted', 'declined'].includes(sub)) fail(HELP.proposal);
    if (!(await invoicePro())) { print('Accepting a proposal into invoices is part of Palm Pro (making a proposal is free). Run `palm login` (or set PALM_KEY). About Pro: https://www.yuzool.com/palm/#pro', { locked: true }); process.exit(3); }
    if (sub === 'declined') { const x = await run(() => invoice.declineProposal(need(pos[0], 'proposal'), { ledger, date: opt('date') })); print(`${x.number} marked declined: no more follow-ups.`, x); break; }
    const x = await run(() => invoice.acceptProposal(need(pos[0], 'proposal'), { ledger, out, date: opt('date'), chosen: opt('options') ? opt('options').split(',').map((s) => s.trim()).filter(Boolean) : [], pdf: !has('no-pdf') }));
    print([`${x.number} accepted: ${x.total}.`, ...x.invoices.map((i) => `  ${i.number} ${i.label}: ${i.total}, due ${i.due}${i.status === 'draft' ? ` (draft until "${i.milestone}": palm invoice send ${i.number})` : `\n    email draft: ${i.email}`}`)].join('\n'), x);
    break;
  }
  case 'brief': {
    const a = rest, opt = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : d; }, has = (n) => a.includes('--' + n);
    if (!(await invoicePro())) { print('The brief is part of Palm Pro. Run `palm login` (or set PALM_KEY). About Pro: https://www.yuzool.com/palm/#pro', { locked: true }); process.exit(3); }
    if (a[0] === 'schedule') {
      const { homedir } = await import('node:os'), { configDir } = await import('../lib/client.mjs');
      const day = String(opt('day', 'mon')).slice(0, 3).toLowerCase(), hour = Number(opt('hour', 9)), wd = briefs.WEEKDAYS[day];
      if (wd == null || !(hour >= 0 && hour <= 23)) fail('--day mon…sun, --hour 0 to 23.');
      const viaNpx = /[\\/]_npx[\\/]/.test(process.argv[1]), args = [...(viaNpx ? [join(process.execPath, '..', 'npx'), '-y', 'github:pearcoderman/palm-cli'] : [process.execPath, process.argv[1]]), 'brief', '--save', '--notify'];
      if (process.platform !== 'darwin') { print(`Add this to your scheduler (Palm doesn't edit it for you):\n\n${invoice.cronLine({ hour, args }).replace(/^(\S+ \S+) \* \* \*/, `$1 * * ${wd}`)}`, { args }); break; }
      const agent = join(homedir(), 'Library', 'LaunchAgents', briefs.BRIEF_AGENT + '.plist'), uid = process.getuid();
      spawnSync('launchctl', ['bootout', `gui/${uid}`, agent], { stdio: 'ignore' });
      if (has('remove')) { const { rmSync } = await import('node:fs'); rmSync(agent, { force: true }); print('Removed: no more weekly briefs.', { removed: agent }); break; }
      if (!existsSync(join(configDir(), 'key'))) fail('The weekly job runs without your shell, so it can\'t see PALM_KEY. Save the key first: palm login', 3);
      const log = join(homedir(), 'Library', 'Logs', 'palm-brief.log');
      writeFileSync(agent, invoice.plist({ label: briefs.BRIEF_AGENT, weekday: wd, hour, args, log }));
      const b = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, agent], { encoding: 'utf8' });
      if (b.status !== 0) fail(`Wrote ${agent} but launchctl refused it: ${(b.stderr || '').trim()}`, 4);
      print(`Every ${day[0].toUpperCase() + day.slice(1)} at ${hour}:00 this Mac writes the brief to ${briefs.briefDir()} and shows a notification.\n  agent: ${agent}\nStop it: palm brief schedule --remove`, { agent, args });
      break;
    }
    const b = await briefs.brief({ days: Number(opt('days', 7)) });
    let file = null; if (has('save')) file = briefs.saveBrief(b, opt('save', undefined));
    if (has('notify') && process.platform === 'darwin') spawnSync('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Palm brief"', '-e', 'end run', `${b.todo.length ? b.todo.length + ' thing' + (b.todo.length > 1 ? 's' : '') + ' to do today' : 'Nothing urgent'}${file ? ' · ' + file.split('/').pop() : ''}`], { stdio: 'ignore' });
    print(b.markdown + (file ? `\nSaved to ${file}` : ''), { ...b, file });
    break;
  }
  case 'outreach-mcp': { outreachServe(); break; }
  case 'outreach': {
    const [sub, ...a] = rest;
    if (!sub || sub === 'help') fail(HELP.outreach);
    const VAL = ['--out', '--state', '--list', '--basis', '--source'];
    const opt = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
    const has = (n) => a.includes('--' + n);
    const pos = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && VAL.includes(a[i - 1])));
    const run = async (f) => { try { return await f(); } catch (e) { fail(e.message, e.code || 4); } };
    if (!(await outreachPro())) { print('The outreach desk is part of Palm Pro. Run `palm login` (or set PALM_KEY). About Pro: https://www.yuzool.com/palm/#pro', { locked: true }); process.exit(3); }
    const st = opt('state'), S = outreach.load(st), done = (text, x) => { outreach.save(S, st); print(text, x); };
    if (sub === 'import') { const x = await run(() => outreach.importContacts(S, outreach.parseCsv(readFileSync(need(pos[0], 'outreach'), 'utf8')), { list: opt('list'), basis: opt('basis'), source: opt('source', '') })); done(`${x.added} contacts in "${x.list}".${x.skipped.length ? `\nSkipped ${x.skipped.length}:\n${x.skipped.slice(0, 20).map((k) => `  ${k.email}: ${k.why}`).join('\n')}` : ''}${x.notes.map((n) => '\nnote: ' + n).join('')}`, x); break; }
    if (sub === 'sequence') { const x = await run(() => outreach.addSequence(S, JSON.parse(readFileSync(need(pos[0], 'outreach'), 'utf8')))); done(`Sequence "${x.name}": ${x.steps} emails, at most ${x.perDay} a day.${x.notes.map((n) => '\nnote: ' + n).join('')}`, x); break; }
    if (sub === 'start') { const x = await run(() => outreach.enrol(S, need(pos[0], 'outreach'), opt('list'))); done(`${x.enrolled} people started "${x.sequence}" (first emails due today: palm outreach today).${x.skipped.length ? ` Skipped ${x.skipped.length} (${[...new Set(x.skipped.map((k) => k.why))].join('; ')}).` : ''}`, x); break; }
    if (sub === 'today') {
      const x = outreach.draftToday(S, { out: opt('out', 'palm-outreach'), dry: has('dry') });
      done([...x.drafts.map((d) => `${d.to} · ${d.sequence} ${d.step}/${d.of} · ${d.subject}${d.file ? '\n  ' + d.file : ''}`), ...x.held.map((h) => `held: ${h.email} (step ${h.step}): no value for ${h.missing.map((m) => '{{' + m + '}}').join(', ')}; add it, or a fallback like {{${h.missing[0]}|…}}`), x.later ? `${x.later} more due, over today's cap: tomorrow.` : '', x.note].filter(Boolean).join('\n'), x);
      break;
    }
    if (['replied', 'unsubscribed', 'bounced'].includes(sub)) { const x = await run(() => outreach.stop(S, need(pos[0], 'outreach'), sub)); done(`${x.email}: ${sub}.${x.stopped.length ? ` Stopped: ${x.stopped.join(', ')}.` : ''}${x.suppressed ? ' Never written to again.' : ''}`, x); break; }
    if (sub === 'status') { const x = outreach.status(S); print(x.sequences.map((q) => `${q.name}: ${q.people} people, ${q.active} active (${q.dueToday} due today), ${q.replied} replied (${q.replyRate}), ${q.unsubscribed} unsubscribed, ${q.bounced} bounced, ${q.finished} finished; ${q.drafted} drafts so far`).join('\n') + `\n\nLists: ${Object.entries(x.lists).map(([k, v]) => `${k} (${v})`).join(', ') || 'none'} · ${x.contacts} contacts · ${x.suppressed} suppressed`, x); break; }
    fail(HELP.outreach);
    break;
  }
  case 'invoice-mcp': { invoiceServe(); break; }
  case 'invoice': {
    const [sub, ...a] = rest;
    if (!sub || sub === 'help') fail(HELP.invoice);
    const VAL = ['--out', '--ledger', '--date', '--hour'];
    const opt = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
    const has = (n) => a.includes('--' + n);
    const pos = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && VAL.includes(a[i - 1])));
    const run = async (f) => { try { return await f(); } catch (e) { fail(e.message, e.code || 4); } };
    const ledger = opt('ledger'), out = opt('out', 'palm-invoices');
    if (sub === 'make') {
      const src = need(pos[0], 'invoice');
      const x = await run(() => invoice.make(JSON.parse(readFileSync(src === '-' ? 0 : src, 'utf8')), { out, ledger, record: !has('no-record'), pdf: !has('no-pdf') }));
      print([`${x.number} to ${x.client}: ${x.total} (subtotal ${x.subtotal}${x.discount ? ', discount ' + x.discount : ''}${x.tax ? ', tax ' + x.tax : ''}), due ${x.due}`, `Client's link (they view and pay; the invoice is inside the link): ${x.link}`, x.pdf ? `PDF: ${x.pdf}` : `PDF: ${x.pdfNote}`, `Email draft (open it, read it, send it yourself): ${x.email}`, ...x.notes.map((n) => 'note: ' + n), x.ledger ? `Recorded in ${x.ledger}` : 'Not recorded (--no-record).'].join('\n'), x);
      break;
    }
    if (!['list', 'paid', 'chase', 'schedule', 'send'].includes(sub)) fail(HELP.invoice);
    if (!(await invoicePro())) { print('The ledger and reminders are part of Palm Pro (making an invoice is free). Run `palm login` (or set PALM_KEY). About Pro: https://www.yuzool.com/palm/#pro', { locked: true }); process.exit(3); }
    if (sub === 'list') { const x = invoice.list({ ledger }); print(x.rows.map((r) => `${r.state === 'overdue' ? '!' : r.state === 'paid' ? '✓' : r.state === 'draft' ? '·' : ' '} ${r.number.padEnd(10)} ${r.client.slice(0, 28).padEnd(28)} ${invoice.fmt(r.total, r.currency).padStart(12)}  due ${r.due}${r.state === 'overdue' ? `  ${r.late} days late` : ''}${r.paidAt ? `  paid ${r.paidAt}` : ''}${r.state === 'draft' ? '  draft (palm invoice send when it is due)' : ''}`).join('\n') + (x.proposals.length ? `\n\nProposals:\n${x.proposals.map((p) => `  ${p.number.padEnd(10)} ${p.title.slice(0, 26).padEnd(26)} ${p.client.slice(0, 20).padEnd(20)} ${p.total.padStart(12)}  ${p.status}${p.invoices.length ? ' → ' + p.invoices.join(', ') : ''}`).join('\n')}` : '') + `\n\nOwed: ${Object.entries(x.owed).map(([c, v]) => v).join(', ') || 'nothing'}${x.overdue ? ` · ${x.overdue} overdue` : ''}`, x); break; }
    if (sub === 'send') { const x = await run(() => invoice.send(need(pos[0], 'invoice'), { ledger })); print(`${x.number} is ${x.status === 'sent' ? 'out: it will be chased from now on' : x.status}. Email draft (send it yourself):\n  ${x.email.mailto}`, x); break; }
    if (sub === 'paid') { const x = await run(() => invoice.paid(need(pos[0], 'invoice'), { date: opt('date'), ledger })); print(`${x.number} marked paid on ${x.paidAt}.`, x); break; }
    if (sub === 'schedule') {
      const { homedir } = await import('node:os'), hour = Number(opt('hour', 9)), args = invoice.scheduleCommand({ out, ledger });
      if (!(hour >= 0 && hour <= 23)) fail('--hour is 0 to 23.');
      if (process.platform !== 'darwin') { print(`Add this to your scheduler to draft reminders every day at ${hour}:00 (Palm doesn't edit it for you):\n\n${process.platform === 'win32' ? `schtasks /Create /SC DAILY /ST ${String(hour).padStart(2, '0')}:00 /TN PalmInvoiceChase /TR "${args.join(' ')}"` : 'crontab -e, then:\n' + invoice.cronLine({ hour, args })}`, { args }); break; }
      const agent = join(homedir(), 'Library', 'LaunchAgents', invoice.AGENT + '.plist'), uid = process.getuid();
      const { configDir } = await import('../lib/client.mjs');
      if (!has('remove') && !existsSync(join(configDir(), 'key'))) fail('The morning job runs without your shell, so it can\'t see PALM_KEY. Save the key first: palm login', 3);
      spawnSync('launchctl', ['bootout', `gui/${uid}`, agent], { stdio: 'ignore' });
      if (has('remove')) { const { rmSync } = await import('node:fs'); rmSync(agent, { force: true }); print('Removed: no more morning reminder drafts.', { removed: agent }); break; }
      const log = join(homedir(), 'Library', 'Logs', 'palm-invoice-chase.log');
      mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
      writeFileSync(agent, invoice.plist({ hour, args, log }));
      const b = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, agent], { encoding: 'utf8' });
      if (b.status !== 0) fail(`Wrote ${agent} but launchctl refused it: ${(b.stderr || '').trim()}`, 4);
      print(`Every day at ${hour}:00 this Mac drafts the reminders that are due and shows a notification. Nothing is sent.\n  runs: ${args.join(' ')}\n  agent: ${agent}\n  log: ${log}\nStop it: palm invoice schedule --remove`, { agent, args, log });
      break;
    }
    if (sub === 'chase') { const x = invoice.chase({ out, ledger, dry: has('dry') });
      if (has('notify') && x.drafts.length && process.platform === 'darwin') spawnSync('osascript', invoice.notifyArgs(x.drafts), { stdio: 'ignore' }); print(x.drafts.map((d) => `${d.number} ${d.client} (${d.why}) → ${d.to}\n  ${d.subject}${d.file ? '\n  ' + d.file : ''}`).join('\n\n') + (x.drafts.length ? '\n\n' : '') + x.note, x); break; }
    break;
  }
  case 'design-mcp': { designServe(); break; }
  case 'pdf-mcp': { pdfServe(); break; }
  case 'pdf': { process.exit(await pdf.cli(rest, { print, fail, pro: pdfPro })); }
  case 'passport-mcp': { passportServe(); break; }
  case 'passport': {
    const [sub, ...a] = rest;
    if (!sub || sub === 'help') fail(HELP.passport);
    const VAL = ['--out', '--doc', '--docs', '--paper', '--bg', '--size', '--head'];
    const opt = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
    const has = (n) => a.includes('--' + n);
    const pos = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && VAL.includes(a[i - 1])));
    const run = async (f) => { try { return await f(); } catch (e) { if (e.code === 3) { print(e.message, { locked: true }); process.exit(3); } fail(e.message, e.code || 4); } };
    if (sub === 'docs') { const x = await run(() => passport.docs({ query: pos.join(' ') })); print(passport.docsText(x), x); break; }
    if (sub === 'doc') { const x = await run(() => passport.doc(need(pos[0], 'passport'))); print(JSON.stringify(x, null, 2), x); break; }
    if (sub !== 'make') fail(HELP.passport);
    const docs = (opt('docs') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const people = pos.map((photo, i) => ({ photo, doc: docs[i] || opt('doc') || docs[0] }));
    const r = await run(() => passport.make({ people, doc: opt('doc'), paper: opt('paper'), bg: opt('bg'), size: opt('size'), head: opt('head'), glassesOff: has('glasses-off'), baby: has('baby'), out: opt('out', 'palm-passport'), pro: passportPro }));
    print(passport.summary(r), r); process.exit(r.ok ? 0 : 1);
  }
  case 'pages-mcp': { pagesServe(); break; }
  case 'pages': {
    const [sub, ...a] = rest;
    if (!sub || sub === 'help') fail(HELP.pages);
    const VAL = ['--out', '--kind', '--size', '--template', '--page', '--base', '--qr-size', '--limit'];
    const opt = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
    const has = (n) => a.includes('--' + n);
    const pos = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && VAL.includes(a[i - 1])));
    const run = async (f) => { try { return await f(); } catch (e) { fail(e.message, e.code || 4); } };
    const done = (r) => { print(pages.summary(r), r); process.exit(r.ok ? 0 : 1); };
    if (sub === 'example') { const x = await run(() => pages.example(need(opt('kind'), 'pages'), opt('template'))); print(JSON.stringify(x.page, null, 2), x); if (x.templates.length && !json) console.error(`Templates (--template): ${x.templates.join(', ')}`); break; }
    if (sub === 'make') { const src = need(pos[0], 'pages'); done(await run(() => pages.make(src, { kind: opt('kind'), out: opt('out', 'palm-page') }))); }
    if (sub === 'qr') {
      if (opt('page')) done(await run(() => pages.pageQR(opt('page'), { size: opt('size', '30mm'), contact: has('contact'), out: opt('out') })));
      done(await run(() => pages.qr(need(pos.join(' '), 'pages'), { size: opt('size', '30mm'), out: opt('out', 'qr.png') })));
    }
    if (!['cards', 'qrs'].includes(sub)) fail(HELP.pages);
    if (!(await pagesPro())) { print('A card per CSV row and many QR codes are part of Palm Pro (make and qr are free). Run `palm login` (or set PALM_KEY). About Pro: https://www.yuzool.com/palm/#pro', { locked: true }); process.exit(3); }
    const csv = readFileSync(need(pos[0], 'pages'), 'utf8');
    if (sub === 'cards') done(await run(() => pages.makeCards(csv, { base: opt('base') ? JSON.parse(readFileSync(opt('base'), 'utf8')) : {}, out: opt('out', 'palm-cards'), qrSize: opt('qr-size', '25mm'), limit: Number(opt('limit', 200)) })));
    if (sub === 'qrs') done(await run(() => pages.qrBatch(csv, { size: opt('size', '30mm'), out: opt('out', 'palm-qr') })));
    break;
  }
  case 'design': {
    const [sub, ...a] = rest;
    if (!sub || sub === 'help') fail(HELP.design);
    const VAL = ['--out', '--for', '--hold', '--limit', '--category'];
    const opt = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
    const has = (n) => a.includes('--' + n);
    const pos = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && VAL.includes(a[i - 1])));
    const run = async (f) => { try { return await f(); } catch (e) { fail(e.message, e.code || 4); } };
    const done = (r) => { print(design.summary(r), r); process.exit(r.ok ? 0 : 1); };
    if (sub === 'templates') { const x = await run(() => design.templates({ query: pos.join(' '), category: opt('category', '') })); print(x.map((t) => `${t.name}  (${t.category}, ${t.w}×${t.h}, ${t.pages} page${t.pages > 1 ? 's' : ''}${t.fillable ? '' : ', Quick Design Pro'})${t.fillable && t.fields ? '\n' + t.fields.map((f) => `    ${f.id}: ${JSON.stringify(f.text)}`).join('\n') : ''}`).join('\n') || 'No templates match.', x); break; }
    if (sub === 'fill') {
      const reps = Object.fromEntries(pos.slice(1).map((x) => { const i = x.indexOf('='); return i > 0 ? [x.slice(0, i), x.slice(i + 1).replace(/\\n/g, '\n')] : null; }).filter(Boolean));
      const x = await run(() => design.fill(need(pos[0], 'design'), reps));
      const f = opt('out', 'design.json'); writeFileSync(f, JSON.stringify(x.design, null, 2) + '\n');
      print(`Saved ${f} from "${x.template}".${x.unknown.length ? ` Not found in the template: ${x.unknown.join(', ')}.` : ''} Next: palm design render ${f}`, { file: f, unknown: x.unknown }); break;
    }
    const src = await run(() => design.readDesign(need(pos[0], 'design')));
    const out = opt('out', 'palm-design');
    if (sub === 'render') done(await run(() => design.stills(src, { targets: [], out })));
    if (!['sizes', 'video', 'batch'].includes(sub)) fail(HELP.design);
    if (!(await designPro())) { print('Every size, video and batch are part of Palm Pro (render is free). Run `palm login` (or set PALM_KEY). About Pro: https://www.yuzool.com/palm/#pro', { locked: true }); process.exit(3); }
    const targets = opt('for') ? await run(() => design.parseTargets(opt('for'))) : null;
    if (sub === 'sizes') done(await run(() => design.stills(src, { targets: targets || design.PRESETS.social, out, ads: has('ads') })));
    if (sub === 'video') done(await run(() => design.video(src, { targets: targets || ['reel'], out, hold: Number(opt('hold', 3)), gif: has('gif'), ads: has('ads') })));
    if (sub === 'batch') done(await run(() => design.batch(src, readFileSync(need(pos[1], 'design'), 'utf8'), { targets: targets || [], out, limit: Number(opt('limit', 200)) })));
    break;
  }
  default: fail(`Unknown command "${cmd}".\n\n${HELP['']}`);
}
