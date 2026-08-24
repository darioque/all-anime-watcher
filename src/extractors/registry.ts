import type { Extractor, ExtractorNetRule } from "./types"
import { DailymotionExtractor } from "./sites/dailymotion"
import { Mp4UploadExtractor } from "./sites/mp4upload"
import { DirectStreamExtractor } from "./sites/directStream"
import { hostOf } from "~/shared/url"
import { log } from "~/shared/logger"

const logger = log("extractors")

/**
 * Extractors are keyed by video host, not by site, and shared across every
 * source — this is the layer that makes adding a site cheap.
 *
 * Order matters only in that the URL-shape matcher must come last, so a host
 * that happens to end in .mp4 still reaches its own extractor first.
 */
const ALL: Extractor[] = [new DailymotionExtractor(), new Mp4UploadExtractor(), new DirectStreamExtractor()]

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

/** Every header rewrite the registered extractors need. */
export function allNetRules(): ExtractorNetRule[] {
    return ALL.flatMap(extractor => extractor.netRules ?? [])
}

logger.info(`${ALL.length} extractor(s) registered: ${ALL.map(e => e.id).join(", ")}`)
