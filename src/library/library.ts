import type { Episode, SchedulePolicy, SourceState, TrackedAnime } from "~/model/types"
import {
    animeKey,
    episodeProgressKey,
    latestEpisodeNumber,
    newReleases,
    progressKey,
    verificationCandidates,
    wentLive
} from "~/model/keys"
import { resolve, resolveSchedule } from "~/settings/resolver"
import { nextCheckAt } from "~/background/schedule"
import { enrich } from "~/trackers/match"
import * as db from "~/model/db"
import { createFetchCtx } from "~/net/fetcher"
import { allSources, sourceById } from "~/sources/registry"
import type { AnimeSource, SeriesInfo } from "~/sources/types"
import { cachedSettings, loadSettings } from "~/settings/storage"
import { automaticCategoriesOf, shelveOverrides } from "./categories"
import { log } from "~/shared/logger"
import { ensureTrailingSlash, swapOrigin } from "~/shared/url"

const logger = log("library")

/** The fetch context for a source, honouring any resolved domain override. */
export async function fetchCtxFor(source: AnimeSource, tabId?: number) {
    const state = await db.getSourceState(source.id)
    const host = state?.pinnedDomain ?? state?.preferredDomain ?? source.domains[0]
    const baseUrl = host ? `https://${host}` : source.home.replace(/\/+$/, "")
    return createFetchCtx({
        baseUrl,
        tabId,
        defaultHeaders: { Referer: ensureTrailingSlash(baseUrl) }
    })
}

/** Rewrite a stored URL onto the source's currently-live origin. */
export async function currentUrlFor(source: AnimeSource, storedUrl: string): Promise<string> {
    const ctx = await fetchCtxFor(source)
    return swapOrigin(storedUrl, ctx.baseUrl)
}

export async function ensureSourceState(sourceId: string): Promise<SourceState> {
    const existing = await db.getSourceState(sourceId)
    if (existing) return existing
    const source = sourceById(sourceId)
    const state: SourceState = {
        sourceId,
        knownDomains: source ? [...source.domains] : [],
        lastDomainCheckAt: 0,
        enabled: true
    }
    await db.putSourceState(state)
    return state
}

function blankAnime(params: {
    source: AnimeSource
    info: Pick<SeriesInfo, "title" | "seriesId" | "url" | "poster">
    follow: boolean
    poll: boolean
}): TrackedAnime {
    const now = Date.now()
    return {
        key: animeKey(params.source.id, params.info.seriesId),
        sourceId: params.source.id,
        seriesId: params.info.seriesId,
        url: params.info.url,
        title: params.info.title,
        ...(params.info.poster ? { poster: params.info.poster } : {}),
        episodes: [],
        progress: {},
        follow: params.follow,
        poll: params.poll,
        categories: [],
        overrides: {},
        addedAt: now,
        updatedAt: now,
        lastCheckedAt: 0,
        nextCheckAt: 0,
        lastEpisodeFoundAt: 0,
        failCount: 0
    }
}

/**
 * Add a series, or return the existing entry. Episode fetching is best-effort:
 * an entry with no episodes yet is still worth keeping, since the update loop
 * will fill it in.
 */
export async function addSeries(options: {
    sourceId: string
    seriesUrl: string
    seriesId?: string
    title?: string
    poster?: string
    tabId?: number
}): Promise<TrackedAnime> {
    const source = sourceById(options.sourceId)
    if (!source) throw new Error(`unknown source "${options.sourceId}"`)

    await loadSettings()
    const settings = cachedSettings()

    const seriesId = options.seriesId ?? source.seriesIdFromUrl(options.seriesUrl)
    if (!seriesId) throw new Error(`could not derive a series id from ${options.seriesUrl}`)

    const key = animeKey(source.id, seriesId)
    const existing = await db.getAnime(key)
    if (existing) {
        logger.debug(`already tracking ${key}`)
        return existing
    }

    const ctx = await fetchCtxFor(source, options.tabId)
    let info: Pick<SeriesInfo, "title" | "seriesId" | "url" | "poster"> = {
        title: options.title ?? seriesId,
        seriesId,
        url: options.seriesUrl,
        ...(options.poster ? { poster: options.poster } : {})
    }

    try {
        info = await source.getSeries(options.seriesUrl, ctx)
    } catch (error) {
        logger.warn(`getSeries failed for ${key}, keeping what the page told us`, error)
    }

    const anime = blankAnime({
        source,
        info,
        follow: settings.followOnAdd,
        poll: settings.pollOnAdd
    })

    try {
        anime.episodes = await source.getEpisodes(options.seriesUrl, ctx)
        anime.lastCheckedAt = Date.now()
    } catch (error) {
        anime.failCount = 1
        anime.lastError = String(error)
        logger.warn(`getEpisodes failed for ${key}`, error)
    }

    anime.nextCheckAt = nextCheckAt(anime, resolveSchedule(anime))
    await db.putAnime(anime)
    logger.info(`added ${key} — ${anime.episodes.length} episodes`)

    // Fill in poster, canonical title and air times in the background. Never
    // awaited: a slow or rate-limited tracker must not delay adding a series.
    void enrich(key).catch(error => logger.debug(`${key}: tracker enrich skipped`, error))
    await ensureSourceState(source.id)
    return anime
}

