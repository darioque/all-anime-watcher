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

The user runs on fish + fish-nvm (there is no `nvm.sh` to source, and `nvm` is
invisible from bash). Node lives under `~/.local/share/nvm/`.

```
fish -c "nvm use 20.20.1; npm run build"        # both passes + dist validation → dist/
fish -c "nvm use 20.20.1; npm run check"        # validate dist/ alone
fish -c "nvm use 20.20.1; npm run typecheck"    # vue-tsc, must stay clean
fish -c "nvm use 20.20.1; npm run probe -- lmanime"   # run a source against the live site
```

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
| lmanime.com | WordPress `animestream` theme | done, all probe checks pass |
| anikototv.to | AnimeKai/AnimeSuge family; domain list at anikoto.site | phase 4 |
| mundodonghua.com | custom PHP, `/donghua/` + `/ver/` | phase 4 |
| myanime.live | WordPress `aamla` blog theme | phase 4 |

## Phase status

1. **done** — skeleton, detection, settings resolver, IndexedDB, lmanime, popup
2. next — one episode end to end: servers → extractor → hls.js in the page.
   Settles the CSP strip and the fetch ladder. Highest-risk phase, deliberately early.
3. library and tracking depth, update loop, notifications
4. the other three sources + an in-extension Lab page
5. domain resolution, AniList metadata/schedule, per-anime schedule policies
6. player depth: skips, auto-advance, tracks, shortcuts, PiP
7. downloads (OPFS pipeline) and import/export
8. breadth: ZoroTheme family, Spanish sources, AniList write-back, stats
