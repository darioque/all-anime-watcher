import { AnimeStream } from "~/sources/families/AnimeStream"

/**
 * lmanime.com — WordPress running the `animestream` theme, so this is config only.
 *
 * Verified live 2026-08-24:
 *   series   https://lmanime.com/<slug>/            h1.entry-title
 *   episodes div.eplister > ul > li > a             .epl-num / .epl-title / .epl-sub / .epl-date
 *   episode  https://lmanime.com/<slug>-episode-N/  breadcrumb gives the series URL
 *   servers  select.mirror > option[value]          value is a /v/N/ URL to fetch
 *   search   /page/N/?s=<query>                     div.listupd article a.tip
 *
 * Servers are labelled by language ("English", "Multisub", "English Alternative"),
 * not by host — the host only becomes known once the embed URL is resolved.
 */
export const lmanime = new AnimeStream({
    id: "lmanime",
    name: "LMAnime",
    languages: ["en", "es", "id", "pt", "tr", "ar", "th"],
    domains: ["lmanime.com"],
    home: "https://lmanime.com/",
    // Series live at the site root, so there is no safe seriesUrl pattern to
    // match: /genres/, /schedule/ and /anime-list/ look identical to a slug.
    episodeUrl: /^\/[^/]+-episode-[\d.]+\/?$/
})