/**
 * Re-fetch the episode list for one entry.
 *
 * Two different answers come back, and callers want different ones. `added` is
 * every episode that was not in the stored list — the honest diff, which is what
 * the list itself has to be rebuilt from. `releases` is the subset that actually
 * came *out* since last time; see `newReleases` for why those are not the same
 * thing. Anything that interrupts the user, or decides how active a series is,
 * has to read `releases`.
 */
export async function refreshSeries(
    key: string
): Promise<{ anime: TrackedAnime; added: Episode[]; releases: Episode[] }> {
    const anime = await db.getAnime(key)
    if (!anime) throw new Error(`not tracking "${key}"`)

    const source = sourceById(anime.sourceId)
    if (!source) throw new Error(`unknown source "${anime.sourceId}"`)

    const ctx = await fetchCtxFor(source)
    const url = swapOrigin(anime.url, ctx.baseUrl)

    try {
        const episodes = await source.getEpisodes(url, ctx)
        const known = new Set(anime.episodes.map(e => progressKey(e.number, e.variant)))
        const added = episodes.filter(e => !known.has(progressKey(e.number, e.variant)))

        // Read before the list is replaced: it is the whole basis for telling a
        // release apart from a backfill.
        const previousHighest = latestEpisodeNumber(anime)

        /*
         * Confirm the episodes about to be announced actually have a video
         * behind them. See `verifyEpisodes` — it mutates `episodes` in place,
         * flagging the ones that turn out to be countdowns, so everything below
         * this line works on a verified list.
         */
        const stored = anime.episodes
        await verifyEpisodes({
            source,
            ctx,
            anime,
            episodes,
            stored,
            candidateReleases: newReleases({
                added,
                previousHighest,
                ...(anime.lastWatched ? { watchedUpTo: anime.lastWatched.number } : {})
            })
        })

        /*
         * Two ways an episode becomes a release, and both are needed.
         *
         * The diff catches an episode that appeared in the list. `wentLive`
         * catches one that was already in it as a placeholder and has now got a
         * video — which the diff cannot see, because nothing about the list
         * changed. Without the second, suppressing a countdown would suppress
         * the real episode along with it.
         */
        const releases = [
            ...newReleases({
                added,
                previousHighest,
                ...(anime.lastWatched ? { watchedUpTo: anime.lastWatched.number } : {})
            }),
            ...wentLive(stored, episodes)
        ]

        anime.episodes = episodes
        anime.url = url
        anime.lastCheckedAt = Date.now()
        anime.updatedAt = Date.now()
        anime.failCount = 0
        delete anime.lastError
        // "When did this series last put out an episode" drives the smart
        // schedule. Backfilling two-year-old posts must not make it look active.
        if (releases.length > 0) anime.lastEpisodeFoundAt = Date.now()
        anime.nextCheckAt = nextCheckAt(anime, resolveSchedule(anime))

        await db.putAnime(anime)

        const pending = episodes.filter(e => e.pending === true)
        const backfilled = added.length - releases.length - pending.length
        logger.info(
            `refreshed ${key} — ${episodes.length} episodes, ${releases.length} new` +
                (pending.length > 0
                    ? `, ${pending.length} posted but not out (E${pending.map(e => e.number).join(", E")})`
                    : "") +
                (backfilled > 0
                    ? ` (${backfilled} older episode(s) appeared too, at or below E${previousHighest ?? 0}` +
                      `${anime.lastWatched ? `/E${anime.lastWatched.number} watched` : ""} — not announced)`
                    : "")
        )
        return { anime, added, releases }
    } catch (error) {
        anime.failCount += 1
        anime.lastError = String(error)
        anime.lastCheckedAt = Date.now()
        await db.putAnime(anime)
        throw error
    }
}

