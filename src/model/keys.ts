import type { Episode, EpisodeProgress, TrackedAnime, Variant } from "./types"

/** The library key. Never derived from a URL — see model/types.ts. */
export function animeKey(sourceId: string, seriesId: string): string {
    return `${sourceId}/${seriesId}`
}

/** Progress map key. Variant is part of it: sub ep 5 and dub ep 5 track apart. */
export function progressKey(number: number, variant?: Variant): string {
    return `${number}:${variant ?? ""}`
}

export function episodeProgressKey(ep: Episode): string {
    return progressKey(ep.number, ep.variant)
}

/** Below this, "where I left off" is just where the episode starts. */
const RESUME_FLOOR_SEC = 5

/**
 * Within this of the end, the episode was finished rather than paused, so the
 * next open starts it over.
 */
const RESUME_TAIL_SEC = 15

/**
 * Where to start this episode, or null to start at the beginning.
 *
 * Deliberately blind to `completed`. That flag answers a *tracking* question —
 * "count this as watched" — and `completionThreshold` exists precisely so the
 * viewer can redefine it; setting it to 0 marks an episode a second in, which is
 * a supported choice and used. Resume asking `completed` therefore meant that
 * one setting silently switched resume off for the whole library, on every
 * episode, with nothing to connect the two. Same shape as rules 10 and 11 in
 * CLAUDE.md: a stand-in value quietly answering a question about other state.
 *
 * The position is its own evidence. Someone who stopped in the middle has a
 * position in the middle, and someone who watched to the end has one at the end,
 * whatever any threshold was set to. Where the duration is unknown the position
 * is all there is, and resuming is the better guess: it is one keypress to seek
 * back, and losing forty minutes is not.
 */
export function resumePositionFor(saved: EpisodeProgress | undefined): number | null {
    if (!saved) return null
    if (saved.positionSec <= RESUME_FLOOR_SEC) return null

    const duration = saved.durationSec
    if (duration && duration > 0 && saved.positionSec >= duration - RESUME_TAIL_SEC) return null

    return saved.positionSec
}

/*
 * There is deliberately no `watchable(episode)` predicate here, and there was
 * one. A post the site has created but not aired — a countdown, a premium
 * window, a backdated placeholder — is not in the episode list at all; the check
 * run drops it before storing (see `verifiedEpisodes`). Everything below can
 * therefore treat every entry as a real episode.
 *
 * The version that kept such posts with a `pending` flag needed every reader of
 * `anime.episodes` to remember to skip them, and the cost of that showed up
 * exactly where you would expect: the player's own episode list forgot, so the
 * next-episode arrow lit up for a countdown. A rule that has to be repeated at
 * every call site is a rule that will be missed at one of them.
 */

export function titleOf(anime: Pick<TrackedAnime, "title" | "displayTitle">): string {
    return anime.displayTitle && anime.displayTitle.trim() !== "" ? anime.displayTitle : anime.title
}

/** Highest episode number the source currently lists, or null when it lists none. */
export function latestEpisodeNumber(anime: Pick<TrackedAnime, "episodes">): number | null {
    let max: number | null = null
    for (const ep of anime.episodes) {
        if (max === null || ep.number > max) max = ep.number
    }
    return max
}

/**
 * Episodes newer than the furthest point watched. This is the "unwatched" count
 * the badge and the list both use, and it is a number comparison — not the URL
 * comparison that AMR needs `chapPath` and `findProbableChapter` to survive.
 */
export function unwatchedCount(anime: Pick<TrackedAnime, "episodes" | "lastWatched">): number {
    if (!anime.lastWatched) return anime.episodes.length
    const from = anime.lastWatched.number
    return anime.episodes.reduce((n, ep) => (ep.number > from ? n + 1 : n), 0)
}

/**
 * May a check run touch this series at all?
 *
 * One definition, used by every path into the update loop — the due-queue index
 * scan, the "check everything now" button, and the slot calculation. Three
 * separate `anime.poll` tests would be three chances for "check for new
 * episodes: off" to be quietly ignored by one of them, and the failure is
 * invisible from the outside: a series you asked not to be checked is checked.
 */
export function checkable(anime: Pick<TrackedAnime, "poll">): boolean {
    return anime.poll === true
}

export function hasUnwatched(anime: Pick<TrackedAnime, "episodes" | "lastWatched" | "follow">): boolean {
    return anime.follow && unwatchedCount(anime) > 0
}

/**
 * The episode "watch next" should open: the lowest episode above the watch
 * pointer. With no pointer yet this is the earliest episode — the series has
 * never been opened, so starting at the beginning is right.
 *
 * Returns undefined when the pointer is already at the newest episode, which the
 * UI must treat as "up to date" rather than silently falling back to episode 1.
 */
