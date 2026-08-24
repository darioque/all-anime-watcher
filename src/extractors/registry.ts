import type { Extractor } from "./types"
import { hostOf } from "~/shared/url"
import { log } from "~/shared/logger"

const logger = log("extractors")

/**
 * Empty until phase 2, which is where the first real ones land: Mp4Upload,
 * StreamWish/FileLions and Dailymotion cover lmanime; Megacloud covers the
 * ZoroTheme family; a generic HLS/MP4 passthrough covers direct links.
 */
const ALL: Extractor[] = []

export function allExtractors(): readonly Extractor[] {
    return ALL
}

export function extractorFor(embedUrl: string): Extractor | undefined {
    const host = hostOf(embedUrl)
    for (const extractor of ALL) {
        if (typeof extractor.hosts === "function") {
            if (extractor.hosts(embedUrl)) return extractor
        } else if (extractor.hosts.some(h => host === h || host.endsWith(`.${h}`))) {
            return extractor
        }
    }
    logger.warn(`no extractor for ${host || embedUrl}`)
    return undefined
}
