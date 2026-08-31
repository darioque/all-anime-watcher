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
import {
    latestEpisode,
    latestEpisodeNumber,
    newReleases,
    pointerRollback,
    nextEpisode,
    positionDrift,
    resumePositionFor,
    unwatchedCount,
    watchState
} from "~/model/keys"
import { marksOnOpen, onOpenMark } from "~/settings/watching"
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

/*
 * ---------------------------------------------------------------------------
 * Posted, but not out
 *
 * luciferdonghua.in published Ancient God Sovereign E13 as a post with a
 * tickcounter.com countdown where the player goes, backdated so it sorted below
 * episode 1 in the series list. The list diff was right again — E13 really was
 * new — and calling it a release was not: the notification opened a page whose
 * five servers each resolved to nothing, and the watch position had already
 * moved to it on the way in.
 *
 * The answer is that such a post is not in the episode list at all. The check
 * run opens it, sees a countdown, and drops it *before* the diff — so there is
 * nothing here to test beyond that: every function below is looking at a list of
 * episodes, which is the only thing it has ever had to handle.
 *
 * The version that kept the post under a `pending` flag needed a rule in every
 * one of these functions, plus a second announcement path for the moment the
 * flag came off, plus the same rule again in the player, the shelves and the
 * group aggregates — where it was missed, and the next-episode arrow lit up for
 * a countdown. What follows is the whole of what replaced all of that: the
 * source never returns the post, so none of these functions knows it exists.
 * Reaching that verdict is `check:pending`.
 * ---------------------------------------------------------------------------
 */
console.log("\n\x1b[1mposted, but not out\x1b[0m\n")

// The list as the check run stores it while the countdown stands: E13 dropped,
// so the newest thing there is E12 and the viewer is on it.
const withCountdown = { episodes: range(1, 12), lastWatched: at(12), follow: true }

eq("a countdown is not the newest episode", latestEpisodeNumber(withCountdown), 12)
eq("…so the position is not adrift from it", positionDrift(withCountdown), 0)
eq("it does not light the badge", unwatchedCount(withCountdown), 0)
eq("the row reads as caught up, not as new", watchState(withCountdown), "current")
eq('"watch next" does not open it', nextEpisode(withCountdown), undefined)
eq("nor does the newest-episode link", latestEpisode(withCountdown)?.number, 12)

// A series whose only post is a placeholder stores an empty list, which reads as
// "unstarted" — the same state as a source that returned nothing, because it is.
eq(
    "a series of nothing but countdowns is unstarted",
    watchState({ episodes: [], lastWatched: undefined, follow: true }),
    "unstarted"
)

/*
 * And the day it airs it is simply an episode that was not in the stored list
 * and is now — which is what the diff has always announced. This is the release
 * the old `wentLive` had to exist to catch: with the placeholder stored, nothing
 * about the list changed when the video went up, so the diff could not see it.
 */
const wentUp = { episodes: range(1, 13), lastWatched: at(12), follow: true }
eq(
    "once it is out it is an ordinary new release",
    newReleases({ added: range(13, 13), previousHighest: 12, watchedUpTo: 12 })
        .map(e => e.number)
        .join(),
    "13"
)
eq("the badge lights", unwatchedCount(wentUp), 1)
eq("…and the row says so", watchState(wentUp), "new")
eq("…and watch next opens it", nextEpisode(wentUp)?.number, 13)

// The floor is still what keeps a backfill quiet, and dropping the placeholder
// does not move it: E13 never entered the list, so the previous highest is 12.
eq(
    "a backfill arriving beside it is still not announced",
    newReleases({ added: [...range(4, 4), ...range(13, 13)], previousHighest: 12, watchedUpTo: 12 })
        .map(e => e.number)
        .join(),
    "13"
)

console.log("\n\x1b[1mwhen an on-open mark may be recorded\x1b[0m\n")

/*
 * Deliberately a two-input rule with no special cases. Everything that could go
 * wrong on the page — no servers listed, a countdown where the player goes, five
 * servers that each resolve to nothing — reaches the same place on its own: the
 * player never attaches anything, so `whenPlaying` never arrives and nothing is
 * marked. Encoding those separately here would be three more chances to get one
 * of them wrong, for no behaviour that this does not already produce.
 */
eq(
    "with our player on the page, the mark waits for a picture",
    onOpenMark({ marks: true, takeOverPage: true }),
    "whenPlaying"
)

/*
 * With the site's own player left in place, nothing of ours ever attaches to the
 * video, so no later moment is coming — the page read is the only signal there
 * will ever be, which is what `marksOnOpen` decided above.
 */
eq("with the site's own player, the page read is the moment", onOpenMark({ marks: true, takeOverPage: false }), "now")

