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
 * Two questions, asked in different places, and both are covered here:
 *
 *  - **The series list**, while it is parsed. `withoutBackdatedPlaceholder` is
 *    pure arithmetic over numbers and dates, so most of this file runs it
 *    directly; the last case in that section runs it through
 *    `luciferdonghua.getEpisodes` instead, because a rule that is right and not
 *    wired up looks identical from here.
 *  - **One episode page**, when the viewer opens it. `episodeAvailability`,
 *    which decides whether the visit counts as watching and gives the player
 *    something to say instead of an empty frame.
 *
 * `npm run check:episodes` covers what follows from the post not being in the
 * list. This covers reaching that verdict, which is the part that rots: the site
 * restyles or changes how it dates a placeholder, and the failure is silent in
 * the worst direction — every episode looks playable again and the countdown
 * comes back.
 */
import type { Episode, FetchCtx } from "~/model/types"
import { withoutBackdatedPlaceholder } from "~/sources/placeholders"
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

/** An episode as `parseEpisodes` hands it over. */
const ep = (number: number, date: string): Episode => ({
    number,
    url: `https://luciferdonghua.in/ancient-god-sovereign-episode-${number}-lucifer-donghua/`,
    airedAt: day(date)
})

/** The numbers left after the rule has had its say. */
const kept = (episodes: Episode[]) =>
    withoutBackdatedPlaceholder(episodes)
        .map(e => e.number)
        .join()

console.log("\n\x1b[1mthe placeholder a series list gives away\x1b[0m\n")

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
eq("the real list loses E14 and nothing else", kept(ancientGodSovereign), "13,12,11,10,9,8,7,6,5,1")

/*
 * The same series four days earlier, when E13 was the countdown and E14 did not
 * exist. The habit has to be recognised at both observations, or it is a
 * coincidence being fitted rather than a rule.
 */
eq(
    "and the same list four days earlier loses E13",
    kept([ep(12, "2026-08-27"), ep(5, "2026-08-02"), ep(1, "2026-07-30"), ep(13, "2026-07-01")]),
    "12,5,1"
)

console.log("\n\x1b[1mand every episode it must not touch\x1b[0m\n")

/*
 * Each of these is a real episode dropped if it went wrong, and dropping one is
 * the silent failure — nobody learns they missed it. The rule needs both halves,
 * newest number AND uniquely oldest date, and each case removes exactly one.
 */

// An ordinary week: the newest episode is also the newest post.
eq(
    "a normally-dated list keeps everything",
    kept([ep(14, "2026-09-03"), ep(13, "2026-08-30"), ep(1, "2026-07-30")]),
    "14,13,1"
)

// Oldest post, but not the newest episode. This is the late re-upload and the
// corrected typo — the objection that kept this rule out of the first cut.
eq(
    "an old episode dated oldest is not a placeholder",
    kept([ep(14, "2026-08-30"), ep(13, "2026-08-27"), ep(2, "2026-07-01")]),
    "14,13,2"
)

// Newest episode, out of order, but not the oldest. Being *somewhat* backdated
// is what a re-upload looks like; being last is what this site does.
eq(
    "the newest episode merely out of order is not a placeholder",
    kept([ep(14, "2026-08-25"), ep(13, "2026-08-30"), ep(1, "2026-07-30")]),
    "14,13,1"
)

// A bulk edit or an import puts several posts on the same oldest day, which says
// nothing about any one of them.
eq("a tie for oldest says nothing", kept([ep(14, "2026-07-01"), ep(13, "2026-08-30"), ep(1, "2026-07-01")]), "14,13,1")

// No dates, or only some: there is no ordering to read.
eq(
    "an undated list is untouched",
    kept([
        { number: 14, url: "u" },
        { number: 13, url: "v" }
    ]),
    "14,13"
)
eq(
    "a partly dated list is untouched",
    kept([ep(13, "2026-08-30"), { number: 14, url: "u" }, ep(1, "2026-07-30")]),
    "13,14,1"
)
eq("a single episode is untouched", kept([ep(14, "2026-07-01")]), "14")
eq("an empty list stays empty", kept([]), "")

console.log("\n\x1b[1mand that the source actually applies it\x1b[0m\n")

/*
 * Through the real parser, because the rule being right is only half of it: it
 * lives inside `parseEpisodes` so that *every* caller is protected — the update
 * loop, the Lab page and the probe all read this list, and only the first of
 * them used to be.
 */
const li = (num: string, slug: string, date: string) =>
    `<li><a href="https://luciferdonghua.in/${slug}/">` +
    `<div class="epl-num">${num}</div><div class="epl-title">Ancient God Sovereign ${num}</div>` +
    `<div class="epl-sub"><span class="status Sub">Sub</span></div><div class="epl-date">${date}</div></a></li>`

const seriesPage =
    `<html><body><div class="eplister"><ul>` +
    li("13 [4K]", "ancient-god-sovereign-episode-13-lucifer-donghua", "August 30, 2026") +
    li("12 [4K]", "ancient-god-sovereign-episode-12-lucifer-donghua", "August 27, 2026") +
    li("01 to 04 [4K]", "ancient-god-sovereign-episode-01-to-04-lucifer-dognhua", "July 30, 2026") +
    li("14 [4K]", "ancient-god-sovereign-episode-14-lucifer-donghua", "July 1, 2026") +
    `</ul></div></body></html>`

const ctx = {
    text: async () => seriesPage,
    json: async () => ({}),
    baseUrl: "https://luciferdonghua.in"
} as unknown as FetchCtx

const listed = await luciferdonghua.getEpisodes("https://luciferdonghua.in/anime/ancient-god-sovereign/", ctx)
eq("getEpisodes never hands E14 to anybody", listed.map(e => e.number).join(), "13,12,1")

// The same page from a source without the habit declared. Any list is out of
// order sometimes, and lmanime's going quiet would be a source that silently
// stops reporting episodes.
const fromLmanime = await lmanime.getEpisodes("https://lmanime.com/ancient-god-sovereign/", ctx)
eq("a source that has not declared the habit keeps every post", fromLmanime.map(e => e.number).join(), "14,13,12,1")

console.log("\n\x1b[1mthe other question: this page, right now\x1b[0m\n")

/*
 * Asked when the viewer opens an episode. Nothing to do with announcing — that
 * post is already gone from the list — but somebody can still arrive from a
 * bookmark or from the site's own navigation, and this is what stops the visit
 * counting as watched and puts a sentence where the video would be.
 */
const url = "https://luciferdonghua.in/ancient-god-sovereign-episode-14-lucifer-donghua/"
const pending = (html: string) => luciferdonghua.episodeAvailability!(html, url).pending

eq("a tickcounter countdown means it is not out", pending(countdown), true)
eq('and so does the site\'s own "Video Not Available"', pending(notAvailable), true)

// The control, and the one that matters most: a false positive here is an
// episode the viewer is told they cannot watch while it plays behind the notice.
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
 * Silence is the default. The fallback test is "the player container holds no
 * embed", which is only evidence on a site that inlines its player; a site
 * building the player in JavaScript would have every episode declared pending.
 */
eq(
    "a source that declares no markers never calls anything pending",
    lmanime.episodeAvailability?.(countdown, url).pending,
    false
)

// The two are declared independently: reading the list is not reading the page.
eq(
    "the reason reaches the player, so it is written for a person",
    luciferdonghua.episodeAvailability!(countdown, url).reason,
    "the site is counting down to it rather than playing it"
)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
