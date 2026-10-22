import { AnimeStream } from "~/sources/families/AnimeStream"

/**
 * luciferdonghua.in — WordPress running the same `animestream` theme as lmanime,
 * so this is config only. Every default selector was verified live 2026-08-27:
 *
 *   series   https://luciferdonghua.in/anime/<slug>/   h1.entry-title
 *   episodes div.eplister > ul > li > a                .epl-num ("03 [4K]") / .epl-title
 *   episode  https://luciferdonghua.in/<slug>-episode-N-lucifer-donghua/
 *   servers  select.mirror > option[value]             value is a /v/N/ URL to fetch
 *   search   /page/N/?s=<query>                        div.listupd article a.tip
 *
 * Two things differ from lmanime and both are declared below.
 *
 * **Series live under `/anime/`, episodes at the root.** That is what makes
 * `seriesUrl` declarable here, and declaring it matters for more than letting
 * the user follow a series from its own page: the episode slug's stem is *not*
 * the series slug on this site, and hardly ever is. Every one of these is a
 * real pairing —
 *
 *   perfect-world-wanmei-shijie-episode-284-…   →  /anime/perfect-world-new/
 *   one-slash-to-the-heavens-gu-an-episode-06-… →  /anime/gu-an/
 *   coiling-dragon-episode-18-to-20-…           →  /anime/coiling-dragon-2026/
 *   law-of-the-devil-episode-24-subtitle        →  /anime/law-of-the-devil-2023/
 *
 * — so slug arithmetic yields a plausible-looking id that names no series and
 * would key a duplicate library entry that never updates. With `seriesUrl`
 * declared, `seriesIdFromUrl` returns null for an episode URL and identity comes
 * from the theme's breadcrumb, which is authoritative and always present.
 *
 * **Episode slugs carry a trailing tag** — usually `-lucifer-donghua`, sometimes
 * `-subtitle` — and the number is often a range or a dual local/absolute count
 * (`-episode-22-52-`, `-episode-18-to-20-`, `-episode-12-444-and-13-445-`). The
 * theme's default `episodeSuffix` already strips all of these; only `episodeUrl`
 * needs widening, since the theme's default stops at the number.
 *
 * Servers are Dailymotion, Rumble, VidHide (StreamWish family) and OK.ru — all
 * hosts the extractor layer already covers, bar Rumble, which degrades to the
 * iframe fallback. No extractor work was needed.
 *
 * The site sends `Content-Security-Policy: upgrade-insecure-requests`, which
 * constrains no script or media source, so `stripCsp` stays off.
 *
 * **It also posts episodes before it has them**, which is what `pending` below
 * is for. Measured on Ancient God Sovereign E13 on 2026-08-27, against E12 as
 * the control:
 *
 *   E12 `.player-embed`  →  the Dailymotion iframe, on the base page and on /v/1/
 *   E13 `.player-embed`  →  a tickcounter.com countdown widget on the base page
 *                           and /v/1/, "Video Not Available" on /v/2/../v/5/
 *
 * The server list is identical on both — five `option`s in `select.mirror` — so
 * nothing about the *shape* of the series page distinguishes them, and the update
 * loop reads only the series page. E13 was announced as a release, opened to five
 * servers that each resolved to nothing, and was marked watched on the way in.
 *
 * **Only the episode page tells them apart, so that is what gets read.** For a
 * while the list's dates did: the placeholder was dated to the 1st of a month
 * gone by, older than the newest real post, and a rule in list parsing dropped
 * the newest episode when it had that shape. It held for most episodes and then
 * missed Jade Dynasty S4 E12 in October 2026, which the site listed as a release
 * with a countdown on its page — a date habit is the site's to change without
 * notice, and the page is the thing that actually says "not yet".
 *
 * So `pending` below is read twice: by the library, which opens the page of an
 * episode it is about to announce (one request, and only when something new
 * appears — see `library/unreleased.ts`), and when somebody opens the page
 * anyway, where it stops the visit counting as watched and gives the player a
 * sentence to show instead of an empty frame.
 */
export const luciferdonghua = new AnimeStream({
    id: "luciferdonghua",
    name: "Lucifer Donghua",
    languages: ["en", "id"],
    domains: ["luciferdonghua.in"],
    home: "https://luciferdonghua.in/",
    // Chinese animation only — the genre list is entirely xianxia/cultivation
    // and the site brands itself "Chinese/Donghua Anime Stream". This fills the
    // Donghua shelf with no tracker round trip, which is the only thing that
    // ever will for the many series AniList has never heard of.
    categories: ["Donghua"],
    episodeUrl: /^\/[^/]+-episode-[\d.]+(?:-[a-z0-9-]+)?\/?$/,
    seriesUrl: /^\/anime\/[^/]+\/?$/,
    selectors: {
        // The theme's default is a bare `iframe[src]`, which on this site picks
        // up an injected `t.co` ad iframe sitting in `div.megavid` well above
        // the player. Anchoring on the player's own container fixes that.
        //
        // Descendant, not `>`. The child combinator was tried first and broke
        // Dailymotion on some episodes: the site wraps that embed in an unnamed
        // inner `<div>`, so the iframe is a grandchild of `.player-embed` and
        // `resolveServer` reported "no embed URL found" for a server that was
        // right there. Loosening it is safe because the ads live in
        // `div.megavid` and `div.video-content`, never inside `.player-embed` —
        // checked across every server page of two episodes, where this matches
        // exactly one iframe and it is always the player.
        //
        // Some servers carry no iframe at all and put the URL in
        // `meta[itemprop=embedUrl]`, which the family falls through to when this
        // finds nothing.
        playerIframe: "div.player-embed iframe[src]"
    },
    // How the episode page says "not yet" — read before an episode is announced,
    // and when somebody opens one anyway. `a.tickcounter`
    // is the widget's own class and `data-type=countdown` the attribute its
    // loader reads, so either alone is enough; both are listed because the site
    // writes both and dropping one is a free way to survive a markup tweak. The
    // text clause covers the sibling state, where the site has given up on a
    // server rather than scheduled it.
    pending: {
        markers: ["a.tickcounter", "[data-type=countdown]"],
        text: ["video not available"],
        reason: "the site is counting down to it rather than playing it"
    }
})
