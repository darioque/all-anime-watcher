import type { Episode, TrackedAnime, Variant } from "./types"

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
