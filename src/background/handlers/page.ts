import { on } from "../router"
import { episodeSourceFor, identifyEpisode } from "../identify"
import { matchEpisodeUrl, sourceForUrl } from "~/sources/registry"

/**
 * The content script sends the page it is sitting on; the background does all the
 * parsing. Keeping cheerio and every source out of the injected bundle is what
 * lets the content script stay small enough to inject without a visible delay.
 *
 * The reading itself lives in `../identify`, shared with the next-episode
 * prefetcher — the only difference between them is whether the read counts as
 * watching, and that is one flag rather than two copies of the parser.
 */
export function registerPageHandlers() {
    on("page:identify", async ({ url, html }, sender) => {
        const source = sourceForUrl(url)
        if (!source) return { sourceId: null, isEpisode: false }
        if (!matchEpisodeUrl(source, url)) return { sourceId: source.id, isEpisode: false }

        return identifyEpisode({
            source,
            url,
            html,
            ...(sender.tab?.id !== undefined ? { tabId: sender.tab.id } : {}),
            track: true
        })
    })
}

export { episodeSourceFor }
