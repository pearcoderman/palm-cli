# palm

Palm for any agent or terminal (Claude Code, Codex, Cursor, a shell script). Palm gives an AI agent what it can't get alone when it makes and launches things: **tested job sheets**, **dated, sourced platform data**, and **local tools that render and measure what it made**, so it sees the work before you do. Every job sheet shipped only after beating the same agent without Palm in blind tests. **Palm runs no AI.**

```sh
npx github:pearcoderman/palm-cli start "make App Store screenshots for my habit app"
```

## Install

Run any command with npx (Node 18+ and git):

```sh
npx -y github:pearcoderman/palm-cli doctor
```

Or install it once and type `palm`:

```sh
npm i -g github:pearcoderman/palm-cli
palm doctor
```

## Commands

| Command | What it does |
|---|---|
| `palm start "<request>"` | The job sheet for a request, in one sentence. Start here. |
| `palm sheet <id>` · `palm menu` | One sheet · everything Palm has (Pro marked). |
| `palm data <pack> [match]` | Dated, sourced data, e.g. `palm data design/platform-sizes "instagram story"`. |
| `palm tool <name>` | Saves a local tool to `./palm/tools/<name>.mjs` (and anything it needs beside it). |
| `palm check <tool> [args…]` | Fetches the tool if needed and runs it here, e.g. `palm check a11y-check index.html`. |
| `palm watch add <url>` · `list` · `report` · `remove <url>` | Palm Watch (Pro): Palm re-checks up to 10 pages every day and reports what broke. |
| `palm doctor` | Checks Node, Chrome, puppeteer-core, jsqr, ffmpeg, a PDF renderer, the server and your key; prints the install line for anything missing. |
| `palm design …` | Image desk: a Quick Design design at every platform size, as MP4, one per CSV row, checked where it's seen. |
| `palm invoice …` · `palm proposal …` | Invoices and proposals the client opens from a link, PDFs, a ledger, reminder drafts. |
| `palm pdf …` | Merge, split, rotate, compress, passwords; redaction that's verified; requests to sign (PDF Tools, Redact). |
| `palm passport …` | A passport, visa or ID photo to each document's official rules, with a print sheet and the digital file. |
| `palm pages …` | A link-in-bio page, one-page site, business card or menu that's live from its link, and QR codes checked to scan. |
| `palm outreach …` | Short personal email sequences, drafted daily within a cap (Pro). |
| `palm social …` | The week's posts checked against each platform's limits, then queued as drafts (or scheduled) in your own Postiz or Buffer, or posted to Bluesky. Nothing is sent without `--confirm`. |
| `palm asc …` · `palm search …` | App Store Connect and search (Search Console, Bing, IndexNow) desks, with your own keys (Pro). |
| `palm <desk>-mcp` | Any desk as a local MCP server: `design-mcp`, `invoice-mcp`, `pdf-mcp`, `passport-mcp`, `pages-mcp`, `outreach-mcp`, `social-mcp`, `asc-mcp`, `search-mcp`. |
| `palm setup` | `npm i puppeteer-core jsqr` in this project. |
| `palm login [key]` · `palm logout` | Saves your Pro key to `~/.config/palm/key` (only you can read it). Or set `PALM_KEY`. |

`--json` gives machine-readable output; `--yes` skips questions. Exit codes: 0 ok, 1 a check failed, 2 usage, 3 needs a Pro key, 4 Palm or the network failed.

## Free and Pro

The free tier needs no key: design, websites, accessibility, social profiles, print, decks, video, translations, cookie banners, and every data pack and free tool. **Palm Pro** ($15/month or $150/year, 7-day free trial) adds the rest: App Store screenshots, newsletters and welcome emails, link previews, the weekly content kit, SEO, product, event and form pages, Palm Watch, and the desks' ongoing parts (every image size, video and batches; the invoice ledger and reminders; outreach; App Store and search). Making one design or one invoice or proposal is free. The desks run on your machine: your keys, designs, invoices and contacts never go to Palm, and **Palm never sends email** (every message is a draft you send). https://www.yuzool.com/palm/#pro

## Privacy

Commands send Palm your one-sentence request or the name of a sheet, data pack or tool, plus your key if you set one. Palm keeps anonymous usage counts and, for Palm Watch, the pages you ask it to watch; nothing else. The tools run on your machine; what they check never leaves it. https://www.yuzool.com/palm/privacy.html

