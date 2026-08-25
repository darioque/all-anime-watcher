import type { Episode } from "~/model/types"
import type { SeriesInfo } from "~/sources/types"

/**
 * What the Lab's background probes report back.
 *
 * Kept apart from `shared/messages` so the pure checks can be run by a Node
 * script: importing that module pulls in webextension-polyfill, which throws on
 * sight outside a browser.
 */

export interface LabSeriesReport {
    /** The id the source derives from the *series* URL. */
    seriesId: string | null
    info: SeriesInfo
    episodeCount: number
    /**
     * Every episode number, in the order the source returned them. The whole
     * list is what makes an ordering fault visible — the two ends agree with
     * each other in plenty of lists that are scrambled in between.
     */
    numbers: number[]
    first: Episode[]
    last: Episode[]
    /** `source.episodeUrl.source`, so the checks can test the list's own URLs. */
    episodePattern: string
}

/** One URL fetched through the extension's real rules. */
export interface LabFetchReport {
    url: string
    status: number
    ok: boolean
    bytes: number
    contentType: string
    kind: "master playlist" | "media playlist" | "not a playlist"
    /** Variants in a master playlist, segments in a media one. */
    entries: number
    /** The first few lines, which is where an error page announces itself. */
    head: string
}
