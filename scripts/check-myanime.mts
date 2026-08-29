/**
 * Exercise myanime.live's identity parsing against the four shapes the site
 * actually publishes.
 *
 *   npm run check:myanime
 *
 * This is the source with no series pages, where identity has to be reconstructed
 * from a post slug or a post title. Every case below is a real URL taken off the
 * live site — a regex that looks right and quietly files two seasons under one
 * entry is exactly the failure this is here to catch.
 */
import {
    numberPosts,
    sameSeries,
    searchQueryFor,
    searchQueryFromUrl,
    seriesSlugOf,
    seriesTitleOf,
    slugify,
    statedNumber
} from "~/sources/sites/myanime.parse"
import { findFollowed } from "~/library/identity"

let failures = 0

function check(label: string, condition: boolean, detail = "") {
    if (condition) {
        console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`)
    } else {
        failures++
        console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`)
    }
}

function eq<T>(label: string, actual: T, expected: T) {
    check(label, Object.is(actual, expected), Object.is(actual, expected) ? "" : `got ${String(actual)}`)
}

console.log("\n\x1b[1mmyanime.live identity parsing\x1b[0m\n")

// --- episode numbers
eq("spelled-out episode number", statedNumber("Wan Jie Du Zun – Ten Thousand Worlds episode 476 english sub"), 476)
eq("abbreviated episode number", statedNumber("ZXJDS4ep03eng"), 3)
eq("a slug with no number states none", statedNumber("120873"), null)
eq("half episodes survive", statedNumber("something-episode-13.5-english-sub"), 13.5)
eq("episode 0 is a number, not 'absent'", statedNumber("prologue episode 0 english sub"), 0)
// "episode" contains "ep", so a bare `ep\d` pattern run first reads the wrong number.
eq("'episode' is not read as 'ep'", statedNumber("Season 2 episode 7"), 7)
eq("'ep' inside a word is not a number", statedNumber("sleep01-something"), null)
/*
 * The cost of that last rule, recorded rather than worked around: "ep" is only
 * read as an episode marker when a digit or separator sits in front of it, so a
 * code with no digit in it ("SHOWep10eng") is refused too. WordPress lowercases
 * slugs, which makes "showep10eng" and "sleep01" structurally identical — there
 * is no rule that accepts one and rejects the other. Refusing both is the safe
 * direction: a missing episode is a gap, a wrong one puts watch history on the
 * wrong episode. The site's real codes all carry a digit ("ZXJDS4ep03eng",
 * "POAGSs1ep11eng"), so this has not cost anything yet.
 */
eq("a code with no digit before 'ep' is refused too", statedNumber("showep10eng"), null)
eq("the site's real codes all carry one", statedNumber("POAGSs1ep11eng"), 11)

// --- series slugs
eq(
    "slug drops the episode marker",
    seriesSlugOf("wan-jie-du-zun-ten-thousand-worlds-episode-476-english-sub"),
    "wan-jie-du-zun-ten-thousand-worlds"
)
eq(
    "WordPress' duplicate suffix goes with it",
    seriesSlugOf("wan-jie-du-zun-ten-thousand-worlds-episode-473-english-sub-2"),
    "wan-jie-du-zun-ten-thousand-worlds"
)
eq("abbreviated slug still names the series", seriesSlugOf("zxjds4ep03eng"), "zxjds4")
eq("a bare post id names nothing", seriesSlugOf("120873"), null)
eq(
    "seasons stay in the series name",
    seriesSlugOf("tales-of-demons-and-gods-10th-season-episode-1213-english-sub"),
    "tales-of-demons-and-gods-10th-season"
)

// --- series titles
eq(
    "title drops the episode marker",
    seriesTitleOf("Wan Jie Du Zun – Ten Thousand Worlds episode 476 english sub"),
    "Wan Jie Du Zun – Ten Thousand Worlds"
)
eq("abbreviated title keeps its digits", seriesTitleOf("ZXJDS4ep03eng"), "ZXJDS4")
eq("an empty title yields nothing", seriesTitleOf(""), null)