Also as an MCP server (`https://www.yuzool.com/palm/mcp`) and a Claude Code plugin (`/plugin marketplace add pearcoderman/palm`).

## App Store desk (Pro)

`palm asc` works with App Store Connect from your own machine: your API key and your App Store data never go to Palm.

```
palm asc reviews --unanswered          reviews without a reply, all apps
palm asc draft <reviewId> "Thanks…"    save a reply draft (nothing is sent)
palm asc approve <draftId> --send      post it (the only write; without --send it's a dry run)
palm asc sales --days 7                downloads, in-app, proceeds, subscription events vs the week before
palm asc status                        App Store version state and latest builds
palm asc digest                        all of it as a weekly markdown digest
palm asc-mcp                           the same as a local MCP server (claude mcp add palm-asc -- npx -y github:pearcoderman/palm-cli asc-mcp)
```

Key: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY_PATH` (+ `ASC_VENDOR_NUMBER` for sales), or `~/.config/palm/asc/config.json`, or `~/.appstoreconnect/`. Replies need a key with the Admin, App Manager or Customer Support role.

## Search desk (Pro)

`palm search` works with Google Search Console, Bing Webmaster Tools and IndexNow from your own machine: your credentials and your search data never go to Palm.

```
palm search report --days 28           clicks, impressions, CTR, position vs the period before; top queries and pages; pages that lost clicks
palm search pages https://…/page/      is it indexed? Google's verdict, its chosen canonical vs yours, last crawl
palm search bing                       Bing clicks, impressions, top queries, crawl
palm search llms example.com           check llms.txt: shape, size, broken links
palm search indexnow --sitemap https://www.example.com --days 1 [--send]   changed URLs to IndexNow (the only write; dry run without --send)
palm search digest                     all of it as a weekly markdown digest with next steps
palm search-mcp                        the same as a local MCP server (claude mcp add palm-search -- npx -y github:pearcoderman/palm-cli search-mcp)
```

Google: `PALM_GSC_KEY` or `GOOGLE_APPLICATION_CREDENTIALS` (a service-account JSON key, added as a user on your Search Console property). Bing: `PALM_BING_KEY`. Or `~/.config/palm/search/config.json` with `gscKeyPath`, `bingKeyPath`, `site` and `indexnow: {host, key, keyLocation}`.

## Image desk

`palm design` turns a [Quick Design](https://www.yuzool.com/quick-design/) design into the files you post, using Quick Design's own drawing and layout code in your Chrome. The design and the files stay on your machine.

```
palm design templates sale                     templates (free ones list their text fields)
palm design fill "Yard Sale" p1e1="PORCH" --out design.json    a free template with your text
palm design render design.json                 PNG per page + sheet.png at phone size, measured (free)
palm design sizes design.json --for social,vertical   every platform size laid out again and checked (Pro)
palm design video design.json --for reel,tiktok       MP4 of its entrance animations + cover (Pro)
palm design batch design.json rows.csv --for instagram   one design per row (Pro)
palm design-mcp                                the same as a local MCP server (claude mcp add palm-design -- npx -y github:pearcoderman/palm-cli design-mcp)
```

Each size is checked where it's seen: text under the app's buttons and caption (safe zones; `--ads` for ad zones), text too small at the width the app shows it, split words, text off the page, letters drawn over letters, file-size limits. Every run writes `sheet.png` (look at it) and `manifest.json` (files, sizes, alt text, issues) for a scheduler. A design is Quick Design's JSON format (https://www.yuzool.com/quick-design/design-format/) or a Quick Design link. Needs Chrome and `puppeteer-core` (`palm doctor`).

## Invoice desk

`palm invoice` makes an invoice your client opens and pays from a link, keeps a ledger, and drafts reminders when it's late. Palm never sends email: every message is a draft you read and send.

```
palm invoice make invoice.json         check it, total it, and make the client's link (Yuzool Invoice's viewer; the invoice
                                       is inside the link), a PDF and an email draft (free)
