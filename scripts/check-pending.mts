/**
 * Exercise "has this episode actually come out, or has the site only posted it?"
 *
 *   npm run check:pending
 *
 * The bug this exists for: luciferdonghua.in published Ancient God Sovereign E13
 * as a normal-looking post with a tickcounter.com countdown where the player
 * goes. It was announced as a release, the notification opened a page whose five
 * servers each resolved to nothing, and the watch position had already moved
 * onto it on the way in.
 *
 * A source answers in either of two ways, and both are covered here:
 *
 *  - `pendingInList`, from the series list already fetched. Free. luciferdonghua
 *    is here — it backdates the placeholder below episode 1 of its own series.
 *  - `episodeAvailability`, from the episode page. A request per candidate.
 *    No shipping source needs it today, so it is exercised through a config
 *    built here; the mechanism stays live for the next site whose list gives
 *    nothing away.
 *
 * `npm run check:episodes` covers the rules that follow from a pending verdict.
 * This covers reaching the verdict at all, which is the part that rots: the site
 * restyles or changes how it dates a placeholder, and the failure is silent in
 * the worst direction — every episode looks playable again and the countdown
 * comes back.
 */
import type { Episode } from "~/model/types"
import { AnimeStream } from "~/sources/families/AnimeStream"
import { luciferdonghua } from "~/sources/sites/luciferdonghua"
import { lmanime } from "~/sources/sites/lmanime"
import { countdown, countdownBesidePlayer, notAvailable, playable } from "./fixtures/luciferdonghua-pending"

let failures = 0

function eq<T>(label: string, actual: T, expected: T) {
    const ok = Object.is(actual, expected)
    if (!ok) failures++
    console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${ok ? "" : ` — got ${String(actual)}`}`)
}

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`)

/** `13` → an episode dated the day given, as `parseEpisodes` would hand it over. */
const ep = (number: number, date: string): Episode => ({
    number,
    url: `https://luciferdonghua.in/ancient-god-sovereign-episode-${number}-lucifer-donghua/`,
    airedAt: day(date)
})

const flagged = (episodes: Episode[]) => luciferdonghua.pendingInList!(episodes).map(e => e.number)

console.log("\n\x1b[1mluciferdonghua: the placeholder its own list gives away\x1b[0m\n")

/*
 * div.eplister as fetched on 2026-08-31, in full. E14 is the placeholder: its
 * page holds a tickcounter widget where E13's holds a Dailymotion embed, and it
 * carries July 1 while E13 — the episode that had gone live — carries August 30.
 */
const ancientGodSovereign = [
    ep(13, "2026-08-30"),
    ep(12, "2026-08-27"),
    ep(11, "2026-08-23"),
    ep(10, "2026-08-20"),
    ep(9, "2026-08-16"),
    ep(8, "2026-08-13"),
    ep(7, "2026-08-08"),
    ep(6, "2026-08-06"),
    ep(5, "2026-08-02"),
    ep(1, "2026-07-30"),
    ep(14, "2026-07-01")
]

eq("the real list flags E14 and nothing else", flagged(ancientGodSovereign).join(), "14")

/*
 * The same series four days earlier, when E13 was the countdown and E14 did not
 * exist. The habit has to be recognised at both observations or it is a
 * coincidence being fitted, not a rule.
 */
const fourDaysEarlier = [
    ep(12, "2026-08-27"),
    ep(11, "2026-08-23"),
    ep(10, "2026-08-20"),
    ep(9, "2026-08-16"),
    ep(8, "2026-08-13"),
    ep(7, "2026-08-08"),
    ep(6, "2026-08-06"),
    ep(5, "2026-08-02"),
    ep(1, "2026-07-30"),
    ep(13, "2026-07-01")
]
eq("and the same list four days earlier flags E13", flagged(fourDaysEarlier).join(), "13")

console.log("\n\x1b[1mand everything it must not flag\x1b[0m\n")

/*
 * Every case below is a real episode being suppressed if it went wrong, which is
 * the silent failure. The rule needs both halves — newest number AND uniquely
 * oldest date — and each of these removes exactly one of them.
 */

// An ordinary week: the newest episode is also the newest post.
eq(
    "a normally-dated list flags nothing",
    flagged([ep(14, "2026-09-03"), ep(13, "2026-08-30"), ep(1, "2026-07-30")]).length,
    0
)

