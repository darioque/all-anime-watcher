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
 * The series list cannot tell such a post from a release — for a while its
 * dates seemed to, and a rule built on them missed Jade Dynasty S4 E12 — so the
 * episode page is what decides. Two questions, one answer:
 *
 *  - `unreleasedEpisodes`: of the episodes a refresh is about to announce, which
 *    are only countdowns? It opens their pages, highest first, and stops at the
 *    first one that is out. The request count is asserted below because it is
 *    the whole of what this costs, and the old version of this idea opened far
 *    too many.
 *  - `episodeAvailability`: the viewer has opened a page anyway, and
 *    `identify.ts` asks whether there is anything on it. The same verdict, off
 *    HTML already in hand.
 *
 * `npm run check:episodes` covers what follows from the post not being listed.
 * This covers reaching that verdict, which is the part that rots: the site
 * restyles, and the failure is silent in the worst direction — every episode
 * looks playable again and the countdown comes back.
 */
import type { Episode } from "~/model/types"
import type { FetchCtx } from "~/sources/types"
import { unreleasedEpisodes } from "~/library/unreleased"
import { luciferdonghua } from "~/sources/sites/luciferdonghua"
import { lmanime } from "~/sources/sites/lmanime"
import { countdown, countdownBesidePlayer, notAvailable, playable } from "./fixtures/luciferdonghua-pending"

let failures = 0

function eq<T>(label: string, actual: T, expected: T) {
    const ok = Object.is(actual, expected)
    if (!ok) failures++
    console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${ok ? "" : ` — got ${String(actual)}`}`)
}

const episodeUrl = (n: number) => `https://luciferdonghua.in/jade-dynasty-season-4-episode-${n}-lucifer-donghua/`
const episode = (n: number): Episode => ({ number: n, url: episodeUrl(n) })

/**
 * Walk `candidates` against a site whose episode pages are `pages` (by number;
 * a missing entry fails to load). Answers the numbers withheld, and how many
 * pages were opened to decide.
 */
async function withheld(numbers: number[], pages: Record<number, string>, source = luciferdonghua) {
    let requests = 0
    const ctx = {
        text: async (url: string) => {
            requests++
            const n = Number(/-episode-(\d+)-/.exec(url)?.[1])
            const html = pages[n]
            if (html === undefined) throw new Error(`HTTP 503 for ${url}`)
            return html
        },
        json: async () => ({}),
        baseUrl: "https://luciferdonghua.in"
    } as unknown as FetchCtx
    const out = await unreleasedEpisodes(source, numbers.map(episode), ctx)
    return { withheld: out.map(e => e.number).join(), requests }
}

console.log("\n\x1b[1mwhat a refresh withholds\x1b[0m\n")

// Jade Dynasty S4, October 2026: E12 listed like any release, a countdown on
// its page. The case the list-date rule missed.
let result = await withheld([12], { 12: countdown, 11: playable })
eq("a new episode whose page is a countdown is withheld", result.withheld, "12")
eq("and deciding that took one request", result.requests, 1)

result = await withheld([12], { 12: playable })
eq("a new episode that is out is kept", result.withheld, "")

result = await withheld([12], { 12: notAvailable })
eq('the site\'s own "Video Not Available" is withheld too', result.withheld, "12")

/*
 * Highest first, and stop at the first one that is out. A placeholder is posted
 * ahead of the release, so it is always at the top; whatever is below a real
 * episode is out too. This is what keeps a first look at a series — where the
 * whole list counts as new — to a request or two.
 */
result = await withheld([10, 11, 12], { 12: countdown, 11: playable, 10: playable })
eq("of three new episodes only the countdown on top is withheld", result.withheld, "12")
eq("and the walk stopped at the first one that is out", result.requests, 2)

result = await withheld([11, 12, 13], { 13: countdown, 12: countdown, 11: playable })
eq("two countdowns ahead are both withheld", result.withheld, "13,12")
eq("for one request each, plus the one that ended it", result.requests, 3)

const wholeList = Array.from({ length: 400 }, (_, i) => i + 1)
result = await withheld(wholeList, Object.fromEntries(wholeList.map(n => [n, playable])))
eq("four hundred new episodes cost one request", result.requests, 1)

console.log("\n\x1b[1mand every episode it must not swallow\x1b[0m\n")

// Uncertainty keeps the episode. A dropped real episode is silent; a listed
// countdown is one notification the viewer dismisses.
result = await withheld([12], {})
eq("a page that fails to load is kept", result.withheld, "")

result = await withheld([11, 12], { 11: countdown })
eq("and nothing below it is judged either", result.withheld, "")
eq("because the walk stops there", result.requests, 1)

// A countdown to the *next* episode above a working player is not this one.
result = await withheld([12], { 12: countdownBesidePlayer })
eq("a countdown beside a working player is kept", result.withheld, "")

// The opt-in is the source declaring markers. One that has not costs nothing.
result = await withheld([12], { 12: countdown }, lmanime)
eq("a source with no markers withholds nothing", result.withheld, "")
eq("and opens no page to find that out", result.requests, 0)

result = await withheld([], {})
eq("no new episodes, no requests", result.requests, 0)

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
eq("a source that declares no markers cannot be asked", lmanime.episodeAvailability, undefined)

// `reason` is printed by the player, so it is written to be read by a person.
eq(
    "the reason reaches the player as a sentence",
    luciferdonghua.episodeAvailability!(countdown, url).reason,
    "the site is counting down to it rather than playing it"
)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
