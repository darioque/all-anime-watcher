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

/**
 * Is there actually something to watch behind this episode?
 *
 * A site can publish the post before the video: a countdown widget where the
 * player goes, a premium early-access window, a placeholder pre-created with a
 * backdated timestamp. The post is real, the episode is not — and every question
 * the library asks about "the newest episode" means the newest *watchable* one.
 *
 * One predicate, used by all of them on purpose. The failure of getting this
 * wrong in one place only is silent and specific: the badge lights up, "watch
 * next" opens a page with no player, and the notification that brought you there
 * was for something that does not exist yet. Three separate `!ep.pending` tests
 * would be three chances for one of them to be forgotten.
 */
export function watchable(episode: Pick<Episode, "pending">): boolean {
    return episode.pending !== true
}

/** The episodes that can actually be played, in the order given. */
export function watchableEpisodes(episodes: Episode[]): Episode[] {
    return episodes.filter(watchable)
}

export function titleOf(anime: Pick<TrackedAnime, "title" | "displayTitle">): string {
    return anime.displayTitle && anime.displayTitle.trim() !== "" ? anime.displayTitle : anime.title
}

/**
 * Highest *watchable* episode number the source currently lists, or null when it
 * lists none.
 *
 * Pending posts are skipped, which is what keeps a countdown out of the release
 * floor: a placeholder for episode 13 must not make the real episode 13 look
 * like something already seen when it finally airs.
 */
export function latestEpisodeNumber(anime: Pick<TrackedAnime, "episodes">): number | null {
    let max: number | null = null
    for (const ep of anime.episodes) {
        if (!watchable(ep)) continue
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
    const episodes = watchableEpisodes(anime.episodes)
    if (!anime.lastWatched) return episodes.length
    const from = anime.lastWatched.number
    return episodes.reduce((n, ep) => (ep.number > from ? n + 1 : n), 0)
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

    const episodes = watchableEpisodes(anime.episodes)
    const from = anime.lastWatched?.number
    if (from === undefined) return lowest(episodes)
    return lowest(episodes.filter(ep => ep.number > from))
}

/** The newest episode the source lists that can actually be played. */
export function latestEpisode(anime: Pick<TrackedAnime, "episodes">): Episode | undefined {
    return watchableEpisodes(anime.episodes).reduce<Episode | undefined>(
        (hi, ep) => (!hi || ep.number > hi.number ? ep : hi),
        undefined
    )
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
    // A list of nothing but countdowns is a series with nothing to watch yet,
    // which reads as "unstarted" rather than as an episode waiting for you.
    if (watchableEpisodes(anime.episodes).length === 0) return "unstarted"
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

    // A post with nothing behind it is not a release, whatever its number. It
    // is announced later, by `wentLive`, at the moment it becomes watchable.
    const real = watchableEpisodes(options.added)

    // Nothing to compare against — a series being seen for the first time. The
    // caller decides whether that is worth announcing; here everything counts.
    if (!Number.isFinite(floor)) return real

    return real.filter(episode => episode.number > floor)
}

/**
 * Episodes that were pending last time and are watchable now.
 *
 * This is the second half of `newReleases`, and it exists because the two halves
 * answer to different evidence. A countdown post is in the stored list from the
 * first check that saw it, so when the video finally goes up it is *not* in the
 * diff — nothing about the list changed. The only thing that changed is the
 * episode page, and this is the transition that reads it.
 *
 * Without it, suppressing the countdown would suppress the real episode too:
 * the placeholder would absorb the one announcement the episode was ever going
 * to get. That failure is worse than the notification being fixed here, because
 * it is silent — the episode simply never arrives.
 *
 * Matched by `progressKey`, not by array position: the list is re-fetched whole
 * and a site is free to reorder it, which luciferdonghua.in in fact does — its
 * placeholder is backdated, so it sorts below episode 1 until it goes live.
 */
export function wentLive(previous: Episode[], current: Episode[]): Episode[] {
    const wasPending = new Set(previous.filter(ep => !watchable(ep)).map(episodeProgressKey))
    if (wasPending.size === 0) return []
    return current.filter(ep => watchable(ep) && wasPending.has(episodeProgressKey(ep)))
}

/**
 * Which episodes are worth opening to check whether they are real.
 *
 * Verification costs one request each, so this decides what that budget buys.
 * Three kinds qualify and nothing else does:
 *
 *  - **the ones about to be announced.** A backfill is never announced, so
 *    confirming a two-year-old post has a player in it buys nothing.
 *  - **the ones already known to be pending.** These are the only episodes whose
 *    answer can *change*, and re-asking is the only way a countdown ever becomes
 *    a release. Skipping them would trade one wrong notification for a missing
 *    one, which is the worse failure — it is silent.
 *  - **the newest few nobody has ever asked about.** This is the one that is
 *    easy to leave out and useless without.
 *
 * That third clause is a repair, and it exists because the first version of this
 * shipped without it and fixed nothing. A library that already holds the
 * placeholder holds it as an ordinary episode: it is not in the diff, because
 * nothing about the list changed, and it carries no pending flag, because no
 * code had ever looked. Both other clauses came back empty and the countdown
 * stayed the newest episode — the feature worked perfectly on libraries that did
 * not have the problem. Same family as rule 11 in CLAUDE.md: new behaviour that
 * cannot reach the state already on disk.
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
    /** The freshly fetched list, carrying whatever flags were kept. */
    episodes: Episode[]
    /** What would be announced if nothing were verified. */
    releases: Episode[]
    /** How many never-checked episodes to sweep from the top of the numbering. */
    sweep: number
    limit: number
}): Episode[] {
    const byNumberDesc = (a: Episode, b: Episode) => b.number - a.number
    const unknown = (ep: Episode) => ep.pending !== true && ep.available !== true

    const announced = new Set(options.releases.map(episodeProgressKey))
    const swept = new Set(
        options.episodes.filter(unknown).sort(byNumberDesc).slice(0, Math.max(0, options.sweep)).map(episodeProgressKey)
    )

    const picked = options.episodes.filter(ep => {
        // Settled, and settled the cheap way round: an episode with a player in
        // it does not lose it.
        if (ep.available === true) return false
        if (ep.pending === true) return true
        const key = episodeProgressKey(ep)
        return announced.has(key) || swept.has(key)
    })

    return picked.sort(byNumberDesc).slice(0, Math.max(0, options.limit))
}

