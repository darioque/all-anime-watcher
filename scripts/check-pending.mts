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
 * Everything below goes through `getEpisodes`, because that is what everything
 * else goes through — the update loop, the Lab page, the CLI probe. A post the
 * site cannot play yet is not an episode and never leaves the source, so there
 * is nothing else to call and nothing downstream that knows the idea exists.
 *
 * The one other thing here is `episodeAvailability`, which is a different
 * question in a different place: the viewer has opened that page anyway, from a
 * bookmark or the site's own navigation, and `identify.ts` asks whether there is
 * anything on it. That decides whether the visit counts as watching and gives
 * the player a sentence to show instead of an empty frame.
 *
 * `npm run check:episodes` covers what follows from the post not being listed.
 * This covers reaching that verdict, which is the part that rots: the site
 * restyles or changes how it dates a placeholder, and the failure is silent in
 * the worst direction — every episode looks playable again and the countdown
 * comes back.
 */
import type { FetchCtx } from "~/sources/types"
import { luciferdonghua } from "~/sources/sites/luciferdonghua"
import { lmanime } from "~/sources/sites/lmanime"
import { countdown, countdownBesidePlayer, notAvailable, playable } from "./fixtures/luciferdonghua-pending"

let failures = 0

function eq<T>(label: string, actual: T, expected: T) {
    const ok = Object.is(actual, expected)
    if (!ok) failures++
    console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${ok ? "" : ` — got ${String(actual)}`}`)
}

/** One `div.eplister` row, as the theme writes it. */
const row = ([num, date]: [string, string]) =>
    `<li><a href="https://luciferdonghua.in/ancient-god-sovereign-episode-${num.split(" ")[0]}-lucifer-donghua/">` +
    `<div class="epl-num">${num}</div><div class="epl-title">Ancient God Sovereign ${num}</div>` +
    `<div class="epl-sub"><span class="status Sub">Sub</span></div><div class="epl-date">${date}</div></a></li>`

const ctxFor = (rows: [string, string][]) =>
    ({
        text: async () => `<html><body><div class="eplister"><ul>${rows.map(row).join("")}</ul></div></body></html>`,
        json: async () => ({}),
        baseUrl: "https://luciferdonghua.in"
    }) as unknown as FetchCtx

/** The episode numbers a source hands back for this list, in order. */
const listed = async (rows: [string, string][], source = luciferdonghua) =>
    (await source.getEpisodes("https://luciferdonghua.in/anime/ancient-god-sovereign/", ctxFor(rows)))
        .map(e => e.number)
        .join()

console.log("\n\x1b[1mwhat getEpisodes hands back\x1b[0m\n")

/*
 * div.eplister as fetched on 2026-09-03, in full, and the list that broke the
 * first version of this rule. E15 is the placeholder — its page holds a
 * tickcounter widget — and it carries August 1 while E14, the episode that had
 * gone live that morning, carries September 3.
 *
 * Note where it sits: *above* E01-04, not below. The first rule asked for the
 * uniquely oldest date and this list does not give it one, so E15 was announced
 * as a release. Reading the shape of the date instead of the position is the
 * whole of the change.
 */
const ancientGodSovereign: [string, string][] = [
    ["14 [4K]", "September 3, 2026"],
    ["13 [4K]", "August 30, 2026"],
    ["12 [4K]", "August 27, 2026"],
    ["11 [4K]", "August 23, 2026"],
    ["10 [4K]", "August 20, 2026"],
    ["09 [4K]", "August 16, 2026"],
    ["08 [4K]", "August 13, 2026"],
    ["07 [4K]", "August 8, 2026"],
    ["06 [4K]", "August 6, 2026"],
    ["05 [4K]", "August 2, 2026"],
    ["15 [4K]", "August 1, 2026"],
    ["01 to 04 [4K]", "July 30, 2026"]
]
eq("the real list comes back without E15", await listed(ancientGodSovereign), "14,13,12,11,10,9,8,7,6,5,1")

/*
 * The same series three days earlier, when E14 was the countdown, and four days
 * before that, when it was E13. Back then the placeholder did sort last. The
 * habit has to be recognised at all three observations, or it is a coincidence
 * being fitted rather than a rule.
 */
eq(
    "the same list three days earlier comes back without E14",
    await listed([
        ["13 [4K]", "August 30, 2026"],
        ["05 [4K]", "August 2, 2026"],
        ["01 to 04 [4K]", "July 30, 2026"],
        ["14 [4K]", "July 1, 2026"]
    ]),
    "13,5,1"
)
eq(
    "and a week earlier comes back without E13",
    await listed([
        ["12 [4K]", "August 27, 2026"],
        ["05 [4K]", "August 2, 2026"],
        ["01 to 04 [4K]", "July 30, 2026"],
        ["13 [4K]", "July 1, 2026"]
    ]),
    "12,5,1"
)

console.log("\n\x1b[1mand every episode it must not swallow\x1b[0m\n")

/*
 * Each of these is a real episode lost if it went wrong, and losing one is the
 * silent failure — nobody learns they missed it. The rule needs all three of
 * newest number, strictly older than the newest post, and dated to a 1st; each
 * case below withholds exactly one of them.
 */

// An ordinary week: the newest episode is also the newest post.
eq(
    "a normally-dated list keeps everything",
    await listed([
        ["14", "September 3, 2026"],
        ["13", "August 30, 2026"],
        ["01", "July 30, 2026"]
    ]),
    "14,13,1"
)

// Backdated to a 1st, but not the newest episode. This is the late re-upload and
// the corrected typo — the objection that kept this rule out of the first cut.
eq(
    "an old episode backdated to a 1st is not a placeholder",
    await listed([
        ["14", "August 30, 2026"],
        ["13", "August 27, 2026"],
        ["02", "July 1, 2026"]
    ]),
    "14,13,2"
)

// Newest episode, out of order, but on a real day of the month. Being *somewhat*
// backdated is what a re-upload looks like; landing on a 1st is what this site
// does. This is the case position-alone would have swallowed.
eq(
    "the newest episode merely out of order is not a placeholder",
    await listed([
        ["14", "August 25, 2026"],
        ["13", "August 30, 2026"],
        ["01", "July 30, 2026"]
    ]),
    "14,13,1"
)

// Episodes do come out on the 1st. That alone says nothing: a real one is the
// newest post, which is the other half of the test.
eq(
    "a genuine release on the 1st is kept",
    await listed([
        ["15", "September 1, 2026"],
        ["14", "August 30, 2026"],
        ["01", "July 30, 2026"]
    ]),
    "15,14,1"
)

// This list carries a date and no clock, so a same-day double release ties for
// newest. "Not the newest post" has to mean strictly older or every second
// episode of a double drop disappears.
eq(
    "a tie for newest is not out of order",
    await listed([
        ["14", "September 1, 2026"],
        ["13", "September 1, 2026"],
        ["01", "July 30, 2026"]
    ]),
    "14,13,1"
)

// No dates, or only some: there is no ordering to read.
eq(
    "an undated list is untouched",
    await listed([
        ["14", ""],
        ["13", ""]
    ]),
    "14,13"
)
// Sorted by number like any other list — the undated E14 leads because it is
// the highest, not because anything decided anything about it.
eq(
    "a partly dated list is untouched",
    await listed([
        ["13", "August 30, 2026"],
        ["14", ""],
        ["01", "July 30, 2026"]
    ]),
    "14,13,1"
)
eq("a single episode is untouched", await listed([["14", "July 1, 2026"]]), "14")

// Any list is out of order sometimes. A source that has not declared the habit
// going quiet would be a source that silently stops reporting episodes.
eq(
    "a source that has not declared the habit keeps every post",
    await listed(ancientGodSovereign, lmanime),
    "15,14,13,12,11,10,9,8,7,6,5,1"
)

console.log("\n\x1b[1mthe one it gets wrong\x1b[0m\n")

/*
 * Constructed, and asserted so the trade-off is visible rather than discovered:
 * a real episode released on the 1st, in a list where an older post has just
 * been re-published and taken today's date. Both halves hold and the episode is
 * dropped.
 *
 * It is kept as the known cost because it needs two uncommon things at once,
 * and because the alternative — dropping the date-shape half and reading
 * position alone — gets this same case wrong on *any* day of the month rather
 * than one in thirty. If it is ever seen live, the next condition to add is
 * that the placeholder be at least a month old, which every observed one is.
 */
eq(
    "a release on the 1st under a re-published older post is lost",
    await listed([
        ["14", "September 1, 2026"],
        ["13", "September 3, 2026"],
        ["01", "July 30, 2026"]
    ]),
    "13,1"
)

console.log("\n\x1b[1mthe other question: this page, right now\x1b[0m\n")

const url = "https://luciferdonghua.in/ancient-god-sovereign-episode-14-lucifer-donghua/"
const pending = (html: string) => luciferdonghua.episodeAvailability!(html, url).pending

eq("a tickcounter countdown means it is not out", pending(countdown), true)
eq('and so does the site\'s own "Video Not Available"', pending(notAvailable), true)

// The control, and the one that matters most: a false positive here tells the
// viewer they cannot watch an episode that is playing behind the notice.
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
eq("a source that declares no markers never answers", lmanime.episodeAvailability?.(countdown, url).pending, false)

// `reason` is printed by the player, so it is written to be read by a person.
eq(
    "the reason reaches the player as a sentence",
    luciferdonghua.episodeAvailability!(countdown, url).reason,
    "the site is counting down to it rather than playing it"
)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