/**
 * How many episode pages one refresh may open to check whether they are real.
 *
 * Small because the realistic number is one. A site posts an episode or two
 * ahead of itself, never a season; the cap is here for the pathological case —
 * an entry whose stored list was empty, where every episode reads as a release —
 * and not as a budget anyone is expected to spend.
 */
const MAX_VERIFICATIONS_PER_REFRESH = 5

/**
 * Open the episodes about to be announced and check they have a video.
 *
 * The update loop reads the *series* page, where a post the site created ahead
 * of the release is indistinguishable from one it has: same markup, same server
 * count, a title and a number like any other. Only the episode page shows the
 * difference, so the only way to tell is to look — one request per candidate,
 * and `verificationCandidates` decides which candidates are worth it.
 *
 * Mutates `episodes` in place. That is deliberate: the caller's `newReleases`
 * diff, `wentLive` transition and stored list must all see one list in one
 * state, and returning a copy would leave three chances to use the wrong one.
 *
 * **Every failure path leaves the episode announced.** A source with no opinion,
 * the setting off, a fetch that times out, a parse that throws — all of them fall
 * through to "watchable", because the cost of the two mistakes is not
 * symmetrical. Announcing a countdown is a notification the viewer dismisses;
 * suppressing a real episode is one they never learn they missed.
 */
async function verifyEpisodes(options: {
    source: AnimeSource
    ctx: Awaited<ReturnType<typeof fetchCtxFor>>
    anime: TrackedAnime
    episodes: Episode[]
    stored: Episode[]
    candidateReleases: Episode[]
}): Promise<void> {
    const { source, ctx, anime, episodes, stored, candidateReleases } = options
    if (!source.episodeAvailability) return
    if (!resolve("verifyNewEpisodes", { anime, sourceId: anime.sourceId })) return

    /*
     * Carry the previous verdict onto the fresh list first, so an episode known
     * to be a placeholder is still known as one before anything is fetched. A
     * check run that never gets to it — the cap, a failed request — must not
     * quietly promote it back to a release; the flag comes off only when a page
     * is actually read and found to have a player.
     */
    const before = new Map(stored.map(ep => [episodeProgressKey(ep), ep]))
    for (const episode of episodes) {
        const previous = before.get(episodeProgressKey(episode))
        if (previous?.pending !== true) continue
        episode.pending = true
        if (previous.pendingReason) episode.pendingReason = previous.pendingReason
    }

    const candidates = verificationCandidates({
        episodes,
        releases: candidateReleases,
        limit: MAX_VERIFICATIONS_PER_REFRESH
    })

    // Sequential on purpose. This runs inside a scheduled check of a whole
    // library; the politeness the scheduler buys between series is not worth
    // spending five parallel requests against one site to save a second.
    for (const episode of candidates) {
        try {
            const html = await ctx.text(episode.url, { noCache: true })
            const verdict = source.episodeAvailability(html, episode.url)
            if (verdict.pending) {
                episode.pending = true
                if (verdict.reason) episode.pendingReason = verdict.reason
                else delete episode.pendingReason
            } else {
                delete episode.pending
                delete episode.pendingReason
            }
        } catch (error) {
            // Fail open, and say so — a series that stops announcing episodes
            // because of a network blip is exactly the silent failure above.
            delete episode.pending
            delete episode.pendingReason
            logger.warn(`${anime.key}: could not verify E${episode.number}, treating it as out`, error)
        }
    }
}

/**
 * Move the watch pointer to an episode.
 *
 * The pointer only ever moves *forward* on its own. Opening episode 157 of a
 * series you are caught up at 160 on is a rewatch, or a click on the wrong row,
 * and either way it should not throw away where you actually were. This is AMR's
 * rule too — its `consultManga` updates the position only when the chapter is
 * newer than the stored one, and the `fromSite` flag that overrides that is set
 * by the sync importer, never by reading a page.
 *
 * `force` is the deliberate version: "set my position to this episode", chosen
 * from the UI, which may move in either direction.
 */
