import type { Episode, SourceState, TrackedAnime } from "~/model/types"
import { animeKey, progressKey } from "~/model/keys"
import * as db from "~/model/db"
import { createFetchCtx } from "~/net/fetcher"
import { sourceById } from "~/sources/registry"
import type { AnimeSource, SeriesInfo } from "~/sources/types"
import { cachedSettings, loadSettings } from "~/settings/storage"
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

    await db.putAnime(anime)
    logger.info(`added ${key} — ${anime.episodes.length} episodes`)
    await ensureSourceState(source.id)
    return anime
}

/** Re-fetch the episode list for one entry. Returns the number of new episodes. */
export async function refreshSeries(key: string): Promise<{ anime: TrackedAnime; newEpisodes: Episode[] }> {
    const anime = await db.getAnime(key)
    if (!anime) throw new Error(`not tracking "${key}"`)

    const source = sourceById(anime.sourceId)
    if (!source) throw new Error(`unknown source "${anime.sourceId}"`)

    const ctx = await fetchCtxFor(source)
    const url = swapOrigin(anime.url, ctx.baseUrl)

    try {
        const episodes = await source.getEpisodes(url, ctx)
        const known = new Set(anime.episodes.map(e => progressKey(e.number, e.variant)))
        const newEpisodes = episodes.filter(e => !known.has(progressKey(e.number, e.variant)))

        anime.episodes = episodes
        anime.url = url
        anime.lastCheckedAt = Date.now()
        anime.updatedAt = Date.now()
        anime.failCount = 0
        delete anime.lastError
        if (newEpisodes.length > 0) anime.lastEpisodeFoundAt = Date.now()

        await db.putAnime(anime)
        logger.info(`refreshed ${key} — ${episodes.length} episodes, ${newEpisodes.length} new`)
        return { anime, newEpisodes }
    } catch (error) {
        anime.failCount += 1
        anime.lastError = String(error)
        anime.lastCheckedAt = Date.now()
        await db.putAnime(anime)
        throw error
    }
}

export async function setFlags(key: string, flags: { follow?: boolean; poll?: boolean }): Promise<TrackedAnime | null> {
    const anime = await db.getAnime(key)
    if (!anime) return null
    if (flags.follow !== undefined) anime.follow = flags.follow
    if (flags.poll !== undefined) anime.poll = flags.poll
    anime.updatedAt = Date.now()
    await db.putAnime(anime)
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

export async function remove(key: string): Promise<boolean> {
    const anime = await db.getAnime(key)
    if (!anime) return false
    await db.deleteAnime(key)
    logger.info(`removed ${key}`)
    return true
}
