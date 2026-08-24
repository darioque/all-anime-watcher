/**
 * Exercise myanime.live's identity parsing against the four shapes the site
 * actually publishes.
 *
 *   npm run check:myanime
 *
 * This is the source with no series pages, where identity has to be reconstructed
 * from a post slug, a post title, a search link or the order posts were published
 * in. Every case below is a real URL taken off the live site — a regex that looks
 * right and quietly files two seasons under one entry is exactly the failure this
 * is here to catch.
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
eq("the site's own grouping link is readable", searchQueryFromUrl("https://myanime.live/?s=Wan+Jie+Du+Zun"), "Wan Jie Du Zun")
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

// --- numbering posts the site refused to label
const DAY = 86_400_000
const base = Date.parse("2026-08-01T00:00:00Z")
const post = (slug: string, title: string, day: number) => ({ slug, title, date: base + day * DAY })

// Newest first: three untitled posts sitting above a post that states its number.
const mixed = numberPosts([
    post("120873", "", 10),
    post("120870", "", 9),
    post("120858", "", 8),
    post("dzznf-tgr3dii-episode-87-english-sub", "DZZNF- TGR3DII Episode 87 english sub", 7),
    post("dzznf-tgr3dii-episode-86-english-sub", "DZZNF- TGR3DII Episode 86 english sub", 6)
])
eq("every post gets a number", mixed.length, 5)
eq("the newest untitled post counts on from the anchor", mixed[0]?.number, 90)
check(
    "inferred posts are marked as such",
    mixed[0]?.inferred === true && mixed.find(p => p.number === 87)?.inferred === false
)

// Two anchors with a gap that does not fit the posts between them: the site
// skipped or doubled an episode, and guessing would put history on the wrong one.
const inconsistent = numberPosts([
    post("show-episode-20-english-sub", "Show episode 20", 5),
    post("111111", "", 4),
    post("show-episode-12-english-sub", "Show episode 12", 3)
])
eq("an unnumberable post is dropped, not guessed", inconsistent.length, 2)
check("the anchors themselves survive", inconsistent.every(p => !p.inferred))

// Nothing to anchor on at all.
eq("posts with no anchor anywhere are dropped", numberPosts([post("999", "", 1), post("998", "", 2)]).length, 0)

// A gap that *does* fit is safe to fill.
const fits = numberPosts([
    post("show-episode-9-english-sub", "Show episode 9", 5),
    post("222222", "", 4),
    post("show-episode-7-english-sub", "Show episode 7", 3)
])
eq("a gap that fits exactly is filled", fits.length, 3)
eq("and it is filled with the right number", fits.find(p => p.inferred)?.number, 8)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