eq("opening not counting at all wins either way", onOpenMark({ marks: false, takeOverPage: true }), "never")
eq("…including with no player of ours", onOpenMark({ marks: false, takeOverPage: false }), "never")

console.log("\n\x1b[1ma position on something that cannot be watched\x1b[0m\n")

/*
 * Two situations that turned out to be one. The episode was pulled or
 * renumbered, or it was a countdown the check run has just dropped — by the time
 * this reads the list, both are "the pointer names something that is not there",
 * and there is nothing here that could tell them apart even if it wanted to.
 * That is the point: the pointer names something the viewer cannot be sitting
 * at, and the difference is invisible where it matters — the row says "Up to
 * date" at an episode that does not exist, the badge stays dark and "watch next"
 * returns nothing.
 */
const gone = pointerRollback({ episodes: range(1, 12), lastWatched: at(13) })
eq("a position on an episode the list no longer carries rolls back", gone?.from, 13)
eq("…to the newest one that is actually there", gone?.to, 12)

// A renumbering is the same shape, just a bigger gap. It rolls back one step to
// the top of the list rather than to zero: the viewer really did watch what is
// below, and marking a whole run unwatched would invent a backlog.
eq(
    "a renumbering lands on the top of the new list, not on zero",
    pointerRollback({ episodes: range(1, 12), lastWatched: at(476) })?.to,
    12
)

eq("a position on a real episode is left alone", pointerRollback({ episodes: range(1, 13), lastWatched: at(13) }), null)
eq("no position, nothing to roll back", pointerRollback({ episodes: range(1, 12), lastWatched: null }), null)

/*
 * An empty list is a failed or pending fetch, not a renumbering. Acting on it
 * would wipe the pointer of every series the moment a site had a bad minute.
 */
eq("an empty list changes nothing", pointerRollback({ episodes: [], lastWatched: at(13) }), null)

/*
 * Nothing below at all — the pointer has nowhere to go and is cleared. This is
 * the shape a series takes when its only post turns out to be a countdown: the
 * check run drops it, the stored list is E2 upwards, and a pointer at E1 names
 * nothing.
 */
eq(
    "a position below everything the list holds is cleared",
    pointerRollback({ episodes: range(2, 3), lastWatched: at(1) })?.to,
    null
)

/*
 * And the rollback is what puts the row back in a state that tells the truth: a
 * pointer left on a dropped E13 reads as caught up at an episode that is not
 * there, and stays that way when the real one lands.
 */
const rolled = { episodes: range(1, 12), lastWatched: at(12), follow: true }
eq("after rolling back, the dropped post still does not light the badge", unwatchedCount(rolled), 0)
eq("…and once it goes live, it does", unwatchedCount({ ...rolled, episodes: range(1, 13) }), 1)
eq("…and watch next opens it", nextEpisode({ ...rolled, episodes: range(1, 13) })?.number, 13)

console.log("\n\x1b[1mwhere an episode resumes\x1b[0m\n")

/** A stored progress entry. `completed` defaults on, which is the whole point. */
const stopped = (positionSec: number, durationSec?: number, completed = true) => ({
    positionSec,
    ...(durationSec ? { durationSec } : {}),
    completed,
    updatedAt: 0
})

/*
 * The bug this exists for. `completionThreshold` is a *tracking* setting and 0
 * is a supported value — it marks an episode a second in, on purpose. Resume
 * used to refuse on `completed`, so that one setting silently switched resuming
 * off for the whole library, on every episode, and nothing connected the two.
 */
eq("a completed episode still resumes", resumePositionFor(stopped(600, 1440)), 600)
eq("…and so does one marked a second in", resumePositionFor(stopped(430, 1440, true)), 430)

eq("nothing stored starts at the beginning", resumePositionFor(undefined), null)
eq("the first few seconds are not a position", resumePositionFor(stopped(4, 1440)), null)
eq("but past the floor is", resumePositionFor(stopped(6, 1440)), 6)

/*
 * Watched to the end is the case the old `completed` test was reaching for, and
 * the position says it without consulting any setting.
 */
eq("a position at the end starts over", resumePositionFor(stopped(1440, 1440)), null)
eq("…and so does one inside the last few seconds", resumePositionFor(stopped(1430, 1440)), null)
eq("just before that still resumes", resumePositionFor(stopped(1420, 1440)), 1420)

/*
 * No duration is the honest unknown: not every stream reports one. The position
 * is then all there is, and resuming is the better guess — seeking back is one
 * keypress, losing forty minutes is not.
 */
eq("an unknown duration resumes on the position alone", resumePositionFor(stopped(2400)), 2400)
eq("a zero duration is not a duration", resumePositionFor(stopped(2400, 0)), 2400)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
