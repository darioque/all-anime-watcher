import { AnimeStream } from "~/sources/families/AnimeStream"

/**
 * donghua4k.net — WordPress running the `animestream` theme, so this is config only.
 *
 * Verified live 2026-10-01:
 *   series   https://donghua4k.net/anime/<slug>/                 h1.entry-title
 *   episode  https://donghua4k.net/<slug>-episode-N-subbed/      breadcrumb gives the series URL
 *   servers  select.mirror > option[value]                       base64 HTML holding the iframe
 *   search   /page/N/?s=<query>                                  div.listupd article a.tip
 *
 * Series under `/anime/`, so `seriesUrl` is declared and the breadcrumb decides
 * identity; the slugs here carry the pinyin title too
 * (`renegade-immortal-xian-ni`), which is exactly the sort of stem that drifts.
 *
 * **One server per subtitle language, all Dailymotion**: "Player 1 (Multiple
 * Subtitles) [4k]", then English, Indonesian, Español and Portugués at 1080p.
 * The occasional special is a YouTube embed instead. `preferredServers` picks the
 * language ("ESPANOL", "ENGLISH"); unset, the multi-subtitle 4K one leads.
 */
export const donghua4k = new AnimeStream({
    id: "donghua4k",
    name: "Donghua4K",
    languages: ["en", "id", "es", "pt"],
    domains: ["donghua4k.net"],
    home: "https://donghua4k.net/",
    categories: ["Donghua"],
    episodeUrl: /^\/[^/]+-episodes?-[\d.]+(?:-[a-z0-9-]+)?\/?$/,
    seriesUrl: /^\/anime\/[^/]+\/?$/
    // Servers are base64 of a bare iframe, so the theme's `iframe[src]` holds.
})
