/**
 * Exercise "did this actually come out, or did we just start seeing it?"
 *
 *   npm run check:episodes
 *
 * The bug this exists for: myanime.live's episode lists used to stop at 100
 * posts. When pagination was added, three followed series each grew by a
 * hundred-odd episodes in one check — all of them *older* than the one the
 * viewer was on — and every one of them raised a "new episodes" notification.
 * The list diff was right. Calling that diff "new" was not.
 */
import { latestEpisodeNumber, newReleases, positionDrift, unwatchedCount } from "~/model/keys"
import { marksOnOpen } from "~/settings/watching"
import type { Episode } from "~/model/types"

let failures = 0

function eq<T>(label: string, actual: T, expected: T) {
    const ok = Object.is(actual, expected)
    if (!ok) failures++
    console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${ok ? "" : ` — got ${String(actual)}`}`)
}

/** Episodes `from`..`to` inclusive, as a source would hand them over. */
const range = (from: number, to: number): Episode[] =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ number: from + i, url: `https://x/ep-${from + i}` }))

/** A watch pointer. */
const at = (number: number) => ({ number, at: 0 })

console.log("\n\x1b[1mreleases vs backfill\x1b[0m\n")

// --- the case that shipped a wrong notification
//
// myanime/lin-feng: the stored list held E377..E476 (one unpaginated page), the
// viewer was caught up at E476, and pagination revealed E356..E376.
const linFeng = newReleases({ added: range(356, 376), previousHighest: 476, watchedUpTo: 476 })
eq("a backfill below the newest known episode announces nothing", linFeng.length, 0)

// myanime/fan-ren-xiu-xian-chuan: same shape, viewer at E188.
eq(
    "…however many episodes the backfill contains",
    newReleases({ added: range(1, 102), previousHighest: 209, watchedUpTo: 188 }).length,
    0
)

// --- and the case it must not break
eq(
    "a genuine new episode still announces",
    newReleases({ added: range(477, 477), previousHighest: 476, watchedUpTo: 476 })[0]?.number,
    477
)

const mixed = newReleases({ added: [...range(356, 376), ...range(477, 479)], previousHighest: 476, watchedUpTo: 476 })
eq("a backfill and a release in the same check keeps only the release", mixed.length, 3)
eq("and keeps the right ones", mixed[0]?.number, 477)

// --- the watch pointer is a floor of its own
//
// Removing a series and re-adding it leaves no previous list, but the viewer's
// position survives elsewhere; announcing the whole run then is the same noise.
eq(
    "an empty previous list still respects where the viewer got to",
    newReleases({ added: range(1, 476), previousHighest: null, watchedUpTo: 476 }).length,
    0
)
eq(
    "and the higher of the two floors wins",
    newReleases({ added: range(1, 300), previousHighest: 100, watchedUpTo: 250 }).length,
    50
)

// A viewer *behind* the source does not suppress releases above the old high.
eq(
    "being behind does not suppress a real release",
    newReleases({ added: range(101, 103), previousHighest: 100, watchedUpTo: 12 }).length,
    3
)

// --- nothing to compare against
eq(
    "a first-ever list has no floor and reports everything",
    newReleases({ added: range(1, 12), previousHighest: null }).length,
    12
)
eq("an empty diff stays empty", newReleases({ added: [], previousHighest: 5, watchedUpTo: 5 }).length, 0)

// --- fractional numbers, which recap and OVA posts really do use
eq(
    "a .5 episode above the floor is a release",
    newReleases({ added: [{ number: 476.5, url: "u" }], previousHighest: 476, watchedUpTo: 476 }).length,
    1
)
eq(
    "and one below it is not",
    newReleases({ added: [{ number: 475.5, url: "u" }], previousHighest: 476, watchedUpTo: 476 }).length,
    0
)

// --- episode 0 is a real episode number, so no falsy floors
eq(
    "episode 0 as a watch position is a floor, not 'unset'",
    newReleases({ added: [{ number: 0, url: "u" }], previousHighest: 0, watchedUpTo: 0 }).length,
    0
)

console.log("\n\x1b[1mepisode spans\x1b[0m\n")

/*
 * The other half of the same report: the row said "121 ep" beside "at E476".
 * Both numbers were right — this source starts at E356 — but shown alone the
 * count reads as a series that lost four hundred episodes.
 */
const partial = { episodes: range(356, 476), lastWatched: { number: 476, at: 0 } }
eq("a partial list knows its newest episode", latestEpisodeNumber(partial), 476)
eq("which is not its length", partial.episodes.length, 121)
eq("and a viewer at the newest has nothing unwatched", unwatchedCount(partial), 0)

console.log("\n\x1b[1mposition drift\x1b[0m\n")

/*
 * AMR resets the position to zero when it cannot find the chapter you were on,
 * because its position *is* a URL and a URL that vanished leaves nothing. Ours
 * is a number, so it stays meaningful with or without a post to point at, and
 * resetting would throw away real state — see `positionDrift`. Nothing here
 * mutates anything; it only measures the gap.
 */
eq("a pointer inside the list does not drift", positionDrift({ episodes: range(1, 12), lastWatched: at(7) }), 0)
eq("nor does one exactly at the newest", positionDrift({ episodes: range(1, 12), lastWatched: at(12) }), 0)
eq("a renumbered source shows the whole gap", positionDrift({ episodes: range(1, 12), lastWatched: at(476) }), 464)
eq(
    "an episode pulled for re-upload drifts by one",
    positionDrift({ episodes: range(356, 475), lastWatched: at(476) }),
    1
)

// The two cases that must never look like a renumbering, because both are
// ordinary and both would otherwise nag on every render.
eq("an empty list is a failed fetch, not drift", positionDrift({ episodes: [], lastWatched: at(476) }), 0)
eq("and an unstarted series cannot drift", positionDrift({ episodes: range(1, 12) }), 0)

// The pointer surviving is the whole point: a partial list still reports its own
// position rather than being reset to the bottom of it.
eq(
    "a partial list keeps the position it was given",
    unwatchedCount({ episodes: range(356, 476), lastWatched: at(400) }),
    76
)

console.log("\n\x1b[1mopening an episode as a watch signal\x1b[0m\n")

const marking = (onOpen: boolean, takeOver: boolean, onEmbed: boolean) =>
    marksOnOpen({ markWatchedOnOpen: onOpen, takeOverPage: takeOver, markWatchedOnEmbed: onEmbed })

eq("opening marks it when that is what the setting says", marking(true, true, false), true)
eq("and still does with the site's own player left in place", marking(true, false, false), true)

/*
 * The case that was silently broken. "Replace the site's player" off means
 * nothing of ours ever touches the video, so the completion threshold has no
 * signal to work from and the progress tick never fires. Opening the page is
 * the only moment the episode can be recorded at all — the same reason the
 * player marks an iframe stream on sight.
 */
eq("with no player of ours, opening is the only signal there is", marking(false, false, true), true)
eq("unless that signal was turned off too", marking(false, false, false), false)

/*
 * And the case that must stay untouched: our player is mounted, so the watch
 * time is measurable and is what decides. Marking on open here would credit
 * every episode the moment it was opened, which is the behaviour the viewer
 * turned off.
 */
eq("our own player measures instead of assuming", marking(false, true, true), false)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