// --- search queries
eq(
    "punctuation is dropped, not escaped",
    searchQueryFor("tunshi-xingkong-swallowed-star", "Tunshi Xingkong – Swallowed Star"),
    "Tunshi Xingkong Swallowed Star"
)
eq("a query can be rebuilt from the id alone", searchQueryFor("zxjds4"), "zxjds4")
eq(
    "the site's own grouping link is readable",
    searchQueryFromUrl("https://myanime.live/?s=Wan+Jie+Du+Zun"),
    "Wan Jie Du Zun"
)
eq("a plain URL carries no query", searchQueryFromUrl("https://myanime.live/2026/08/22/foo/"), null)

// The round trip that makes grouping URLs safe to store: the id derived from a
// URL has to be the id the entry was filed under.
check(
    "a query round-trips to its own id",
    slugify(searchQueryFor("tunshi-xingkong-swallowed-star", "Tunshi Xingkong – Swallowed Star")) ===
        "tunshi-xingkong-swallowed-star"
)

// --- what counts as the same series
check("identical slugs match", sameSeries("xian-ni", "xian-ni"))
check(
    "a renamed series still matches",
    sameSeries("wan-jie-du-zun", "wan-jie-du-zun-ten-thousand-worlds"),
    "the site retitled it partway through its run"
)
check(
    "two seasons do not match",
    !sameSeries("tales-of-demons-and-gods", "tales-of-demons-and-gods-10th-season"),
    "merging them would put ten seasons of history in one entry"
)
check("a bare season number does not match either", !sameSeries("xian-ni", "xian-ni-2"))
check("unrelated series do not match", !sameSeries("wan-jie-du-zun", "wan-jie-zhizun-the-emperor-of-myriad-realms"))

// --- numbering posts
const DAY = 86_400_000
const base = Date.parse("2026-08-01T00:00:00Z")
const post = (slug: string, title: string, day: number) => ({ slug, title, date: base + day * DAY })

const numbered = numberPosts([
    post("show-episode-12-english-sub", "Show episode 12", 6),
    post("show-episode-11-english-sub", "Show episode 11", 5),
    post("zxjds4ep10eng", "ZXJDS4ep10eng", 4)
])
eq("posts that state a number are kept", numbered.length, 3)
eq("newest first", numbered[0]?.number, 12)
eq("both spellings are read", numbered[2]?.number, 10)

/*
 * Untitled posts — no title, no tag, a numeric slug — carry no episode number
 * and no series. An earlier version inferred their numbers from where they sat
 * between posts that do state one, on the strength of the "All Episodes" link
 * appearing to group them. That link turned out to be an unfilled template
 * field: every untitled post on the site points at the same query whichever show
 * it belongs to, so the posts being "between" anything was an illusion, and the
 * inference was numbering one show's episodes from another show's anchors.
 */
const withUntitled = numberPosts([
    post("show-episode-12-english-sub", "Show episode 12", 6),
    post("120873", "", 5),
    post("show-episode-11-english-sub", "Show episode 11", 4)
])
eq("a post that states no number is dropped", withUntitled.length, 2)
check("and the ones around it are untouched", withUntitled.map(p => p.number).join(",") === "12,11")

eq("posts with nothing to go on at all yield nothing", numberPosts([post("999", "", 1), post("998", "", 2)]).length, 0)

console.log("\n\x1b[1mone series, two identities\x1b[0m\n")

/*
 * The real entry and the real page that exposed this, on 2026-08-26.
 *
 * The series was followed from an untitled post, so its id came from the post's
 * tag; every titled post derives the slug stem instead. The exact-key lookup
 * missed, and the symptoms were an offer to follow a followed series and a watch
 * position that never moved — while notifications kept arriving, because the
 * update loop searches from the stored entry and never asks a page who it is.
 */
const followed = {
    key: "myanime/yi-nian-yong-heng",
    seriesId: "yi-nian-yong-heng",
    url: "https://myanime.live/tag/yi-nian-yong-heng/"
}
const episodePage = {
    seriesId: "yi-nian-yong-heng-a-will-eternal",
    seriesUrl: "https://myanime.live/?s=Yi%20Nian%20Yong%20Heng%20A%20Will%20Eternal"
}

eq("the tag id and the slug id find each other", findFollowed([followed], episodePage, sameSeries)?.key, followed.key)
eq("and nothing is guessed without the source's say-so", findFollowed([followed], episodePage), undefined)
eq(
    "an exact id still wins outright",
    findFollowed(
        [followed, { key: "myanime/x", seriesId: episodePage.seriesId, url: "https://myanime.live/?s=x" }],
        episodePage,
        sameSeries
    )?.key,
    "myanime/x"
)