/**
 * Where the watch pointer should go when it names an episode that is not out.
 *
 * Returns null when there is nothing to do, which is nearly always.
 *
 * This undoes damage rather than preventing it, and it is worth being clear
 * about why that is allowed here when `positionDrift` deliberately refuses to
 * reset anything. Drift is ambiguous — a site that renumbered, a season split, a
 * back catalogue pulled — and "you are at episode 476" stays true whatever the
 * site now lists, so throwing it away would discard real information.
 *
 * This is not ambiguous. The pointer names an episode that has been *positively
 * verified* to have no video behind it, and nobody watched an episode that does
 * not exist. The only thing that could have set it is the on-open mark firing
 * before anything had been resolved — the bug `onOpenMark` now prevents — so the
 * mark is not information, it is the fault's own footprint.
 *
 * It falls back to the highest watchable episode below, not to zero: the viewer
 * really did watch those, and the episode list is the evidence.
 */
export function pointerRetraction(options: {
    episodes: Episode[]
    lastWatched?: { number: number } | null
}): { from: number; to: number | null } | null {
    const held = options.lastWatched?.number
    if (held === undefined) return null

    const names = options.episodes.find(ep => ep.number === held)
    if (!names || watchable(names)) return null

    const below = options.episodes
        .filter(ep => watchable(ep) && ep.number < held)
        .reduce<number | null>((hi, ep) => (hi === null || ep.number > hi ? ep.number : hi), null)

    return { from: held, to: below }
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
