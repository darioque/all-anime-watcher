import { AnimeStream } from "~/sources/families/AnimeStream"

/**
 * animekhor.org — WordPress running the `animestream` theme, so this is config only.
 *
 * Verified live 2026-10-01:
 *   series   https://animekhor.org/anime/<slug>/                                   h1.entry-title
 *   episode  https://animekhor.org/<slug>-episode-N-subtitles-english-indonesian/  breadcrumb gives the series URL
 *   servers  select.mirror > option[value]                                         base64 HTML holding the iframe
 *   search   /page/N/?s=<query>                                                    div.listupd article a.tip
 *
 * **Series live under `/anime/`, episodes at the root, and the stems disagree**
 * — the same shape as luciferdonghua.in:
 *
 *   shrouding-the-heavens-episode-183-…       →  /anime/shrounding-the-heavens/
 *   swallowed-star-season-2-episode-217-243-… →  /anime/swallowed-star-2nd-season/
 *
 * so `seriesUrl` is declared, an episode URL yields no id, and the breadcrumb
 * decides. Numbers are sometimes dual (`-episode-217-243-`, season count then
 * absolute); the first is the one the series list uses, so it is the one kept.
 *
 * **Batches are posted as one episode**: `-episodes-16-to-21-`, listed as
 * "16 to 21". The plural is why `episodeUrl` reads `episodes?`; it missed
 * every batch post until 2026-10-02. Like the list, it keys them by the first
 * number.
 *
 * Servers are labelled "[ENGLISH]" or "[MULTI SUB]": Dailymotion, OK.ru,
 * Rumble, D.Tube, and a row of white-label players (turbovidhls, upns.live,
 * p2pstream.vip, vidara, bysekoze, abyssplayer). bysekoze has an extractor;
 * the rest degrade to the iframe fallback.
 */
export const animekhor = new AnimeStream({
    id: "animekhor",
    name: "AnimeKhor",
    languages: ["en", "id"],
    domains: ["animekhor.org"],
    home: "https://animekhor.org/",
    categories: ["Donghua"],
    episodeUrl: /^\/[^/]+-episodes?-[\d.]+(?:-[a-z0-9-]+)?\/?$/,
    seriesUrl: /^\/anime\/[^/]+\/?$/
    // Servers are base64 of a bare iframe, so the theme's `iframe[src]` holds.
})
