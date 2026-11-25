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
| `palm outreach …` | Short personal email sequences, drafted daily within a cap (Pro). |
| `palm asc …` · `palm search …` | App Store Connect and search (Search Console, Bing, IndexNow) desks, with your own keys (Pro). |
| `palm <desk>-mcp` | Any desk as a local MCP server: `asc-mcp`, `search-mcp`, `design-mcp`, `invoice-mcp`, `outreach-mcp`. |
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

## The weekly brief (Pro)

`palm brief` puts the week across every desk on one page, with what to do today at the top: money owed and overdue, proposals waiting, reminders due, outreach due and replies, unanswered App Store reviews and sales, search clicks and pages that lost them, and anything Palm Watch found. Each part appears only when that desk is set up. `palm brief --save` writes `~/Documents/Palm/brief-YYYY-MM-DD.md`; `palm brief schedule --day mon --hour 9` does that every week on a Mac with a notification.
