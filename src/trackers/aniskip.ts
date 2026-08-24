import type { Span } from "~/extractors/types"
import { log } from "~/shared/logger"

const logger = log("aniskip")

const ENDPOINT = "https://api.aniskip.com/v2/skip-times"

export interface SkipTimes {
    intro?: Span
    outro?: Span
}

/**
 * AniSkip — crowd-sourced opening and ending offsets, keyed by **MAL id**.
 *
 * A fallback, not the first choice: a site that publishes its own offsets
 * measured them against the encode it is actually serving, whereas these are
 * contributed against whatever release the contributor had. Close enough to be
 * useful, not close enough to override.
 *
 * The MAL id comes from AniList's `idMal`, which is why linking a series is what
 * unlocks skipping for sources that don't ship their own timings.
 */
export async function fetchSkipTimes(
    malId: number,
    episodeNumber: number,
    episodeLengthSec = 0
): Promise<SkipTimes | null> {
    const params = new URLSearchParams({ episodeLength: String(Math.round(episodeLengthSec)) })
    // Ask for the mixed variants too — shows that run the OP over cold-open
    // footage are filed under "mixed-op" rather than "op".
    for (const type of ["op", "ed", "mixed-op", "mixed-ed"]) params.append("types", type)

    const url = `${ENDPOINT}/${malId}/${episodeNumber}?${params}`

    try {
        const response = await fetch(url, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(12_000)
        })

        // 404 means "nobody has submitted times for this episode", which is
        // ordinary rather than an error.
        if (response.status === 404) return null
        if (!response.ok) {
            logger.debug(`HTTP ${response.status} for MAL ${malId} episode ${episodeNumber}`)
            return null
        }

        const body = (await response.json()) as {
            found?: boolean
            results?: { skipType?: string; interval?: { startTime?: number; endTime?: number } }[]
        }
        if (!body.found || !body.results?.length) return null

        const times: SkipTimes = {}
        for (const result of body.results) {
            const start = result.interval?.startTime
            const end = result.interval?.endTime
            if (start === undefined || end === undefined || end <= start) continue

            const span: Span = { startSec: start, endSec: end }
            if (result.skipType === "op" || result.skipType === "mixed-op") times.intro ??= span
            if (result.skipType === "ed" || result.skipType === "mixed-ed") times.outro ??= span
        }

        if (!times.intro && !times.outro) return null
        logger.debug(`MAL ${malId} ep ${episodeNumber}: ${times.intro ? "intro" : ""}${times.outro ? " outro" : ""}`)
        return times
    } catch (error) {
        logger.debug(`lookup failed for MAL ${malId} episode ${episodeNumber}`, error)
        return null
    }
}