export async function markWatched(
    key: string,
    number: number,
    variant?: string,
    options: { force?: boolean } = {}
): Promise<TrackedAnime | null> {
    const anime = await db.getAnime(key)
    if (!anime) return null

    const already = anime.lastWatched
    if (already && already.number === number && already.variant === variant) {
        return anime
    }

    if (!options.force && already && number < already.number) {
        logger.debug(`${key}: staying at episode ${already.number}, not moving back to ${number}`)
        return anime
    }

    anime.lastWatched = { number, ...(variant ? { variant } : {}), at: Date.now() }
    anime.updatedAt = Date.now()
    await db.putAnime(anime)
    logger.info(`${key}: position → episode ${number}${variant ? ` (${variant})` : ""}`)
    return anime
}

/**
 * Record how far into an episode the viewer is, and promote it to "watched" once
 * the completion threshold is crossed.
 *
 * Called on a timer while playing, so it must stay cheap: one read, one write,
 * and no work at all when the position has not meaningfully moved.
 */
export async function updateProgress(input: {
    key: string
    number: number
    variant?: string
    positionSec: number
    durationSec?: number
}): Promise<{ anime: TrackedAnime; advanced: boolean } | null> {
    const anime = await db.getAnime(input.key)
    if (!anime) return null

    const pk = progressKey(input.number, input.variant)
    const previous = anime.progress[pk]

    // Ignore jitter, but always let a completion through.
    const moved = !previous || Math.abs(previous.positionSec - input.positionSec) >= 1
    const threshold = resolve("completionThreshold", { anime, sourceId: anime.sourceId })
    const ratio = input.durationSec && input.durationSec > 0 ? input.positionSec / input.durationSec : 0
    /*
     * A threshold of 0 is meaningful and needs no special case: every ratio
     * clears it, so the first tick of actual playback marks the episode. Note
     * what that is *not* — ticks only arrive from our own player and only while
     * something is playing, so 0 does not mean "watched when I open the page".
     * That is `markWatchedOnOpen`, which needs no video at all.
     */
    const completed = previous?.completed === true || ratio >= threshold

    if (!moved && completed === (previous?.completed ?? false)) return { anime, advanced: false }

    anime.progress[pk] = {
        positionSec: input.positionSec,
        ...(input.durationSec ? { durationSec: input.durationSec } : {}),
        completed,
        updatedAt: Date.now()
    }

    // Completing an episode advances the pointer, but never drags it backwards:
    // re-watching episode 3 should not undo being caught up at 47.
    let advanced = false
    if (completed && (!anime.lastWatched || anime.lastWatched.number < input.number)) {
        anime.lastWatched = {
            number: input.number,
            ...(input.variant ? { variant: input.variant } : {}),
            at: Date.now()
        }
        advanced = true
    }

    anime.updatedAt = Date.now()
    await db.putAnime(anime)
    return { anime, advanced }
}

/**
 * Forget where the viewer got to, keeping the series and its episode list.
 *
 * AMR's "reset" — the series goes back to unstarted, so every episode counts as
 * unwatched again and "watch next" points at the beginning. Deliberately keeps
 * the entry, its schedule and its settings: this is for starting a rewatch or
 * repairing a position that drifted, not for getting rid of something.
 */
export async function resetWatchStatus(key: string): Promise<TrackedAnime | null> {
    const anime = await db.getAnime(key)
    if (!anime) return null

    delete anime.lastWatched
    anime.progress = {}
    anime.updatedAt = Date.now()
    await db.putAnime(anime)

    logger.info(`${key}: watch status reset`)
    return anime
}

export async function setFlags(key: string, flags: { follow?: boolean; poll?: boolean }): Promise<TrackedAnime | null> {
    const anime = await db.getAnime(key)
    if (!anime) return null
    if (flags.follow !== undefined) anime.follow = flags.follow
    if (flags.poll !== undefined) anime.poll = flags.poll
    // Turning polling back on should queue a check, not wait for the old slot.
    if (flags.poll !== undefined) anime.nextCheckAt = flags.poll ? 0 : nextCheckAt(anime, resolveSchedule(anime))
    anime.updatedAt = Date.now()
    await db.putAnime(anime)
    return anime
}

