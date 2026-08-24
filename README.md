# All Anime Watcher

A browser extension that follows anime and donghua the way a manga tracker follows
series: open an episode, and the show is added to your list, checked for new
episodes, and played in one consistent player instead of whatever each site ships.

Built as the anime counterpart to [All Mangas Reader](https://gitlab.com/all-mangas-reader/all-mangas-reader-2).

## Status

Early. Phase 1 of 8 is in place:

- Episode-page detection and programmatic injection, per site
- A library in IndexedDB, keyed so that a site changing its URLs or its domain
  does not lose your place
- A three-level settings resolver — per anime, per source, global
- One working source: **LMAnime** (`animestream` theme), verified end to end
- A popup listing what you're tracking

Not there yet: the player, the update scheduler, notifications, downloads,
AniList, and the other three launch sources.

## Build

Requires Node 20.19+.

```sh
npm install
npm run build        # → dist/
```

Load `dist/` as an unpacked extension (`chrome://extensions` → Developer mode →
Load unpacked).

```sh
npm run typecheck            # vue-tsc
npm run watch                # rebuild pages + background on change
npm run watch:content        # rebuild the injected script on change
npm run probe -- lmanime     # run a source against the live site
```

`npm run probe` walks a source through the whole contract — search, series,
episodes, episode-page detection, page info, servers, server resolution — and
reports what broke. Run it before assuming the extension is at fault.

## Design

Three plugin layers, because anime sites host no video of their own:

```
episode page → Source (episodes, servers) → Extractor (embed → streams) → Player
```

A **source** knows one site. An **extractor** knows one video host and is shared
across every site that embeds it — which is what makes adding a site cheap.

The full architecture, and the reasoning behind the departures from AMR, is in the
[design doc](https://claude.ai/code/artifact/34d7f865-1d51-40d0-a5d8-7e9f21e024b1).
Contributor-facing rules live in [CLAUDE.md](CLAUDE.md).

## License

GPL-3.0, matching AMR.
