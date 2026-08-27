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

export function titleOf(anime: Pick<TrackedAnime, "title" | "displayTitle">): string {
    return anime.displayTitle && anime.displayTitle.trim() !== "" ? anime.displayTitle : anime.title
}

/** Highest episode number the source currently lists, or null for an empty list. */
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

/**
 * How far the watch pointer sits above the newest episode the source lists.
 *
 * 0 when all is well, which is nearly always. It goes positive when a source
 * renumbers — an absolutely-numbered run split into seasons, a parse regression,
 * a site that dropped its back catalogue — and the position we hold no longer
 * has anywhere to point.
 *
 * AMR resets to zero in the equivalent situation, and it is right to: its
 * position *is* a chapter URL (`chapPath`), so a path that disappeared means the
 * position is genuinely gone and zero is the only value left. Ours is a number,
 * deliberately (see model/types.ts), and "you are at episode 476" stays true and
 * useful whether or not a post numbered 476 is still on the site. Resetting
 * would discard information we still hold, and do real damage doing it: every
 * episode becomes unwatched, the badge lights up, and "watch next" points at the
 * bottom of the list.
 *
 * So nothing is reset automatically. The drift is reported instead, and the
 * episode picker sets the position deliberately — which is the only actor that
 * actually knows where the viewer got to.
 */
export function positionDrift(anime: Pick<TrackedAnime, "episodes" | "lastWatched">): number {
    if (!anime.lastWatched) return 0
    const newest = latestEpisodeNumber(anime)
    // An empty list is a failed or pending fetch, not a renumbering.
    if (newest === null) return 0
    return Math.max(0, anime.lastWatched.number - newest)
}