/* The safety property: a season is not a rename, whatever the prefix says. */
const tdg = {
    key: "myanime/tales-of-demons-and-gods",
    seriesId: "tales-of-demons-and-gods",
    url: "https://myanime.live/?s=Tales%20of%20Demons%20and%20Gods"
}
eq(
    "a later season is not the same series",
    findFollowed(
        [tdg],
        {
            seriesId: "tales-of-demons-and-gods-10th-season",
            seriesUrl: "https://myanime.live/?s=Tales%20of%20Demons%20and%20Gods%2010th%20Season"
        },
        sameSeries
    ),
    undefined
)

/*
 * Why the URL comparison reads the query too: every series on this site has a
 * grouping URL whose *path* is "/". Comparing paths alone made them all equal —
 * and then bailed on the empty string, so the fallback never fired at all.
 */
const foo = { key: "myanime/foo", seriesId: "foo", url: "https://myanime.live/?s=Foo" }
const bar = { key: "myanime/bar", seriesId: "bar", url: "https://myanime.live/?s=Bar" }
eq(
    "two search-page series are told apart",
    findFollowed([foo, bar], { seriesId: "renamed-bar", seriesUrl: "https://myanime.live/?s=Bar" })?.key,
    bar.key
)
eq(
    "and a moved domain still matches on path and query",
    findFollowed([bar], { seriesId: "renamed-bar", seriesUrl: "https://myanime.new/?s=Bar" })?.key,
    bar.key
)

console.log("\n\x1b[1mtwo names that share no letters\x1b[0m\n")

/*
 * The real entry and the real page that exposed the rest of it, on 2026-08-29.
 *
 * The prefix rule above fixed the case where the two ids look alike. This is the
 * same bug where they do not: the post's slug is the English title and the post's
 * tag is the romanised Chinese one, and the library holds the tag. No rule over
 * the two strings could join them — but the page names both, so it is asked.
 */
const mortal = {
    key: "myanime/fan-ren-xiu-xian-chuan",
    seriesId: "fan-ren-xiu-xian-chuan",
    url: "https://myanime.live/tag/fan-ren-xiu-xian-chuan/"
}
const mortalPage = {
    seriesId: "a-record-of-a-mortals-journey-to-immortality",
    seriesUrl: "https://myanime.live/?s=A%20Record%20of%20a%20Mortals%20Journey%20to%20Immortality",
    aliases: [
        {
            seriesId: "fan-ren-xiu-xian-chuan",
            seriesUrl: "https://myanime.live/tag/fan-ren-xiu-xian-chuan/"
        }
    ]
}

eq("the page's own tag finds the followed entry", findFollowed([mortal], mortalPage, sameSeries)?.key, mortal.key)
eq("and it does not need the source's opinion to do it", findFollowed([mortal], mortalPage)?.key, mortal.key)

/* What the earlier fix could do, pinned: nothing. This is the miss it left. */
const { aliases: _mortalAliases, ...mortalPageWithoutTag } = mortalPage
eq(
    "without the alias no rule can bridge the two names",
    findFollowed([mortal], mortalPageWithoutTag, sameSeries),
    undefined
)

/* Aliases are read, not guessed, so they are matched exactly — seasons included. */
eq(
    "an alias is exact, so a season is still not its parent",
    findFollowed(
        [tdg],
        {
            seriesId: "unrelated",
            seriesUrl: "https://myanime.live/?s=Unrelated",
            aliases: [{ seriesId: "tales-of-demons-and-gods-10th-season" }]
        },
        sameSeries
    ),
    undefined
)

/* Strength order holds across the whole set: the picked id outranks any alias. */
eq(
    "the id the page picked wins over its own aliases",
    findFollowed(
        [mortal, { key: "myanime/english", seriesId: mortalPage.seriesId, url: "https://myanime.live/?s=x" }],
        mortalPage,
        sameSeries
    )?.key,
    "myanime/english"
)
eq(
    "and every exact id outranks the source's inexact opinion",
    findFollowed(
        [
            { key: "myanime/prefix", seriesId: "wan-jie-du-zun", url: "https://myanime.live/?s=Wan%20Jie%20Du%20Zun" },
            mortal
        ],
        { ...mortalPage, seriesId: "wan-jie-du-zun-ten-thousand-worlds" },
        sameSeries
    )?.key,
    mortal.key
)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
