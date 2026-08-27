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
    nextEpisode,
    positionDrift,
    resumePositionFor,
    unwatchedCount,
    verificationCandidates,
    watchState,
    wentLive
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
 * ---------------------------------------------------------------------------
 */
console.log("\n\x1b[1mposted, but not out\x1b[0m\n")

/** An episode the site has posted with nothing behind it. */
const soon = (number: number): Episode => ({
    number,
    url: `https://x/ep-${number}`,
    pending: true,
    pendingReason: "a countdown"
})

// --- the case that shipped
eq(
    "a countdown post is not a release",
    newReleases({ added: [soon(13)], previousHighest: 12, watchedUpTo: 12 }).length,
    0
)
eq(
    "…even when a real episode arrives beside it",
    newReleases({ added: [soon(14), ...range(13, 13)], previousHighest: 12, watchedUpTo: 12 })
        .map(e => e.number)
        .join(),
    "13"
)

// --- and the release it must not swallow
//
// The placeholder is in the stored list from the first check that saw it, so
// when the video goes up nothing about the list changes. Only `wentLive` sees it.
eq(
    "the countdown announces when it finally goes live",
    wentLive([soon(13)], range(13, 13))
        .map(e => e.number)
        .join(),
    "13"
)
eq("…and only then, not on every check in between", wentLive([soon(13)], [soon(13)]).length, 0)
eq("an episode that was never pending is not announced twice", wentLive(range(12, 12), range(12, 13)).length, 0)
eq(
    "a placeholder that turns into a *different* episode number is not it",
    wentLive([soon(13)], range(14, 14)).length,
    0
)

// The list is re-fetched whole and this site reorders it — the placeholder is
// backdated below episode 1 — so the match has to be by number, not by position.
eq(
    "the transition is matched by number, whatever order the site returns",
    wentLive([soon(13), ...range(1, 12)], [...range(1, 13)].reverse())
        .map(e => e.number)
        .join(),
    "13"
)

// --- what the rest of the library sees meanwhile
const withCountdown = { episodes: [...range(1, 12), soon(13)], lastWatched: at(12), follow: true }

eq("a countdown is not the newest episode", latestEpisodeNumber(withCountdown), 12)
eq("…so the position is not adrift from it", positionDrift(withCountdown), 0)
eq("it does not light the badge", unwatchedCount(withCountdown), 0)
eq("the row reads as caught up, not as new", watchState(withCountdown), "current")
eq('"watch next" does not open it', nextEpisode(withCountdown), undefined)
eq("nor does the newest-episode link", latestEpisode(withCountdown)?.number, 12)

// A series whose whole list is placeholders has nothing to watch yet, which is
// "unstarted" — the state for a source that returned nothing — not "new".
eq(
    "a series of nothing but countdowns is unstarted",
    watchState({ episodes: [soon(1)], lastWatched: undefined, follow: true }),
    "unstarted"
)

// And once it goes live everything reverses, with no other state changed.
const wentUp = { episodes: range(1, 13), lastWatched: at(12), follow: true }
eq("once it is out, the badge lights", unwatchedCount(wentUp), 1)
eq("…and the row says so", watchState(wentUp), "new")
eq("…and watch next opens it", nextEpisode(wentUp)?.number, 13)

console.log("\n\x1b[1mwhat is worth opening to check\x1b[0m\n")

// Only the episodes about to be announced, and the ones whose answer can change.
eq(
    "a backfill is not verified — it is not announced either way",
    verificationCandidates({ episodes: range(1, 20), releases: [], limit: 5 }).length,
    0
)
eq(
    "the ones about to be announced are",
    verificationCandidates({ episodes: range(1, 13), releases: range(13, 13), limit: 5 })
        .map(e => e.number)
        .join(),
    "13"
)
eq(
    "a known placeholder is re-checked even though nothing announced it",
    verificationCandidates({ episodes: [...range(1, 12), soon(13)], releases: [], limit: 5 })
        .map(e => e.number)
        .join(),
    "13"
)

/*
 * The cap is for the entry whose stored list was empty — a failed first fetch, a
 * source that just came back — where every episode reads as a release. Highest
 * first, because a site posts ahead of itself and never behind, so the ones the
 * cap drops are the least likely to be placeholders.
 */
const wholeRun = verificationCandidates({ episodes: range(1, 400), releases: range(1, 400), limit: 5 })
eq("an empty stored list does not open four hundred pages", wholeRun.length, 5)
eq("…and it checks the newest, where a placeholder would be", wholeRun.map(e => e.number).join(), "400,399,398,397,396")

console.log("\n\x1b[1mwhen an on-open mark may be recorded\x1b[0m\n")

const opened = (over: Partial<Parameters<typeof onOpenMark>[0]> = {}) =>
    onOpenMark({
        marks: true,
        takeOverPage: true,
        markOnlyWhenPlayable: true,
        pending: false,
        hasServers: true,
        ...over
    })

eq("normally the player says when there is a picture", opened(), "whenPlaying")
eq("a recognised countdown is never marked", opened({ pending: true }), "never")
eq("a page listing no servers is never marked", opened({ hasServers: false }), "never")
eq("opening not counting at all still wins", opened({ marks: false }), "never")

/*
 * With the site's own player left in place nothing of ours ever attaches, so no
 * later moment is coming and the page read is the only one there is.
 */
eq("with no player of ours, the page read is the moment", opened({ takeOverPage: false }), "now")
eq("…but a countdown is still refused there", opened({ takeOverPage: false, pending: true }), "never")

/*
 * Turning the guard off means "go back to marking on open" — it does not mean
 * "mark episodes the source has said are not out". Nobody asking for the first
 * is asking for the second.
 */
eq("the opt-out restores the old timing", opened({ markOnlyWhenPlayable: false }), "now")
eq("…but not for a countdown", opened({ markOnlyWhenPlayable: false, pending: true }), "never")
eq("…and it does not need a server list to do it", opened({ markOnlyWhenPlayable: false, hasServers: false }), "now")

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
