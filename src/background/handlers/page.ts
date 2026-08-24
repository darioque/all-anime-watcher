import { on } from "../router"
import { refreshBadge } from "../badge"
import { libraryChanged } from "../broadcast"
import { getAnime } from "~/model/db"
import { animeKey } from "~/model/keys"
import { addSeries, fetchCtxFor, markWatched } from "~/library/library"
import { matchEpisodeUrl, sourceForUrl } from "~/sources/registry"
import { orderServers } from "~/library/servers"
import type { Server } from "~/sources/types"
import { resolve } from "~/settings/resolver"
import { log } from "~/shared/logger"

const logger = log("handler:page")

/**
 * The content script sends the page it is sitting on; the background does all the
 * parsing. Keeping cheerio and every source out of the injected bundle is what
 * lets the content script stay small enough to inject without a visible delay.
 */
export function registerPageHandlers() {
    on("page:identify", async ({ url, html }, sender) => {
        const source = sourceForUrl(url)
        if (!source) return { sourceId: null, isEpisode: false }

        if (!matchEpisodeUrl(source, url)) {
            return { sourceId: source.id, isEpisode: false }
        }

        if (!source.isEpisodePage(html, url)) {
            logger.debug(`${source.id}: URL matched but the page has no player markup — ${url}`)
            return { sourceId: source.id, isEpisode: false }
        }

        const ctx = await fetchCtxFor(source, sender.tab?.id)

        try {
            const pageInfo = await source.getPageInfo(html, url, ctx)
            const key = animeKey(source.id, pageInfo.seriesId)

            let entry = await getAnime(key)

            /*
             * `autoAddOnWatch` decides whether an *unknown* series is added. It
             * has never decided whether an already-tracked one keeps its position
             * updated — turning it off means "stop collecting series", not "stop
             * tracking the ones I chose". AMR draws the line in the same place.
             */
            if (!entry && resolve("autoAddOnWatch", { sourceId: source.id })) {
                entry = await addSeries({
                    sourceId: source.id,
                    seriesUrl: pageInfo.seriesUrl,
                    seriesId: pageInfo.seriesId,
                    title: pageInfo.title,
                    tabId: sender.tab?.id
                })
                libraryChanged("added", entry.key)
            }

            // Opening the page is a tracking signal in its own right: the player
            // may end up embedding a frame it cannot see inside, and on a freshly
            // added series "watch next" would otherwise point at episode 1.
            if (entry && resolve("markWatchedOnOpen", { anime: entry, sourceId: source.id })) {
                entry = (await markWatched(entry.key, pageInfo.number, pageInfo.variant)) ?? entry
                libraryChanged("position", entry.key)
            }

            if (entry) await refreshBadge()

            // Servers come from the HTML we already have, ordered by preference
            // here so the player never has to know about the settings chain.
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
                // Whether an embedded player should count the episode as watched
                // on open. Resolved here so the player never has to know the
                // settings chain, and sent even when untracked — the viewer can
                // add the series from the player, and it applies from then on.
                markOnEmbed: resolve("markWatchedOnEmbed", { anime: entry, sourceId: source.id })
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error(`could not read page info for ${url}`, error)
            return { sourceId: source.id, isEpisode: true, error: message }
        }
    })
}
