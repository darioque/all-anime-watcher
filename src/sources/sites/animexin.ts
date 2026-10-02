import { AnimeStream } from "~/sources/families/AnimeStream"

/**
 * animexin.dev — WordPress running the `animestream` theme, so this is config only.
 *
 * Verified live 2026-10-01:
 *   series   https://animexin.dev/<slug>/                                  h1.entry-title
 *   episode  https://animexin.dev/<slug>-episode-N-indonesia-english-sub/  breadcrumb gives the series URL
 *   servers  select.mirror > option[value]                                 base64 HTML holding the iframe
 *   search   /page/N/?s=<query>                                            div.listupd article a.tip
 *
 * **Series live at the root, and the episode slug does not always stem to them.**
 * `ancient-god-sovereign-episode-22-…` belongs to `/primeval-overlord/` — the
 * show's other English title. lmanime, also at the root, could not declare a
 * `seriesUrl` because `/genres/` looks like a slug; what *can* be said here is
 * that an episode slug is never a series, which is all identity needs. With it,
 * `seriesIdFromUrl` declines an episode URL and `getPageInfo` reads the
 * breadcrumb, which names the right series every time.
 *
 * **Every host is offered twice, once per language** — "Hardsub English
 * Dailymotion AX", "Hardsub Indonesia Dailymotion AX", and so on for Odysee,
 * OK.ru, Rumble, Mega and D.Tube, plus "All Sub" StreamWish/Dood/Rumble players
 * with soft subtitles. Nothing is filtered: which language to watch is the
 * viewer's to say, through `preferredServers` ("English" puts those first),
 * per source or per series. Left alone, the site's own order applies, and it
 * pairs each host's English server ahead of its Indonesian one.
 *
 * The site sends no CSP, so `stripCsp` stays off.
 */
export const animexin = new AnimeStream({
    id: "animexin",
    name: "AnimeXin",
    languages: ["en", "id"],
    domains: ["animexin.dev"],
    home: "https://animexin.dev/",
    // Chinese animation only; the site brands itself as a donghua site.
    categories: ["Donghua"],
    episodeUrl: /^\/[^/]+-episodes?-[\d.]+(?:-[a-z0-9-]+)?\/?$/,
    // A root-level page that is not an episode. Broad on purpose — /genres/
    // matches too — because what it is *for* is the negative: an episode URL
    // never yields a series id by slug arithmetic.
    seriesUrl: /^\/(?![^/]*-episodes?-[\d.])[^/]+\/?$/
    // The theme's bare `iframe[src]` is right here, unlike on luciferdonghua:
    // a server's value is base64 of the iframe alone, with no page around it
    // for an ad frame to sit in.
})
