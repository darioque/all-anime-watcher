/**
 * Exercise "has this episode actually come out, or has the site only posted it?"
 *
 *   npm run check:pending
 *
 * The bug this exists for: luciferdonghua.in published Ancient God Sovereign E13
 * as a normal-looking post with a tickcounter.com countdown where the player
 * goes. Nothing on the *series* page distinguished it — same markup, same "[4K]"
 * number, the same five servers in `select.mirror` — so it was announced as a
 * release, the notification opened a page whose five servers each resolved to
 * nothing, and the watch position had already moved onto it on the way in.
 *
 * `npm run check:episodes` covers the rules that follow from a pending verdict.
 * This covers reaching the verdict at all, which is selector work and therefore
 * the part that rots: the site restyles, `div.player-embed` becomes something
 * else, and the failure is silent in the worst direction — every episode looks
 * playable again and the countdown comes back.
 */
import { luciferdonghua } from "~/sources/sites/luciferdonghua"
import { lmanime } from "~/sources/sites/lmanime"
import { countdown, countdownBesidePlayer, notAvailable, playable } from "./fixtures/luciferdonghua-pending"

let failures = 0

function eq<T>(label: string, actual: T, expected: T) {
    const ok = Object.is(actual, expected)
    if (!ok) failures++
    console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${ok ? "" : ` — got ${String(actual)}`}`)
}

const url = "https://luciferdonghua.in/ancient-god-sovereign-episode-13-lucifer-donghua/"
const pending = (html: string) => luciferdonghua.episodeAvailability!(html, url).pending

console.log("\n\x1b[1mluciferdonghua: posted, or actually out\x1b[0m\n")

// --- the two states E13 was observed in
eq("a tickcounter countdown means it is not out", pending(countdown), true)
eq('and so does the site\'s own "Video Not Available"', pending(notAvailable), true)

// --- the control, and the one that matters most
//
// A false positive here is an episode that is never announced at all, which is
// silent. Everything below guards that direction.
eq("E12's Dailymotion embed is an episode that is out", pending(playable), false)

/*
 * The ad frame is why the container is scoped. `div.megavid` sits above the
 * player with a `t.co` iframe in it, so a page-wide `iframe[src]` would find an
 * advert on the countdown page and call it playable — the same mistake that made
 * `playerIframe` a per-site selector in the first place.
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
 * declared pending, and pending episodes are never announced — a source that
 * silently stops reporting. lmanime declares no markers, so it never answers.
 */
eq(
    "a source that declares no markers never calls anything pending",
    lmanime.episodeAvailability?.(countdown, url).pending,
    false
)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
