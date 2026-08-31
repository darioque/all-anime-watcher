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
 * **The date does distinguish them, and it is what this now reads.** The
 * placeholder is backdated far enough to sort below episode 1 of its own series.
 * The first reading of this site called that a symptom and not evidence, on the
 * grounds that an out-of-order date is also what a corrected typo or a late
 * re-upload looks like — true, and it is why the test is not "out of order". The
 * habit has since been watched twice on the same series and it is sharper than
 * that, on both ends at once:
 *
 *   2026-08-27  E13 dated July 1   E01-04 dated July 30   E13 last, newest number
 *   2026-08-31  E14 dated July 1   E13   dated August 30  E14 last, newest number
 *
 * — the newest episode by number carrying, uniquely, the oldest date in the list.
 * Neither half happens to a real release on its own account: a re-upload takes
 * *today's* date rather than the list's oldest, and a corrected typo lands on an
 * episode that is not the newest. Requiring both is what makes this safe to read,
 * and `AnimeStream.pendingInList` states the conditions in full.
 *
 * Reading it off the list is why this site costs no extra request. The evidence
 * on the episode page is stronger — a tickcounter widget means one thing and
 * nothing else — but reaching it is a fetch per candidate on every check for as
 * long as the countdown stands, and the list has already been fetched. The
 * marker path stays available on the family for a site whose list gives nothing
 * away.
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
    // Read off the series list, so no episode page is opened — see the note
    // above and `AnimeStream.pendingInList` for the two conditions.
    pending: {
        backdated: true,
        reason: "the site has dated it below episode 1, which is how it parks one it cannot play yet"
    }
})