export function nextEpisode(anime: Pick<TrackedAnime, "episodes" | "lastWatched">): Episode | undefined {
    const lowest = (candidates: Episode[]) =>
        candidates.reduce<Episode | undefined>((lo, ep) => (!lo || ep.number < lo.number ? ep : lo), undefined)

    const from = anime.lastWatched?.number
    if (from === undefined) return lowest(anime.episodes)
    return lowest(anime.episodes.filter(ep => ep.number > from))
}

/** The newest episode the source lists. */
export function latestEpisode(anime: Pick<TrackedAnime, "episodes">): Episode | undefined {
    return anime.episodes.reduce<Episode | undefined>((hi, ep) => (!hi || ep.number > hi.number ? ep : hi), undefined)
}

/**
 * How an entry should read at a glance. AMR encodes the same three states as row
 * colours (colornew / colorread / colornotfollow); naming them here keeps that
 * meaning out of the stylesheet.
 *
 *  - `new`       followed, and something sits above the watch pointer
 *  - `current`   followed, and caught up
 *  - `unstarted` followed, but the source returned no episodes
 *  - `paused`    not followed
 */
export type WatchState = "new" | "current" | "unstarted" | "paused"

export function watchState(anime: Pick<TrackedAnime, "episodes" | "lastWatched" | "follow">): WatchState {
    if (!anime.follow) return "paused"
    if (anime.episodes.length === 0) return "unstarted"
    if (unwatchedCount(anime) > 0) return "new"
    return "current"
}

/**
 * Which of the episodes just added to a list are actually *releases*.
 *
 * "Not in the list we stored last time" and "just came out" are different
 * things, and conflating them is how a library ends up announcing episodes from
 * two years ago. A source's list grows for two unrelated reasons:
 *
 *  - the show aired a new episode, which is worth interrupting someone for;
 *  - we can suddenly see episodes that were always there — pagination that used
 *    to stop at 100, a tag that got applied retroactively, a slug the site
 *    renamed. This is a *backfill*, and the viewer has very often already
 *    watched every one of them.
 *
 * The two are told apart by number, not by date: a backfilled post carries its
 * original publication date, so `airedAt` says "two years ago" for exactly the
 * episodes a date test would need to catch, and says nothing at all for the
 * sources that don't report one.
 *
 * The floor is the higher of the newest episode the source previously listed and
 * the furthest the viewer has watched. The first keeps a backfill quiet; the
 * second keeps a *reset* list quiet — re-adding a series you are caught up on
 * should not announce its whole run.
 */
export function newReleases(options: {
    added: Episode[]
    /** Highest number the stored list held before this refresh, or null if empty. */
    previousHighest: number | null
    /** `lastWatched.number`, when there is one. */
    watchedUpTo?: number
}): Episode[] {
    const floor = Math.max(
        options.previousHighest ?? Number.NEGATIVE_INFINITY,
        options.watchedUpTo ?? Number.NEGATIVE_INFINITY
    )

    // Nothing to compare against — a series being seen for the first time. The
    // caller decides whether that is worth announcing; here everything counts.
    if (!Number.isFinite(floor)) return options.added

    return options.added.filter(episode => episode.number > floor)
}

/*
 * `newReleases` is the only announcement path, and a countdown needs no second
 * one. There was a `wentLive(previous, current)` here that announced an episode
 * whose placeholder had finally got a video, and it was necessary only because
 * the placeholder was in the stored list: when the video went up, nothing about
 * the list changed, so the diff could not see it. Dropping the placeholder
 * instead puts the transition back where it belongs — the episode is absent, then
 * it is present, which is exactly what the diff is for.
 */

/**
 * Which episodes are worth opening to check whether they are real.
 *
 * Verification costs one request each, so this decides what that budget buys.
 * Two kinds qualify and nothing else does:
 *
 *  - **the ones about to be announced.** A backfill is never announced, so
 *    confirming a two-year-old post has a player in it buys nothing. This is
 *    also what keeps re-checking a standing countdown: the placeholder was
 *    dropped last time, so it is in the diff again, so it is a candidate again —
 *    which is the only way it is ever noticed going live.
 *  - **the newest few nobody has ever asked about.** This is the one that is
 *    easy to leave out and useless without.
 *
 * That third clause is a repair, and it exists because the first version of this
 * shipped without it and fixed nothing. A library that already holds the
 * placeholder holds it as an ordinary episode: it is not in the diff, because
 * nothing about the list changed, and no code had ever looked at it. The other
 * clause came back empty and the countdown stayed the newest episode — the
 * feature worked perfectly on libraries that did not have the problem. Same
 * family as rule 11 in CLAUDE.md: new behaviour that cannot reach the state
 * already on disk.
 *
 * `available` is what stops that sweep repeating. Absent means *unknown*, so the
 * sweep runs once per episode and then never again; without the flag there is no
 * way to tell "checked and fine" from "never asked", and the top episodes of
 * every series would be re-fetched on every single check forever.
 *
 * Highest number first, then capped. A site posts *ahead* of itself, never
 * behind, so placeholders are always at the top of the numbering; if the cap
 * bites, the episodes it drops are the least likely to be placeholders.
 */
