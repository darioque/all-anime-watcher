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
| myanime.live | WordPress REST API; series are tags | done — probe green |
| anikototv.to | AnimeKai/AnimeSuge family, signed AJAX | done — probe green |

All four launch sources are in. The remaining phase-4 item is an **in-extension
Lab page**; `npm run probe` covers the same ground from the CLI for now.

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
| dailymotion.com | `dailymotion` | resolves to a master playlist; HLS playback unproven |
| voe.sx, rumble.com, youtube.com | — | embedded via the iframe fallback |

**Sources:** `lmanime` (AnimeStream theme), `mundodonghua` (custom PHP, packed-JS
servers), `myanime` (WordPress REST API — series are *tags*, episodes are posts).

## Phase status

1. **done** — skeleton, detection, settings resolver, IndexedDB, lmanime, popup +
   full library page
2. **done, pending browser confirmation** — extractor layer, DNR header rules,
   background playback proxy, in-page player (Vue + hls.js) with server/quality
   pickers, auto-fallback, resume and progress reporting.
   - Mp4Upload verified end to end from the CLI (direct MP4, HTTP 206).
   - Dailymotion resolves to a master playlist but the manifest edge 403s
     inconsistently from a script; unproven until it plays in the browser.
   - lmanime sends **no CSP**, so the strip was never needed there. It exists as
     an opt-in `stripCsp` flag per source rather than a blanket rule.
3. library and tracking depth, update loop, notifications
4. the other three sources + an in-extension Lab page
5. domain resolution, AniList metadata/schedule, per-anime schedule policies
6. player depth: skips, auto-advance, tracks, shortcuts, PiP
7. downloads (OPFS pipeline) and import/export
8. breadth and library depth: categories with include/exclude filtering and
   bulk actions (AMR's model; `TrackedAnime.categories` already exists and is
   unused), ZoroTheme family, Spanish sources, AniList write-back, stats
