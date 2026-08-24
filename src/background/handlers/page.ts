import { on } from "../router"
import { refreshBadge } from "../badge"
import { getAnime } from "~/model/db"
import { animeKey } from "~/model/keys"
import { addSeries, fetchCtxFor, markWatched } from "~/library/library"
import { matchEpisodeUrl, sourceForUrl } from "~/sources/registry"
import { cachedSettings } from "~/settings/storage"
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
            if (!entry && cachedSettings().autoAddOnWatch) {
                entry = await addSeries({
                    sourceId: source.id,
                    seriesUrl: pageInfo.seriesUrl,
                    seriesId: pageInfo.seriesId,
                    title: pageInfo.title,
                    tabId: sender.tab?.id
                })
            }

            // Until the player exists, opening the page is the only signal that
            // you are watching this episode — so it moves the pointer. Without
            // this, "watch next" on a freshly added series points at episode 1.
            if (entry && resolve("markWatchedOnOpen", { anime: entry, sourceId: source.id })) {
                entry = (await markWatched(entry.key, pageInfo.number, pageInfo.variant)) ?? entry
            }

            if (entry) await refreshBadge()

            return {
                sourceId: source.id,
                isEpisode: true,
                pageInfo,
                ...(entry ? { key: entry.key } : {})
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error(`could not read page info for ${url}`, error)
            return { sourceId: source.id, isEpisode: true, error: message }
        }
    })
}