export function verificationCandidates(options: {
    /** The freshly fetched list, carrying whatever `available` memos were kept. */
    episodes: Episode[]
    /** What would be announced if nothing were verified. */
    releases: Episode[]
    /** How many never-checked episodes to sweep from the top of the numbering. */
    sweep: number
    limit: number
}): Episode[] {
    const byNumberDesc = (a: Episode, b: Episode) => b.number - a.number
    const unknown = (ep: Episode) => ep.available !== true

    const announced = new Set(options.releases.map(episodeProgressKey))
    const swept = new Set(
        options.episodes.filter(unknown).sort(byNumberDesc).slice(0, Math.max(0, options.sweep)).map(episodeProgressKey)
    )

    const picked = options.episodes.filter(ep => {
        // Settled, and settled the cheap way round: an episode with a player in
        // it does not lose it.
        if (ep.available === true) return false
        const key = episodeProgressKey(ep)
        return announced.has(key) || swept.has(key)
    })

    return picked.sort(byNumberDesc).slice(0, Math.max(0, options.limit))
}

/**
 * How far the watch pointer sits above the newest episode the source lists.
 *
 * 0 when all is well, which is now nearly always: `pointerRollback` runs on
 * every refresh and brings the pointer back down, so this can only be positive
 * in the window before the next check — a freshly imported backup, a list edited
 * by hand. It stays as the surface for exactly that residual case.
 */
export function positionDrift(anime: Pick<TrackedAnime, "episodes" | "lastWatched">): number {
    if (!anime.lastWatched) return 0
    const newest = latestEpisodeNumber(anime)
    // An empty list is a failed or pending fetch, not a renumbering.
    if (newest === null) return 0
    return Math.max(0, anime.lastWatched.number - newest)
}

/**
 * Where the watch pointer should go when the episode it names cannot be watched.
 *
 * **Two situations, one answer.** The episode is gone from the list — the site
 * renumbered, pulled a post, re-uploaded under a different number — or it is
 * was a countdown all along and the check run has dropped it. Either way the
 * pointer names something the viewer cannot be sitting at, and the distinction
 * is invisible from where it matters: the row says "Up to date" at an episode
 * that does not exist, the badge stays dark, and "watch next" returns nothing.
 * Treating them alike is a deliberate choice, not a shortcut — a rule that
 * rolled back one and reported the other would leave the same broken row half
 * the time, for a difference the viewer cannot see. It is also the whole reason
 * this needs no notion of a pending episode: a placeholder is simply not in the
 * list, which is the first case.
 *
 * It falls back to the highest episode *below* the one held, rather
 * than to zero. AMR resets to zero and is right to for its own model — its
 * position **is** a chapter URL, so a path that disappeared means the position
 * is genuinely gone. Ours is a number and the episode list is evidence: the
 * viewer really did watch everything below, and throwing that away would mark a
 * whole run unwatched, light the badge for all of it and point "watch next" at
 * the bottom of the list. Rolling back one step surfaces the problem — the row
 * goes from "Up to date" to having an episode waiting — without inventing a
 * backlog that was already watched.
 *
 * **An empty list is not a renumbering.** A failed or pending fetch returns no
 * episodes, and acting on that would wipe the pointer of every series the moment
 * a site had a bad minute. Nothing happens until there is a list to reason from.
 *
 * Returns null when there is nothing to do, which is nearly always.
 */
export function pointerRollback(options: {
    episodes: Episode[]
    lastWatched?: { number: number } | null
}): { from: number; to: number | null } | null {
    const held = options.lastWatched?.number
    if (held === undefined) return null
    if (options.episodes.length === 0) return null

    if (options.episodes.some(ep => ep.number === held)) return null

    const below = options.episodes
        .filter(ep => ep.number < held)
        .reduce<number | null>((hi, ep) => (hi === null || ep.number > hi ? ep.number : hi), null)

    return { from: held, to: below }
}
