# All Anime Watcher (AAW)

An MV3 browser extension that follows anime and donghua across streaming sites:
detect an episode page, auto-add the series, poll for new episodes, notify, and
(from phase 2) play it in one consistent in-page player.

It is the anime counterpart of **All Mangas Reader** (`~/programming/all-mangas-reader-2`,
branch `manifestv3`). AAW is a fresh codebase that ports AMR's *architecture*, not
its code: same instincts about detection, injection, update scheduling and rate
limiting, without AMR's EOL Vue 2 / Vuetify 2 / Vuex 3 stack or its manga-shaped
data model.

Design doc: <https://claude.ai/code/artifact/34d7f865-1d51-40d0-a5d8-7e9f21e024b1>

## Commands

The system node (`/usr/bin/node`, v26) runs everything here — build, typecheck
and probe all verified on it. **No `nvm` dance is needed for this project**, so
just call npm directly:

```
npm run build              # both passes + dist validation → dist/
npm run check              # validate dist/ alone
npm run check:schedule     # the schedule date maths
npm run check:matching     # AniList title matching rules (offline)
npm run check:myanime      # myanime.live identity parsing (offline)
npm run check:grouping     # one-show-many-sources grouping rules (offline)
npm run check:m3u8         # which hosts a playlist refers to (offline)
npm run typecheck          # vue-tsc, must stay clean
npm run probe -- lmanime   # run a source against the live site
PROBE_SERVER=3 npm run probe -- lmanime   # exercise one video host
```