palm invoice list                      open, overdue and paid; what's owed per currency (Pro)
palm invoice paid INV-0007             mark paid (Pro)
palm invoice chase                     today's reminder drafts: 3 days before, on the day, 7, 14, 30 days late, each once (Pro)
palm invoice schedule --hour 9         draft them every morning with a notification (Mac; prints a cron line elsewhere) (Pro)
palm proposal make proposal.json       a proposal the client reads and accepts from a link, a PDF to sign, an email draft (free)
palm proposal accepted P-0001 --options "Social templates"   its payment schedule becomes invoices (Pro)
palm invoice send INV-0002             a milestone invoice goes out (Pro)
palm invoice-mcp                       the same as a local MCP server (claude mcp add palm-invoice -- npx -y github:pearcoderman/palm-cli invoice-mcp)
```

`invoice.json`, prices in normal money: `{"currency":"GBP","terms":14,"from":{"name":"Hollow Oak Studio","email":"…","payLink":"https://paypal.me/…"},"to":{"name":"Riverside Bakery","contact":"Sam","email":"…"},"lines":[{"desc":"Logo design","qty":1,"price":450}],"taxRate":20,"taxName":"VAT"}`. The ledger stays at `~/.config/palm/invoice/ledger.json`.

## Outreach desk (Pro)

`palm outreach` runs short personal email sequences as drafts you send from your own mailbox. Palm never sends email.

```
palm outreach import contacts.csv --list cafes --basis legitimate-interest   contacts, with why you may write to them
palm outreach sequence cafes.json         2–5 short emails, days apart, with {{first|there}}-style merge fields
palm outreach start cafes --list cafes    enrol the list
palm outreach today                       today's drafts (.eml + mailto), within the daily cap
palm outreach replied sam@example.com     stops their sequence (unsubscribed / bounced: never written to again)
palm outreach status                      people, due, replied (rate), unsubscribed, bounced, finished
palm outreach-mcp                         the same as a local MCP server (claude mcp add palm-outreach -- npx -y github:pearcoderman/palm-cli outreach-mcp)
```

Every email ends with your name, your postal address and an unsubscribe line. State: `~/.config/palm/outreach/state.json`.

## Social desk

`palm social` checks the week's posts, then hands them to the scheduler you already use, through its own public API with your own key: **Postiz** (cloud or self-hosted) or **Buffer**, or straight to **Bluesky** with an app password. Palm doesn't run a scheduler: platform approvals, token refresh, retries and the queue stay the scheduler's.

```
palm social connect postiz [--url https://your-postiz]   key from POSTIZ_API_KEY, else asked for without showing it
palm social connect buffer [--org <id>]           a personal key (publish.buffer.com/settings/api) or BUFFER_API_KEY
palm social connect bluesky --handle you.bsky.social     an app password, never your main one
palm social channels                             connected channels: the ids and names to use in "to"
palm social check post.json                      every post against its platform's limits (free)
palm social queue post.json                      dry run: exactly what would go where and when (Pro)
palm social queue post.json --confirm            drafts in your scheduler (Pro)
palm social queue post.json --schedule --confirm into its queue at each post's time (Pro)
palm social queue post.json --now --confirm      post now (the only way to post to Bluesky directly) (Pro)
palm social list                                 what Palm queued, and your scheduler's drafts and queue (Pro)
palm social-mcp                                  the same as a local MCP server (claude mcp add palm-social -- npx -y github:pearcoderman/palm-cli social-mcp)
```

`post.json`: `{"timeZone":"Europe/London","when":"2026-12-01 09:30","link":"https://…","images":[{"file":"01.jpg","alt":"…","url":"https://… (Buffer needs a public URL)"}],"posts":[{"to":"linkedin","text":"…"},{"to":"postiz:x","text":"…","when":"2026-12-01 12:00"}]}`. `check` measures each post the way its platform does (X's weighted count, Bluesky's graphemes, the scheduler's own limit), the images (count, file size, shape, minimum size), alt text on every image, the link and the time (an explicit time zone; past, missing or doubled times), and runs Palm's `multi-image-check` and `share-preview` when they're on your machine. It reports problems and changes nothing. Nothing leaves your machine without `--confirm`; posts go in as drafts unless you say `--schedule`; never "now" unless `--now --confirm`. What was queued is kept in `~/.config/palm/social/ledger.json`, so running it again never queues a post twice. Keys stay in `~/.config/palm/social/` (only you can read them) and are never printed.

## The weekly brief (Pro)

`palm brief` puts the week across every desk on one page, with a one-line summary ("3 things need you: 1 site problem, 2 overdue invoices") and what to do today at the top: problems Palm Watch found on your pages, new and unanswered App Store reviews and your ratings, Search Console clicks, impressions and top query positions, money owed, overdue and due this week, proposals waiting, reminders due, outreach due and replies. A desk that isn't set up says so in one line (and how to connect it); the rest still runs.

Week over week: each run keeps a small snapshot of its numbers in `~/.config/palm/brief/snapshots/YYYY-MM-DD.json`, and each part says what changed since last week's run ("2 new problems on example.com (1 → 3)", `"menu ideas" 8.2 → 5.1`, "Overdue invoices: 1 → 2"). The brief only reads: it drafts, marks and sends nothing (Palm Watch is read with `list`, so `palm watch report` still shows its news).

What Palm did for you: under the summary, one line of results this month ("This month with Palm: 3 invoices paid after reminders (£1,840.00) · 2 site problems caught and fixed (seen in the weekly checks) · 12 posts queued (Buffer 12)"), and last month's on the first brief of a month, counted only from your own local records (invoices the ledger marks paid, with a reminder drafted on or before that day; accepted proposals; Palm Watch problems that went down between the weekly checks; posts in the social ledger; outreach drafts and replies; App Store reply drafts), never estimated; lines with nothing in them are left out, and so is the whole section when there's nothing.

- `palm brief --save` writes `~/Documents/Palm/Brief/YYYY-MM-DD.md` and a self-contained `.html` page, plus `latest.md` / `latest.html`.
- `--email-draft [to]` also writes an unsent `.eml` (X-Unsent: 1); Palm never sends it. `--notify` shows a Mac notification with the summary.
- `palm brief schedule [--day mon] [--time 09:00] [--email-draft [to]]` does all that every week on a Mac (a LaunchAgent; Monday 09:00 by default; elsewhere it prints a cron line); `--off` stops it. The job can't see your shell's environment, so save the Palm key with `palm login`, and keep App Store and search settings in their config files (the command warns if they're only in environment variables).

## PDF desk

`palm pdf` runs Yuzool PDF Tools' and Redact's own code in your Chrome; your files never leave your machine.

```
palm pdf merge a.pdf b.pdf scan.jpg --out merged.pdf      merge (also extract, split, rotate, compress, info) (free)
palm pdf password add contract.pdf --no-copy              AES-256, checked after; password remove too (free)
palm pdf redact statement.pdf --find emails,phones,iban   black it out, then the saved file is searched again: nothing saved unless it's really gone (Pro)
palm pdf sign request contract.pdf --signer "Sam Patel <sam@example.com>" --from "Alex <alex@example.com>"   they sign at yuzool.com/sign (Pro)
palm pdf sign check signed.pdf --original contract.pdf    who signed, and is it still the document you sent (Pro)
```

## Passport photo desk

`palm passport` runs Yuzool Passport Photo's rules (43 documents, each from its official page, dated) and its face finder in your Chrome; the photo never leaves your machine.

```
palm passport docs japan                                  documents, sizes and rules with their sources (free)
palm passport make me.jpg --doc uk-passport --paper 4x6   the photo at size (300 dpi), the checks, a print sheet, the digital file (free)
palm passport make a.jpg b.jpg --docs uk-passport,us-passport   several people on one sheet (Pro)
```

The checks are advice against the published rules: the office that takes the photo decides.

## Pages desk

`palm pages` makes a page that's live the moment its link exists (Link in Bio, Website Maker, Business Card and Menu Maker pages travel inside their own link; nothing is uploaded), checked with each app's own code and looked at on a phone, plus QR codes that are decoded at their printed size before they're called done.

```
palm pages example --kind card > card.json                a page to start from (link-in-bio, website, card, menu)
palm pages make card.json --kind card                     the link, phone and desktop screenshots, every link checked (free)
palm pages qr https://example.com --size 25mm             a QR at 300 dpi, decoded at that size (free)
palm pages cards team.csv --qr-size 25mm                  a business card per row, each checked (Pro)
```

The page is public to anyone who has its link.