/**
 * Set (or clear) a per-anime schedule override, then re-slot it immediately so
 * the change takes effect now rather than after the old slot elapses.
 */
export async function setSchedule(key: string, schedule: SchedulePolicy): Promise<TrackedAnime | null> {
    const anime = await db.getAnime(key)
    if (!anime) return null

    if (schedule.mode === "inherit") delete anime.overrides.schedule
    else anime.overrides.schedule = schedule

    anime.nextCheckAt = nextCheckAt(anime, resolveSchedule(anime))
    anime.updatedAt = Date.now()
    await db.putAnime(anime)
    logger.info(`${key}: schedule → ${schedule.mode}`)
    return anime
}

export async function rename(key: string, displayTitle: string): Promise<TrackedAnime | null> {
    const anime = await db.getAnime(key)
    if (!anime) return null
    const trimmed = displayTitle.trim()
    if (trimmed === "") delete anime.displayTitle
    else anime.displayTitle = trimmed
    anime.updatedAt = Date.now()
    await db.putAnime(anime)
    return anime
}

/**
 * Put a series on shelves, or take it off.
 *
 * Only manual categories are stored. Automatic membership is recomputed from
 * tracker data on every read, so a category whose rule changes takes effect at
 * once and nothing is ever left tagged by a rule that no longer exists.
 */
/**
 * The shelves a series lands on by rule alone.
 *
 * Kept here rather than in the handler so that every path that shelves something
 * — one row, a bulk action — decides "is this already automatic?" the same way.
 */
function automaticShelves(anime: TrackedAnime): Set<string> {
    const claims = Object.fromEntries(allSources().map(source => [source.id, source.categories]))
    return new Set(automaticCategoriesOf(anime, cachedSettings().categories ?? [], claims))
}

/** Write the two override lists back, dropping an empty one rather than storing it. */
function applyShelving(anime: TrackedAnime, categoryId: string, on: boolean): boolean {
    const next = shelveOverrides(anime, categoryId, on, automaticShelves(anime).has(categoryId))

    const same =
        next.categories.join("\u0000") === [...(anime.categories ?? [])].sort().join("\u0000") &&
        next.categoriesOff.join("\u0000") === [...(anime.categoriesOff ?? [])].sort().join("\u0000")
    if (same) return false

    anime.categories = next.categories
    if (next.categoriesOff.length > 0) anime.categoriesOff = next.categoriesOff
    else delete anime.categoriesOff
    anime.updatedAt = Date.now()
    return true
}

/**
 * Put one series on one shelf, or take it off — including a shelf that fills
 * itself. See `shelveOverrides`: the rule is evidence, the user is the decision.
 */
export async function shelve(key: string, categoryId: string, on: boolean): Promise<TrackedAnime | null> {
    const anime = await db.getAnime(key)
    if (!anime) return null
    if (applyShelving(anime, categoryId, on)) await db.putAnime(anime)
    return anime
}

export async function setCategories(key: string, categories: string[]): Promise<TrackedAnime | null> {
    const anime = await db.getAnime(key)
    if (!anime) return null
    anime.categories = [...new Set(categories)].sort()
    anime.updatedAt = Date.now()
    await db.putAnime(anime)
    return anime
}

/** The same, across a selection. Returns how many entries actually changed. */
export async function bulkCategory(keys: string[], categoryId: string, action: "add" | "remove"): Promise<number> {
    const changed: TrackedAnime[] = []

    for (const key of keys) {
        const anime = await db.getAnime(key)
        if (!anime) continue

        // Same rules as one row at a time, so a bulk add onto "Donghua" means
        // what a hand-tick there means.
        if (!applyShelving(anime, categoryId, action === "add")) continue
        changed.push(anime)
    }

    if (changed.length > 0) await db.putManyAnime(changed)
    logger.info(
        `${action === "add" ? "added" : "removed"} ${changed.length} series ${action === "add" ? "to" : "from"} ${categoryId}`
    )
    return changed.length
}

export async function remove(key: string): Promise<boolean> {
    const anime = await db.getAnime(key)
    if (!anime) return false
    await db.deleteAnime(key)
    logger.info(`removed ${key}`)
    return true
}
