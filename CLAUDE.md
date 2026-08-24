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
npm run typecheck          # vue-tsc, must stay clean
npm run probe -- lmanime   # run a source against the live site
PROBE_SERVER=3 npm run probe -- lmanime   # exercise one video host
```

(AMR next door is different: its `engines` field pins node 18/20, so that repo
still needs `fish -c "nvm use 20.20.1; …"`. Don't carry that habit over here.)

`dist/` is loaded unpacked in the browser. **The user builds and tests; don't run
builds repeatedly just to re-read output.**

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

All four launch sources are in. The remaining phase-4 item is an **in-extension
Lab page**; `npm run probe` covers the same ground from the CLI for now.

**myanime.live has no series identity to read**, which makes it the hardest of
the four and a useful template for sites like it. Each post is one episode, and
the site groups them four different ways depending on how nervous it was about
the rights holder. In the order `getPageInfo` tries them:

1. the post's own **"All Episodes" button**, linking to `/?s=<query>` — the
   site's own grouping, and the only thing that works for posts stripped of a
   title;
2. the **post slug**, minus its episode marker;
3. the **post title**, same cut, which is where the display name comes from;
4. the post's **tags** — the original approach and the worst of the four: many
   posts carry none, and where they do the tag is as likely to name the
   protagonist ("Lin Feng") as the show.

Two consequences worth keeping. The stored `seriesUrl` is a `/?s=` search page,
with the series id pinned in the fragment (`#aaw=…`) when the best query is
broader than the series name — a series retitled mid-run needs a broad query to
find its older episodes and a specific id to filter the results. And posts that
state no number at all are numbered from their **position between posts that
do**, only where the arithmetic fits exactly; the rest are dropped, because a
wrong number puts watch history on the wrong episode. `npm run check:myanime`
covers all of it.

**Anikoto's signing**, since this family is common: `vrf = base64(rc4("simple-hash", animeId))`.
The key and algorithm are both in the site's own `main.js`, which uses the same
routine to decode its `window.__cfg` blob — decoding that to valid JSON is how to
confirm the scheme on a sibling site rather than guess. Every `ajax/*` endpoint
answers with a `{status, result}` envelope; parsing the envelope as markup finds
nothing and looks exactly like a selector that broke, so unwrap first.

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

## Editing these files

Several patches to `.vue` files have silently no-op'd because an exact-string
replace ran against markup prettier had already reformatted — leaving working
code that nothing could reach (a settings panel with no button, a `checkAll` with
no caller). Typecheck passes in that state, so it proves nothing.

Rewrite the file or use a real editor tool; if you must patch by string, assert
the replacement changed the buffer, and afterwards grep the *built bundle* for a
user-visible string from the change. `grep -F "Check every series now" dist/*.js`
is the check that would have caught all three.

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

**Testing notifications:** you can't make a site publish an episode, so use
“Forget newest episode” in a series' ⋯ menu (drops the top of the stored list)
then “Check every series now”. The real path then runs: the source returns the
episode, it counts as new, and it notifies. Settings has a plain test
notification too, for checking the OS-level plumbing.

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
  when one matches and fails. The viewer keeps episode navigation, the server
  picker and library tracking, and loses only their position inside the episode.
  The player treats it as a last resort — it walks every server first and only
  embeds if nothing extractable worked. This is why an unknown host is degraded
  rather than unsupported, and why writing an extractor is an optimisation.

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
| streamwish family | `streamwish` | works — covers embedwish, vidhidepro, bysekoze, morencius, FileLions, VidHide |
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

**Dailymotion's 403 is not a header problem.** Both a token-shaped explanation
and a header-shaped one fit some of the evidence, which is exactly why it keeps
getting misdiagnosed — an earlier pass concluded `Accept-Encoding` and shipped a
DNR removal rule for it. Repeating a single header variant with a *fresh* token
each time shows the same variant both passing and failing, so the variable is the
`sec=` token, not what is sent with it. Do not add header rules for this without
a repeat-measured result. In practice the player falls through to the next server
on a fatal HLS error, which is why lmanime and myanime still play.

**Sources:** `lmanime` (AnimeStream theme), `mundodonghua` (custom PHP, packed-JS
servers), `myanime` (WordPress REST API, no series pages), `anikoto` (AnimeKai
family, signed AJAX, embeds on the MegaPlay engine).

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
   hosts. The in-extension Lab page is the one part not built; `npm run probe`
   covers it from the CLI.
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
7. **finding and grouping** — a search page for adding series deliberately
   rather than only by opening an episode, and one row per *show* across
   sources with an expander (AMR's model), keyed on the AniList match rather
   than on titles. The two belong together: both are about a show existing in
   more than one place.
8. downloads (OPFS pipeline) and import/export. Import/export is the only
   data-transfer path there is, since sync was dropped on purpose, so it has to
   round-trip losslessly.
9. breadth and library depth: categories with include/exclude filtering and
   bulk actions (AMR's model; `TrackedAnime.categories` already exists and is
   unused) — a source that only carries donghua should seed one — plus the
   ZoroTheme family, Spanish sources, AniList write-back, stats
