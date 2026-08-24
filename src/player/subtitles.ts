import type { Track } from "~/extractors/types"
import { send } from "~/shared/messages"
import { isVtt, srtToVtt } from "~/shared/vtt"

/**
 * Getting a subtitle file onto a `<track>` element.
 *
 * Two obstacles, both solved the same way. Subtitle files sit on the video CDN
 * and usually send no CORS headers, so the page can't fetch them — the
 * background can. And several hosts serve SubRip rather than WebVTT, which
 * `<track>` refuses outright; Dailymotion is one.
 *
 * So: fetch through the proxy, convert if needed, and hand the element a blob
 * URL from our own origin.
 */

export interface LoadedTrack extends Track {
    /** Blob URL on our own origin, safe to hand to a <track> element. */
    objectUrl: string
}

/**
 * Fetch a subtitle track and return something `<track src>` will accept.
 *
 * Returns null rather than throwing: a missing subtitle should never stop an
 * episode playing.
 */
export async function loadTrack(track: Track): Promise<LoadedTrack | null> {
    try {
        const response = await send("playback:fetch", { url: track.url, responseType: "text" })
        if (response.error || !response.text) return null

        const content = isVtt(response.text) ? response.text : srtToVtt(response.text)

        const blob = new Blob([content], { type: "text/vtt" })
        return { ...track, objectUrl: URL.createObjectURL(blob) }
    } catch {
        return null
    }
}

export function releaseTracks(tracks: LoadedTrack[]): void {
    for (const track of tracks) URL.revokeObjectURL(track.objectUrl)
}
