import { refreshBadge } from "./badge"
import { libraryChanged } from "./broadcast"
import { getAnime } from "~/model/db"
import { animeKey } from "~/model/keys"
import { addSeries, fetchCtxFor, markWatched } from "~/library/library"
import { matchEpisodeUrl, sourceForUrl } from "~/sources/registry"
import { orderServers } from "~/library/servers"
import type { AnimeSource, Server } from "~/sources/types"
import type { PageIdentity } from "~/shared/messages"
import { resolve } from "~/settings/resolver"
import { log } from "~/shared/logger"

const logger = log("identify")

/**
 * Read an episode page: which series, which episode, which servers.
 *
 * Two callers with one difference between them. The content script sits *on* the
 * page and is a tracking signal — opening an episode means you are watching it.
 * The prefetcher reads the *next* episode's page while you are still on this
 * one, and must leave the library entirely alone: marking episode 48 watched
 * because the player looked ahead at it would be worse than no prefetch at all.
 */
export async function identifyEpisode(options: {
    source: AnimeSource
    url: string
    html: string
    tabId?: number
    /** False for a look-ahead: parse the page, touch nothing. */
    track: boolean
}): Promise<PageIdentity> {
    const { source, url, html } = options

    if (!source.isEpisodePage(html, url)) {
        logger.debug(`${source.id}: URL matched but the page has no player markup — ${url}`)
        return { sourceId: source.id, isEpisode: false }
    }

    const ctx = await fetchCtxFor(source, options.tabId)

    try {
        const pageInfo = await source.getPageInfo(html, url, ctx)
        const key = animeKey(source.id, pageInfo.seriesId)

        let entry = await getAnime(key)

        /*
         * `autoAddOnWatch` decides whether an *unknown* series is added. It has
         * never decided whether an already-tracked one keeps its position updated
         * — turning it off means "stop collecting series", not "stop tracking the
         * ones I chose". AMR draws the line in the same place.
         */
        if (options.track && !entry && resolve("autoAddOnWatch", { sourceId: source.id })) {
            entry = await addSeries({
                sourceId: source.id,
                seriesUrl: pageInfo.seriesUrl,
                seriesId: pageInfo.seriesId,
                title: pageInfo.title,
                tabId: options.tabId
            })
            libraryChanged("added", entry.key)
        }

        // Opening the page is a tracking signal in its own right: the player may
        // end up embedding a frame it cannot see inside, and on a freshly added
        // series "watch next" would otherwise point at episode 1.
        if (options.track && entry && resolve("markWatchedOnOpen", { anime: entry, sourceId: source.id })) {
            entry = (await markWatched(entry.key, pageInfo.number, pageInfo.variant)) ?? entry
            libraryChanged("position", entry.key)
        }

        if (options.track && entry) await refreshBadge()

        // Servers come from the HTML we already have, ordered by preference here
        // so the player never has to know about the settings chain.
        let servers: Server[] = []
        try {
            const found = await source.getServers(html, url, ctx)
            const preferred = resolve("preferredServers", { anime: entry, sourceId: source.id })
            const variant = resolve("variantPref", { anime: entry, sourceId: source.id })
            servers = orderServers(found, preferred, variant)
        } catch (error) {
            logger.warn(`${source.id}: could not read the server list`, error)
        }

        return {
            sourceId: source.id,
            isEpisode: true,
            pageInfo,
            servers,
            ...(entry ? { key: entry.key } : {}),
            /*
             * Both resolved here so the player never has to know the settings
             * chain, and both sent even when untracked — the viewer can add the
             * series from the player, and they apply from then on.
             *
             * `markOnOpen` matters for the in-place swap specifically: nothing
             * navigates, so nothing re-runs the tracking above, and the player
             * has to do it at the moment it actually switches.
             */
            markOnEmbed: resolve("markWatchedOnEmbed", { anime: entry, sourceId: source.id }),
            markOnOpen: resolve("markWatchedOnOpen", { anime: entry, sourceId: source.id })
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(`could not read page info for ${url}`, error)
        return { sourceId: source.id, isEpisode: true, error: message }
    }
}

/** The source that owns a URL, if it is an episode page at all. */
export function episodeSourceFor(url: string): AnimeSource | null {
    const source = sourceForUrl(url)
    if (!source || !matchEpisodeUrl(source, url)) return null
    return source
}