// The oldest post, but not the newest episode. This is the late re-upload and
// the corrected typo — the objection that kept this rule out of the first cut.
eq(
    "an old episode dated oldest is not a placeholder",
    flagged([ep(14, "2026-08-30"), ep(13, "2026-08-27"), ep(2, "2026-07-01")]).length,
    0
)

// The newest episode, out of order, but not the oldest. Being *somewhat*
// backdated is what a re-upload looks like; being last is what the site does.
eq(
    "the newest episode merely out of order is not a placeholder",
    flagged([ep(14, "2026-08-25"), ep(13, "2026-08-30"), ep(1, "2026-07-30")]).length,
    0
)

// A site that dates in bulk — an import, a bulk edit — puts several posts on the
// same oldest day, which says nothing about any one of them.
eq(
    "a tie for oldest says nothing",
    flagged([ep(14, "2026-07-01"), ep(13, "2026-08-30"), ep(1, "2026-07-01")]).length,
    0
)

// No dates, or only some: no ordering to read.
eq(
    "an undated list flags nothing",
    flagged([
        { number: 14, url: "u" },
        { number: 13, url: "v" }
    ]).length,
    0
)
eq(
    "a partly dated list flags nothing",
    flagged([ep(13, "2026-08-30"), { number: 14, url: "u" }, ep(1, "2026-07-30")]).length,
    0
)
eq("a single episode flags nothing", flagged([ep(14, "2026-07-01")]).length, 0)
eq("an empty list flags nothing", flagged([]).length, 0)

// A source that has not declared the habit must never read a date this way. Any
// list is out of order sometimes, and lmanime's placeholder-free list going
// quiet would be a source that silently stops reporting.
eq("a source that declares nothing never flags from the list", lmanime.pendingInList?.(ancientGodSovereign).length, 0)

console.log("\n\x1b[1mthe other strategy: evidence on the episode page\x1b[0m\n")

/*
 * The marker path, which costs a request per candidate. Built here rather than
 * taken from a shipping source: luciferdonghua answers from its list now, so
 * nothing in sources/sites declares markers, and a mechanism with no test is a
 * mechanism that has quietly stopped working by the time it is next needed.
 */
const markerSite = new AnimeStream({
    id: "marker-site",
    name: "Marker Site",
    languages: ["en"],
    domains: ["example.test"],
    home: "https://example.test/",
    selectors: { playerIframe: "div.player-embed iframe[src]" },
    pending: {
        markers: ["a.tickcounter", "[data-type=countdown]"],
        text: ["video not available"],
        reason: "the site is counting down to it rather than playing it"
    }
})

const url = "https://example.test/ancient-god-sovereign-episode-13/"
const pending = (html: string) => markerSite.episodeAvailability!(html, url).pending

// --- the two states E13's page was observed in on 2026-08-27
eq("a tickcounter countdown means it is not out", pending(countdown), true)
eq('and so does the site\'s own "Video Not Available"', pending(notAvailable), true)

// --- the control, and the one that matters most
eq("E12's Dailymotion embed is an episode that is out", pending(playable), false)

/*
 * The ad frame is why the container is scoped. `div.megavid` sits above the
 * player with a `t.co` iframe in it, so a page-wide `iframe[src]` would find an
 * advert on the countdown page and call it playable.
 */
eq("an ad iframe above the player is not a player", pending(countdown), true)

/*
 * An embed wins outright, checked before any marker. A site is free to run a
 * countdown to the *next* episode above a player that works, and suppressing the
 * episode the viewer is actually on would be worse than the bug this fixes.
 */
eq("a countdown beside a working player does not suppress it", pending(countdownBesidePlayer), false)

/*
 * Silence is the default, and it has to be. The fallback test is "the player
 * container holds no embed", which is only evidence on a site that inlines its
 * player; a site building the player in JavaScript would have every episode
 * declared pending, and pending episodes are never announced.
 */
eq(
    "a source that declares no markers never calls anything pending",
    lmanime.episodeAvailability?.(countdown, url).pending,
    false
)

// The two strategies are independent: declaring markers is not declaring the
// date habit, or every marker site would start reading dates it never verified.
eq("declaring markers does not turn on the list rule", markerSite.pendingInList(ancientGodSovereign).length, 0)
eq(
    "and declaring the date habit does not invent markers",
    luciferdonghua.episodeAvailability(countdown, url).pending,
    false
)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
