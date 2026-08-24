import type { AnimeSource } from "./types"
import { lmanime } from "./sites/lmanime"
import { mundodonghua } from "./sites/mundodonghua"
import { myanime } from "./sites/myanime"
import { anikoto } from "./sites/anikoto"
import { matchDomain, hostOf, pathOf } from "~/shared/url"
import { log } from "~/shared/logger"

const logger = log("sources")

/**
 * Every source, in match order. Registration is deliberately explicit and
 * static: the background needs the full list synchronously to answer a
 * navigation event without awaiting anything.
 */
const ALL: AnimeSource[] = [lmanime, mundodonghua, myanime, anikoto]

const byId = new Map<string, AnimeSource>(ALL.map(source => [source.id, source]))

export function allSources(): readonly AnimeSource[] {
    return ALL
}

export function sourceById(id: string): AnimeSource | undefined {
    return byId.get(id)
}

/**
 * Which source owns this URL's host. `extraDomains` carries hosts discovered at
 * runtime by domain resolution, which are not in the static config.
 */
export function sourceForUrl(url: string, extraDomains?: Map<string, string[]>): AnimeSource | undefined {
    const host = hostOf(url)
    if (host === "") return undefined

    for (const source of ALL) {
        const patterns = [...source.domains, ...(extraDomains?.get(source.id) ?? [])]
        if (patterns.some(pattern => matchDomain(host, pattern))) return source
    }
    return undefined
}

/** True when this URL looks like a watchable episode for its source. */
export function matchEpisodeUrl(source: AnimeSource, url: string): boolean {
    // Rebuild without /g: a global regex carries lastIndex between .test() calls
    // and will intermittently return false for the same input.
    const rx = new RegExp(source.episodeUrl.source, source.episodeUrl.flags.replace("g", ""))
    return rx.test(pathOf(url))
}

export function matchSeriesUrl(source: AnimeSource, url: string): boolean {
    if (!source.seriesUrl) return false
    const rx = new RegExp(source.seriesUrl.source, source.seriesUrl.flags.replace("g", ""))
    return rx.test(pathOf(url))
}

logger.info(`${ALL.length} source(s) registered: ${ALL.map(s => s.id).join(", ")}`)