(AMR next door is different: its `engines` field pins node 18/20, so that repo
still needs `fish -c "nvm use 20.20.1; …"`. Don't carry that habit over here.)

`dist/` is loaded unpacked in the browser. **The user builds and tests; don't run
builds repeatedly just to re-read output.**

## Committing

A husky `pre-commit` hook (`.husky/pre-commit`) runs, in order: `lint-staged`
(prettier over the staged files), `typecheck`, `check:all`, then
`scripts/bump-version.mjs`. About four seconds.

**The patch version moves on every commit, and that is the point.** The manifest
takes its version from `package.json`, so it is what chrome://extensions shows —
which makes it the only cheap answer to "is the browser running the build I just
made?" A whole debugging session has been lost to that question. The bump is
skipped during a merge, rebase or cherry-pick, when the version was already
changed by hand, and under `SKIP_BUMP=1`; `git commit --no-verify` skips the lot.

Prose and `package-lock.json` are in `.prettierignore` on purpose — see the file
for why. Note that typecheck and the check suites read the *working tree*, not
the staged content, so with unstaged work in flight they answer a slightly
different question than "is this commit sound".

## Two build passes, on purpose

- `vite.config.ts` — extension pages (Vue, HTML entries) and the background
  service worker, as ES modules. The SW is declared `type: module` so shared
  chunks resolve.
- `vite.content.config.ts` — the injected content script, as a single IIFE.
  `scripting.executeScript({ files })` loads a **classic** script: no `import`,
  no shared chunks. Keep this bundle small.

`npm run build` runs both, then `scripts/check-dist.mjs`. The second pass sets
`emptyOutDir: false`, so order matters.

**Library mode is not the app build.** Vite substitutes `process.env.NODE_ENV`
automatically in an app build but *not* in library mode, and Vue's runtime is
full of `process.env.NODE_ENV !== "production"` guards — without an explicit
`define` the content bundle throws `process is not defined` on its first line.
Any dependency added to the content bundle needs the same consideration.

**`check-dist.mjs` exists because Chrome rejects a whole extension for things a
bundler is happy with.** It asserts every path the manifest references was actually
emitted, that `default_locale` has a matching `_locales` subtree, that permissions
are strings Chrome knows, and that `content.js` carries no `import`/`export` (a
code-split content bundle builds fine and then fails at injection). It exits
non-zero, so a bad manifest fails the build. Add a check here whenever a load
error gets past it.

There is no i18n yet — `default_locale` and `_locales/` are deliberately absent
until strings are extracted. When that happens it needs `_locales/{en,es}`, an
`i18n()` helper, and the locale directory copied in the vite plugin.

## Architecture rules

These are load-bearing. Breaking one costs a rewrite later.

1. **Identity never comes from a URL.** The library key is
   `${sourceId}/${seriesId}` and an episode is identified by its float `number`.
   `url` is a navigation payload and is freely rewritten (domain moves, URL
   scheme changes). This is the single biggest departure from AMR, which keys on
   chapter URLs and needs `chapPath` + `findProbableChapter` to survive.
2. **Sources never see a DOM.** HTML arrives as a string and is parsed with
   cheerio in the background. The content script's only job is to hand over
   `document.documentElement.outerHTML` and render UI.
3. **Import `cheerio/slim`**, never bare `cheerio` — the default entry drags in
   `undici` and `node:stream`.
4. **Never `.test()` a source's `episodeUrl` directly.** A `/g` regex keeps
   `lastIndex` between calls and will intermittently return false for the same
   input. Use `matchEpisodeUrl()` from `sources/registry.ts`.
5. **All settings read through `resolve()`** (`settings/resolver.ts`), which walks
   per-anime → per-source → global. Reaching for the global object directly
   silently breaks per-anime overrides. See "Nothing hardcoded" below.
6. **No visible tabs to scrape.** Reverse-engineer the site's API or parse its
   server-rendered HTML. A tab is a Cloudflare last resort only — the same rule
   as AMR.
7. **No device sync.** The library lives on one machine; moving it is an
   export/import. Don't add merge clocks.
8. **Register listeners synchronously at the top level** of the service worker. A
   listener added after an `await` misses the event that woke the worker.
9. **Pure logic never lives in a module that imports transport.** Anything
   importing `webextension-polyfill`, `~/model/db` or `~/shared/messages` can only
   run inside an extension, so a scoring function or a date calculation sitting
   beside one can never be tested. This has bitten three times — `schedule.ts`,
   `trackers/matching.ts`, `shared/vtt.ts` — each time discovered by trying to
   write the test. Split first: rules in a pure module, storage and messaging in
   the caller.
10. **A synchronous cache with a default fallback must never be left empty.**
    `cachedSettings()` returns `cache ?? defaultSettings()`, so "invalidate the
    cache" and "revert every setting to its default" were the same statement.
    Every setting silently reset itself the moment any setting was changed, and
    it looked from the outside like one toggle being ignored. Storage change
    events carry `newValue`; *replace* the cache from it in the same tick rather
    than nulling it and hoping something re-reads in time.
11. **A default must never assert something about the user's history.** Settings
    are stored whole and merged *over* `defaultSettings()`, so any default is
    also what every older profile is told about itself. `seededCategories`
    defaulted to every built-in shelf's id — which said "all of these have
    already been offered" to profiles that predated the shelves and could
    therefore never be offered them. The pure rules (`unseededCategories`) were
    correct and tested throughout; the fault was one line of default data, which
    is invisible from inside the module that reads it. Defaults for
    "what has happened" start empty; `offeredCategories` records the fact at the
    moment it becomes true (saving the shelf list) instead. Same family as rule
    10: a stand-in value quietly answering a question about real state.

    **And changing the default does not repair the profiles that already stored
    it.** `patchSettings` writes the whole merged object, so the first write of
    *any* setting — a sort order, a filter — persisted the wrong claim into
    storage, where no later default can reach it. A fix of this shape needs a
    one-off repair recorded in `settings.migrations`; here that is
    `repairOfferedCategories` in `background/index.ts`. Shipping only the new
    default looks right, tests green, and changes nothing on the user's machine.

## Nothing hardcoded

Every behaviour that decides something on the user's behalf needs an override at
the anime level, defaulting through the source level to a global. This is an
explicit user requirement, not a nice-to-have: schedule policy, server order,
quality, sub/dub, subtitle language, skip intro/outro, auto-advance, completion
threshold, page takeover, tracker push, notifications, download naming.

Add the override in the same commit as the feature. `AnimeOverrides` in
`model/types.ts`, `SourceSettings` + `GlobalSettings` in `settings/schema.ts`.

## Layout

```
src/
  manifest.config.ts     manifest, emitted by the vite plugin
  background/            service worker: router, navigation, handlers, badge
  content/               injected script (small, IIFE, no cheerio)
  model/                 types, key helpers, IndexedDB
  library/               add / refresh / flags — the library service
  settings/              schema, storage, three-level resolver
  sources/               the site plugin layer
    types.ts             AnimeSource contract
    families/            config-driven bases (AnimeStream = the anime Madara)
    sites/               one file per site, usually just a config object
  extractors/            embed URL → playable streams (shared across sources)
  net/                   fetch with the escalation ladder behind one interface
  ui/popup/              Vue 3, no UI framework
scripts/probe-source.mts the CLI Lab page
```

## Adding a source

1. Check whether the site runs a known theme. `AnimeStream` (WordPress) already
   covers lmanime; `ZoroTheme` (HiAnime clones) is the other big family. If so it
   is a config object in `sources/sites/` and nothing more.
2. Otherwise implement `AnimeSource` directly; copy the closest existing site.
3. Register it in `sources/registry.ts`.
4. `npm run probe -- <id>` until every check passes. Add `VERBOSE=1` for request logs.
5. Prior art for a site's real data path:
   `github.com/Kohi-den/extensions-source` (Kotlin, Aniyomi). Browse with
   `https://api.github.com/repos/Kohi-den/extensions-source/git/trees/main?recursive=1`.
   It documents endpoints and response shapes and saves days per site.

## Launch sources

| Site | Shape | Status |
| --- | --- | --- |
| lmanime.com | WordPress `animestream` theme | done — plays in the browser |
| mundodonghua.com | custom PHP, packed-JS server tabs | done — probe green |
| myanime.live | WordPress REST API; no series pages at all | done — probe green |
| anikototv.to | AnimeKai/AnimeSuge family, signed AJAX | done — probe green |
| luciferdonghua.in | the same `animestream` theme, added later | done — plays via OK.ru and Dailymotion |

All four launch sources are in, plus luciferdonghua.in, and the **Lab page** (Settings → Lab) tests one
end to end: pick a source, press Run, and six chained steps go from its declared
attributes through search, the episode list, an episode page, a server and the
extractor to a real fetch of the resulting stream. Each step hands its result to
the next, so nothing has to be pasted in; where there is a choice — which hit,
which episode, which server — it takes the obvious one and offers a picker to run
again from there. The judgements are pure (`src/lab/checks.ts`, `npm run
check:lab`); only the probes touch the network.

**myanime.live has no series identity to read**, which makes it the hardest of
the four and a useful template for sites like it. Each post is one episode, and
identity has to be reconstructed. In the order `getPageInfo` tries:

1. the **post slug**, minus its episode marker
   ("wan-jie-du-zun-…-episode-476-english-sub" → "wan-jie-du-zun-…");
2. the **post title**, same cut, which is where the display name comes from;
3. the post's **tags** — the original approach and the worst of the three: many
   posts carry none, and where they do the tag is as likely to name the
   protagonist ("Lin Feng") as the show.

The stored `seriesUrl` is a `/?s=` search page, with the series id pinned in the
fragment (`#aaw=…`) when the best query is broader than the series name — a
series retitled mid-run needs a broad query to find its older episodes and a
specific id to filter the results.

**Do not use the post's "All Episodes" button.** It links to `/?s=<query>` and
looks exactly like the site's own grouping — which is why a previous pass built
identity on it. It is an unfilled template field: *every* untitled post on the
site links to the same query, whichever show it belongs to. Building on it filed
several unrelated shows under one entry named after whatever the placeholder
happened to say.

**Some shows are simply not trackable here, and that is the answer.** The site
publishes a few with no title, no tag and a numeric slug — a rights-holder dodge.
For one of them, the actual show is *Primeval Overlord [Ancient God Sovereign]*,
which appears nowhere in the post: not the title, not the slug, not the tags, not
the featured image, not the body. Searching the REST API for the show's name, or
for the code in its *video* title (`POAGSs1ep11eng`), returns nothing — the code
lives on the video host, not in any WordPress field. So even a user-supplied name
would produce an entry that could never find its next episode. `getPageInfo`
throws with a message saying so, the same way it reports a missing tag. Do not
try to rescue these by grouping them on anything the page shares with other
untitled posts; everything they share is the placeholder.

**Anikoto's signing**, since this family is common: `vrf = base64(rc4("simple-hash", animeId))`.
The key and algorithm are both in the site's own `main.js`, which uses the same
routine to decode its `window.__cfg` blob — decoding that to valid JSON is how to
confirm the scheme on a sibling site rather than guess. Every `ajax/*` endpoint
answers with a `{status, result}` envelope; parsing the envelope as markup finds
nothing and looks exactly like a selector that broke, so unwrap first.

## Grouping

`library/grouping.ts` collapses a show carried by several sources into one row.
Pure, so `npm run check:grouping` can run the rules over a pile of titles.

**The tracker id is the mechanism; the title is the fallback.** Two entries with
the same `anilistId` are the same show whatever their titles say, and two with
*different* ids are not the same show however alike they read. Titles only merge
above a deliberately high similarity (0.87) with a matching season number, which
catches "Xian Ni – Renegade Immortal" against "Xian Ni (Renegade Immortal)" and
nothing looser.

That threshold does *not* merge "Wan Jie Du Zun" with "Wan Jie Du Zun – Ten
Thousand Worlds", which are the same donghua under a shortened name. This is
deliberate. The failure of merging two different shows is silent and asymmetric —
one show's episode count appears to jump and the quieter entry's watch position
disappears behind the louder one's — while failing to merge just looks like the
library did before. A prefix rule was tried and rejected: it cannot tell a
subtitle from a different series. Both entries acquire an AniList id on add, and
the group forms then.

Matching compares **source** titles, never `displayTitle`. Renaming a series is a
display preference, and matching on it split a renamed entry out of its own
group.

Aggregates are across sources by design: position is the *furthest* episode
reached anywhere, so watching 40 on one site and 41 on another is being at 41,
and the watch button opens whichever source actually carries the next episode.

## Domains and trackers

**Domain resolution** (`background/domains.ts`) reads a source's `domainSource`
announcement page, keeps hosts whose registrable name shares a brand token with a
known domain, health-checks them (2xx *and* the body mentions the brand — a
parked domain returns 200 too), and promotes the first that answers. A user's
pinned domain always wins.

This is cheap only because identity never comes from a URL: a move rewrites
navigation links and touches nothing about what was watched. Verified against
anikoto.site, which lists five live domains alongside Google Fonts, Telegram and
Reddit links — the token test keeps the five and drops the rest.

**AniList** (`trackers/`) is read-only and needs no sign-in. `matching.ts` is pure
— no storage, no settings — so the scoring rules are testable; `match.ts` holds
the parts that touch IndexedDB. Two rules earn their keep:

- The **search query** is cleaned but the **score** is not. AniList returns
  nothing for "… Season 05" and everything for the same title without it, so the
  season marker comes out of the query — and goes back into scoring, where a
  season mismatch is capped below the auto-link threshold. Season 5 linking
  silently to season 1 would attach the wrong air schedule with nothing in the UI
  to suggest it.
- Auto-linking needs 0.9 confidence. Below that the series stays unmatched and
  visibly so, which is far better than a confidently wrong poster.

Air times feed the `airing` schedule policy. No data, or a date already past the
pad window, degrades to the fallback interval rather than never checking.

## UI surfaces

The popup is the compact view; **the full library page (`src/ui/library/`) is the
one the user actually lives in** — that's how they use AMR. Both render the same
`ui/components/LibraryList.vue` with a `variant` prop, so a feature added to one
appears in the other. `openInTab` swaps the toolbar button to open the page
directly; Chrome only fires `action.onClicked` when there is no popup, so the
popup has to be *cleared* via `action.setPopup({ popup: "" })`, not just ignored.

Watch state (`watchState()` in `model/keys.ts`) drives the row stripe: `new`,
`current`, `unstarted`, `paused`. Colour is never the only signal — the pill and
the button label say the same thing.

A row shows **one** action button (the watch button); everything else lives in
its `⋯` menu, and destructive actions go behind a `ConfirmDialog`. A row of six
buttons stops being scannable the moment the library is real, and Remove should
never sit next to Refresh.

**Testing notifications is awkward and there is no shortcut, so do not go looking
for one.** You cannot make a site publish an episode, and **nothing in the UI
drops the top of the stored episode list** — an earlier version of this file
claimed a “Forget newest episode” item in the ⋯ menu, which has never existed in
the shipping build and cost a debugging session to disprove. What is actually
there: “Check every series now” (the ⟳ in the library header), “Refresh episode
list” and “Reset watch status” per row, an “Episodes…” panel that sets the
position by hand, and a plain test notification in Settings for the OS-level
plumbing. None of them fabricates a release.

To exercise the *release* path end to end you need a series that genuinely has
something new, which mostly means waiting. The **pending** path is the easier one
to test deliberately, because a placeholder sits on the live site for days at a
time: find a series whose newest post has a countdown, then “Refresh episode
list” on its row and read the log line — it names the episodes it held back.

**Do not add an affordance to this file before it exists in `src/`.** Everything
here is read as fact by whoever picks the project up next.

## Extractors and video hosts

An extractor turns one embed URL into playable streams and is shared by every
source that embeds that host. `Stream.fetchVia` decides how the player fetches:

- `page` — the `<video>` element or hls.js fetches directly. Cheapest. Works when
  the host tolerates the page's origin. Mp4Upload, OK.ru and StreamWish are this.
- `background` — every manifest and segment is proxied through the service
  worker via `playback:fetch`. Required, not preferred, when a CDN sends no
  usable `access-control-allow-origin` or demands a Referer the page can't forge.
  Dailymotion is this.
- `iframe` — **no extraction at all**: the host's own player runs in a frame
  inside our chrome. Produced by `playback:streams` when no extractor matches, or
  when one matches and fails. It is the failure state, not a supported mode: the
  viewer gets the host's ads, its controls and its quality picker instead of ours,
  no resume position, no skip intro/outro, no subtitle handling, no quality
  preference, no PiP, no keyboard shortcuts, and no download. It exists so an
  unrecognised host degrades instead of dead-ending, and the player walks every
  server before it embeds.

  **Extraction is the point of this extension.** A host falling back to an iframe
  is a bug with an address, and "it still embeds" is never the answer to one. If
  an extracted stream will not play, fix the extractor — `fetchVia: "background"`
  and a DNR `Referer` rule exist precisely so that a CDN which refuses the page
  can still be played by us.

`Referer` and `Origin` are forbidden header names — `fetch()` silently refuses to
set them — so an extractor declares `netRules` and `background/dnr.ts` installs
declarativeNetRequest rules. `appliesTo: "page"` scopes a rule to requests our
taken-over pages make (a `<video src>`), `"extension"` to the proxy's own.

The player falls through to the next server automatically when one fails, so a
dead host degrades instead of dead-ending. Failures that are part of that walk
(no extractor for a host, a dead server) throw `ExpectedError` so the router logs
them at debug — a fallback chain must not fill the console with stack traces.

**Chrome JSON-serialises extension messages.** An `ArrayBuffer` sent through
`runtime.sendMessage` arrives as `{}` — it does *not* structured-clone, whatever
the MDN page for the standard API says. The playback proxy therefore base64s
binary payloads (`shared/binary.ts`), at 33% transfer overhead. This cost a real
debugging session: empty fragments reach hls.js as `fragParsingError`, which
reads like a codec problem and is actually a transport one. Anything else that
moves bytes across the message boundary needs the same treatment.

A plain `<video src>` is a media load, not a fetch, so it is **not subject to
CORS**. That is why direct-file hosts (Mp4Upload, OK.ru) work with
`fetchVia: "page"` and only need a DNR Referer rule, while hls.js — which fetches
manifests and segments with XHR — needs the proxy whenever a CDN withholds
`access-control-allow-origin`.

**Video hosts seen so far.** `PROBE_SERVER=<n> npm run probe -- <source>`
exercises one at a time.

| Host | Extractor | State |
| --- | --- | --- |
| mp4upload.com | `mp4upload` | works — direct MP4, played in the browser |
| ok.ru | `okru` | works — direct MP4 at several renditions |
| streamwish family | `streamwish` | works — covers embedwish, vidhidepro, morencius, FileLions, VidHide, luluvdo |
| bysekoze.com | `byse` | works — AES-256-GCM player config from `/api/videos/<code>`; pinned by `npm run check:extractors` |
| megaplay family | `megaplay` | works — HLS + subtitles; covers megaplay.buzz, vidtube.site and the rest of the white-labelled engine |
| dailymotion.com | `dailymotion` | resolves to a master playlist; the manifest 403s intermittently — see below |
| voe.sx, rumble.com, youtube.com | — | embedded via the iframe fallback |

**MegaPlay** is two requests and no obfuscation: the embed page carries a
`data-id` that is *not* the id in the URL, and `/stream/getSources?id=<data-id>`
answers with the m3u8, the subtitle tracks and intro/outro offsets. Its CDN
hostname rotates, so the Referer it demands is declared on the `Stream` and
`background/dnr.ts` installs a rule for that host at playback time — see
`ensureRefererRule`. Subtitle hosts need the same treatment and are a different
domain from the video.

**A DNR rule has to cover every host in the chain, and there are more than one.**
An HLS manifest is not one host: MegaPlay serves the manifest from
`cdn.watching.onl` and every segment from `cr0x1.cloudvideo.lat`, both
Referer-gated. A rewrite installed for the URL the extractor returned gets the
manifest and none of the video, and the symptom is *not* an error — hls.js
retries a failing segment long enough that it reads as buffering that never ends.
`coverPlaylistHosts` walks the playlist two levels deep (master → variant →
segments) and installs a rule for every host it names, including the ones hidden
in `URI="…"` attributes: the decryption key, alternate audio, subtitle
renditions. Missing the key means an encrypted stream that never plays.

**A DNR rule also has to name the right initiator, and there are two.** The proxy's
fetches come from the extension; hls.js loads manifests and segments straight
from the page we took over unless the extractor asked for the proxy. Scoping a
rule to `initiatorDomains: [extensionId()]` therefore covers the extractor's own
requests and *not* the playback that follows, which is a 403 that looks exactly
like a dead server. Runtime rules now list both, including domains discovered
after a source moved. The player also escalates once to the proxy on a fatal HLS
error before writing a server off, so a rewrite that fails to reach a page
request degrades to slow rather than broken.

**Dailymotion's 403 is not a header problem.** Both a token-shaped explanation
and a header-shaped one fit some of the evidence, which is why it keeps getting
misdiagnosed — an earlier pass concluded `Accept-Encoding` and shipped a DNR
removal rule for it. Measuring one variant per attempt with a *fresh* `sec=`
token each time, four attempts each:

| Sent with the manifest request | Result |
| --- | --- |
| Referer only | 403, 403, **200**, 403 |
| Referer + `Accept-Encoding: gzip, deflate, br` | 403, 403, 403, 403 |
| Referer + `Origin: https://www.dailymotion.com` | 403, **200**, 403, **200** |

Two variants both pass and fail with identical headers, so no header set is
sufficient and the token is the dominant variable. The loose end: the
`Accept-Encoding` row never succeeded. 0/4 against 1/4 is far short of a signal,
and the *best*-performing row carries an `Origin` the header theory says should
hurt — but it is the reason to re-measure rather than assume, if this is ever
worth another look. Do not add header rules for this without a repeat-measured
result; a single 200 proves nothing here.

In practice the player falls through to the next server on a fatal HLS error,
which is why lmanime and myanime still play.

**Sources:** `lmanime` (AnimeStream theme), `mundodonghua` (custom PHP, packed-JS
servers), `myanime` (WordPress REST API, no series pages), `anikoto` (AnimeKai
family, signed AJAX, embeds on the MegaPlay engine), `luciferdonghua`
(AnimeStream theme again, but with series under `/anime/` — see below).

**luciferdonghua.in is the second `animestream` site, and it is where two of the
family's defaults turned out to be lmanime's habits rather than the theme's.**
Both are now config, so lmanime is untouched:

- **Its episode slug does not stem to its series slug**, and almost never does:
  `perfect-world-wanmei-shijie-episode-284-…` lives under
  `/anime/perfect-world-new/`, and `coiling-dragon-episode-18-to-20-…` under
  `/anime/coiling-dragon-2026/`. Slug arithmetic yields a plausible id that names
  no series — the duplicate-entry fault that never updates. A site may now declare
  `seriesUrl`; where it does, `seriesIdFromUrl` returns null for anything else and
  identity comes from `getPageInfo`'s breadcrumb, which is authoritative here.
  lmanime declares no `seriesUrl` (series sit at the root, indistinguishable from
  `/genres/`) and keeps the old best-guess behaviour.
- **The theme's bare `iframe[src]` picks up an ad.** This site injects `t.co`
  iframes in `div.megavid`, above the player, so `resolveServer` returned a link
  shortener and the probe reported it as a missing extractor. The `playerIframe`
  selector defaults to the old behaviour; this site sets
  `div.player-embed > iframe[src]`. Its Dailymotion server has no iframe at all
  and still falls through to `meta[itemprop=embedUrl]`.

## Posted, but not out

**A site can publish an episode's page before it has the episode.** luciferdonghua.in
does: Ancient God Sovereign E13 went up as a normal post with a `tickcounter.com`
countdown widget where the player goes, and five servers in `select.mirror` that
each resolved to nothing. It was announced as a release, the notification opened
a dead page, and the watch position had already moved onto it on the way in — so
the real E13 would never have shown as unwatched when it aired.

**Nothing on the series page distinguishes it**, which is the whole difficulty:
the update loop reads only the series page, and the placeholder's `<li>` is
byte-for-byte the same shape as a real one — same `epl-num` ("13 [4K]"), same
`epl-title`, same `status Sub`. The only tell there is that the post is
*backdated* (E13 dated July 1 against E01-04's July 30), so it sorts to the
bottom of `div.eplister` below episode 1. **Do not build on that.** An
out-of-order date is also what a corrected typo or a late re-upload looks like,
and reading it as "premium" would suppress real episodes. It is worth knowing as
a symptom and is not evidence.

The evidence is on the episode page, so `refreshSeries` opens it — one request
per *candidate*, not per episode, decided by `verificationCandidates`.

**`verifyNewEpisodes` is off by default and that is deliberate.** It is a request
per candidate on top of the series page, and a library of several hundred
followed series pays that on every check run — real weight, for a habit only some
sites have. It is opt-in per source and per series, which is the level the fact
belongs at: luciferdonghua.in posts ahead, lmanime does not.

**Which candidates is the part that was got wrong first, and it is worth knowing
why.** The obvious answer — "the episodes about to be announced, plus the ones
already flagged pending" — fixed nothing on the machine that reported the bug. A
library that already holds the placeholder holds it as an *ordinary* episode: it
is not in the diff, because nothing about the list changed, and it carries no
flag, because no code had ever looked. Both clauses came back empty and the
countdown stayed the newest episode. The feature worked perfectly on libraries
that did not have the problem. That is rule 11's shape again — new behaviour that
cannot reach the state already on disk — and the fix is a third clause: sweep the
newest few episodes nobody has ever asked about. `Episode.available` is what
stops the sweep repeating; **absent means unknown, not fine**, which is the whole
reason availability is tri-state rather than a boolean.
`AnimeSource.episodeAvailability(html, url)` is optional and answers from markup
already in hand; `AnimeStream` implements it from a per-site `pending` config
(`markers`, `text`, `reason`). Three rules hold it together:

- **An embed wins outright, checked before any marker.** A site is free to run a
  countdown to the *next* episode above a player that works, and suppressing the
  episode the viewer is on would be worse than the bug. The marker is only
  consulted once the player container has no iframe and the page no
  `meta[itemprop=embedUrl]`.
- **Requiring both is what makes a broken selector safe.** An empty player
  container is suggestive but not conclusive — a theme change looks identical —
  so something has to positively say "not yet". Every failure path (no opinion,
  setting off, fetch timeout, parse throw) leaves the episode *announced*. The
  two mistakes are not symmetrical: announcing a countdown is a notification you
  dismiss, suppressing a real episode is one you never learn you missed. That is
  also why `pending` is opt-in per site and `lmanime` declares nothing.
- **The placeholder is remembered, not dropped.** Dropping it would make the
  episode new again on every check. Stored with `Episode.pending`, it is known —
  so the diff stays quiet — while `latestEpisodeNumber`, `unwatchedCount`,
  `nextEpisode`, `latestEpisode` and `watchState` all skip it via `watchable()`.
  One predicate on purpose: getting it wrong in one place only is silent and
  specific (the badge lights, "watch next" opens a dead page).

**Suppressing the countdown must not suppress the release, and that needs a
second rule.** A placeholder is in the stored list from the first check that saw
it, so when the video finally goes up it is *not* in the diff — nothing about the
list changed. `wentLive(previous, current)` reads that transition instead, by
`progressKey` rather than array position, because the list is refetched whole and
this site reorders it. Without it the placeholder would absorb the one
announcement the episode was ever going to get.

**And the watch position moved before anything was known to be playable.** That
is a second bug with the same root: `markWatchedOnOpen` fired when the page was
*read*, which is before any server had been resolved. The signal is kept and its
timing moved — `onOpenMark` (pure, in `settings/watching.ts`) answers `never` /
`now` / `whenPlaying`, and where our player is taking the page over the mark is
handed to it and spent at the first frame (`markOnScreen`, at the three points
where `status` becomes `ready`). Every server failing with no embed to fall back
on therefore records nothing.

**This is not a setting, and an attempt to make it one was removed.** Waiting for
a picture is not a preference — it is the difference between recording a fact and
recording a guess, and nobody wants the guess. It is also why the rule takes two
inputs and has no special cases: a page with no servers, a page that is a
countdown, and five servers that all resolve to nothing each reach the same place
on their own, because none of them ever attaches anything. With `takeOverPage`
off the answer is still `now` — nothing of ours attaches to the site's own
player, so no later moment is coming and the page read is the only signal there
will ever be, exactly as `markWatchedOnEmbed` already says.

**Reaching it at all three levels took UI that did not exist.** Before this there
was no per-source settings editor at all (SourcesPanel was domain management
only) and the per-anime menu exposed nothing but Schedule, so the resolver chain
was real and unreachable — a setting can be "per source and per series" in
`resolve()` and still be settable nowhere. Now: Settings for the global, Sources
for per-site, and a series' ⋯ → "Tracking…" for per-show, each a three-way
Default/On/Off. `library:setOverrides` and `sources:setSettings` are
generic patch writers — **`null` clears a key**, because Chrome JSON-serialises
messages and an `undefined` field simply vanishes, which reads as "leave it
alone" and makes "inherit" unreachable once anything has been written.

`npm run check:episodes` covers the rules; `npm run check:pending` covers
reaching the verdict, against reduced fixtures of the three states the player
container was observed in.

**A non-browser User-Agent is the probe's *other* blind spot, and it points the
opposite way.** The documented one is the CLI being too strong — Node can set a
`Referer` a browser cannot. Node's default `User-Agent` is the same blind spot
reversed: luluvdo's CDN 403s it and serves a browser UA, 3/3 each way with a
fresh token and no `Referer` or `Origin` involved. `scripts/probe-source.mts`
now sends a browser UA from `browserHeaders()` for exactly this reason. A netRule
would have been the wrong fix twice over: Chrome does not let an extension set a
UA, and the real one is already browser-shaped.

**Some CDNs bind a signed URL to the `Accept-Language` of the request that
minted it.** luluvdo (StreamWish family, served from `tnmr.org`) does exactly
that. Stating it precisely matters, because three wrong theories fit the symptom
first. Measured 3/3 per cell, and perfectly deterministic once *both* sides are
controlled:

| mint sends | spend sends | result |
| --- | --- | --- |
| `en-US,en;q=0.9` | the same | 200 |
| `en-US,en;q=0.9` | `es-ES,es;q=0.9,en;q=0.8` | 403 |
| `en-US,en;q=0.9` | nothing | 403 |
| nothing | nothing | 200 |
| nothing | `en-US,en;q=0.9` | 403 |

`Accept` is irrelevant, and so are Referer, Origin and Sec-Fetch: a Node-minted
token fails from a browser page *even on luluvdo's own origin*, while the token
luluvdo's own page mints for itself plays every segment at 200. The header
experiments looked random for an afternoon only because each attempt minted and
spent with different header sets — control both and the behaviour is stable. The
403 body carries no `access-control-allow-origin`, so the player sees
`TypeError: Failed to fetch` rather than a status, which reads like a dead host.

Extractors mint through `createFetchCtx`, which sends `BASE_HEADERS`, so anything
that later fetches that URL has to look the same. Two things follow:

- **`playback:fetch`, `lab:fetch` and `coverPlaylistHosts` all send
  `BASE_HEADERS`.** A bare fetch in the worker sends Chrome's own locale, which
  is a different client as far as the CDN is concerned. The proxy is the same
  client as the fetcher and has to look like it.
- **Such a stream has to be `fetchVia: "background"`.** The page cannot match —
  hls.js there sends Chrome's locale and nothing can rewrite `Accept-Language`
  per request from the page — so only the proxy can spend the token.
  `StreamWishExtractor.BOUND_TO_MINT_LANGUAGE` lists the hosts that need it; the
  rest of the family keeps the cheaper page fetch.

**This is also the one failure the Lab used to bless.** `lab:fetch` runs in the
worker, so a stream pinned to `fetchVia: "page"` was vouched for on a path
playback never takes — a green run and a dead server. `checkStreamReach` now
warns for every stream it fetched from the worker that the player will fetch from
the page, and the probe's `browserHeaders()` mirrors `BASE_HEADERS` so its own
mint and spend agree.

## Phase status

1. **done** — skeleton, detection, settings resolver, IndexedDB, lmanime, popup +
   full library page
2. **done** — extractor layer, DNR header rules, background playback proxy,
   in-page player, auto-fallback, resume and progress. Confirmed playing in the
   browser. lmanime sends **no CSP**, so the strip was never needed; it survives
   as an opt-in `stripCsp` flag per source rather than a blanket rule.
   Dailymotion's HLS path is still the one unproven piece.
3. **done** — update loop on a nextCheckAt priority queue, notifications,
   schedule policies with per-series overrides, settings panel
4. **done** — all four launch sources, plus the iframe fallback for unknown
   hosts. The Lab page is in (`src/ui/lab`, reachable from Settings): a source
   picker and a Run button drive six chained steps through the real fetch
   context and the real DNR rules, ending in a fetch of the stream itself.
   `npm run probe` is still faster to iterate with, but it cannot reproduce a
   site that demands a `Referer` — Node can set that header and a browser
   cannot, which is exactly how the MegaPlay failure hid, and which is why the
   Lab's last step exists. What each step asserts is pure and tested
   (`src/lab/checks.ts`, `npm run check:lab`).
5. **done** — domain resolution with health checks and auto-promotion, AniList
   metadata and air times
6. **done** — skip intro/outro (site offsets first, AniSkip as fallback),
   subtitle tracks with SRT→VTT conversion, keyboard shortcuts with a `?`
   overlay, Picture-in-Picture, quality preference, episode navigation
6.5 **done** — corrections from the first real week of use. The settings cache
   bug (rule 10), a watch pointer that moved backwards, myanime's identity
   rework, the MegaPlay extractor, live-updating library UI, an episode picker
   per row, source filtering, persisted list controls, a release delay for the
   airing schedule, and honouring `takeOverPage` with an in-page badge when it
   is off.
7. **done** — a search page that asks every source at once and groups the
   results by show, and one row per *show* in the library with an expander.
   See "Grouping" below.
8. **done** — export/import and downloads.

   *Backup* is the only data-transfer path there is, since sync was dropped on
   purpose. The rule throughout `model/backup.ts` is that records are moved,
   never rebuilt field by field: a file written by a later version carries keys
   this build cannot name, and enumerating them would make an older build
   destroy the newer one's data on any round trip. Two modes — `replace` (the
   library becomes the file, and the UI says how many series that removes first)
   and `merge` (the more recently touched record wins each field, except watch
   history, which is never lost). Merging is symmetric, which is what lets
   `planImport` tell "changed" from "already identical".

   *Downloads* run in an offscreen document, for two reasons that are both
   fatal on their own: a service worker has no `URL.createObjectURL`, and it is
   torn down after thirty seconds while an episode takes minutes. The document
   is handed a flat list of URLs — every site-specific decision is already made —
   fetches them in a window of six, writes them to OPFS in playlist order, and
   *sends* the outcome back rather than replying, because there may be no worker
   left to receive a reply. Nothing is re-encoded: MPEG-TS segments make a `.ts`
   file and the UI says so, since calling it `.mp4` produces something that
   fails to open with no explanation. AES-128 is decrypted; SAMPLE-AES is
   refused by name rather than written out as noise.
9. **partly done** — categories are in, and so is the next-episode look-ahead.

   *Categories* are two kinds because neither alone is enough: a manual shelf
   is something only the user can fill, and hand-tagging four hundred series
   with facts a tracker already knows is how such a feature goes unused. The
   useful automatic split here is AniList's `countryOfOrigin` — no site says
   whether it is showing anime or donghua, and the genres do not distinguish
   them. A source can also declare what it carries (`AnimeSource.categories`);
   mundodonghua says `["Donghua"]`, which works with no tracker match at all.
   Chips have three states: ticking narrows (all must match), crossing removes
   (any is enough).

   **An automatic rule is evidence, not a verdict.** Every shelf can be corrected
   by hand, the ones that fill themselves included: `countryOfOrigin` is absent
   for everything AniList has not matched — which is every series added before
   tracker matching existed — so a "Donghua" shelf that cannot be corrected is
   quietly wrong for exactly the library it was built for. `categories` forces a
   series on and `categoriesOff` forces it off; `shelveOverrides` stores only the
   *disagreement*, so neither list becomes a stale second copy of the rules.
   Restricting hand-editing to manual shelves was the first attempt and was
   useless: a user with no manual shelves saw no way to fix anything at all.

   *Look-ahead*: the background reads the next episode's page while the current
   one plays, and the player swaps identity in place with `pushState` instead of
   navigating. The read is never a tracking signal. Page markup is fetched as
   soon as it is known; the stream is warmed only at 60% through, because
   extracted URLs are signed and short-lived.

   Also in: episodes a site has posted but not released are recognised,
   withheld from notifications and announced when they go live, and an episode
   nothing would play is no longer recorded as watched. See "Posted, but not
   out".

   Still open: the ZoroTheme family, Spanish sources beyond mundodonghua,
   AniList write-back (needs OAuth), and stats.
