import type { ExtractCtx, Extractor, ExtractorNetRule, Stream, Track } from "~/extractors/types"
import { log } from "~/shared/logger"

const logger = log("extractor:dailymotion")

const HOME = "https://www.dailymotion.com"

/**
 * Dailymotion.
 *
 * Flow, verified live 2026-08-24:
 *   1. GET the embed page. It carries a `dmInternalData` blob holding `ts` and
 *      `v1st`, and sets `ts` / `v1st` / `dmvk` cookies.
 *   2. GET /player/metadata/video/<id> with those two as query params.
 *      `qualities.auto[0].url` is a master HLS playlist.
 *   3. Hand the master to hls.js and let it enumerate levels — the master
 *      already carries every rendition, the audio group and the subtitle track,
 *      so parsing it here would only duplicate what the player does better.
 *
 * The CDN returns no usable `access-control-allow-origin` for a third-party page
 * origin, and 403s without a dailymotion Referer. So playback has to be proxied
 * through the background (which is exempt from CORS) with the Referer supplied by
 * a DNR rule. `fetchVia: "background"` below is not a preference, it is required.
 *
 * **Caveat.** The manifest edge (Cloudflare, `x-error-code: E005`) rejects some
 * requests for reasons I could not pin down from the command line — the same
 * token, cookies and headers sometimes 200 and sometimes 403, and the correlation
 * I first drew with `Accept-Encoding` did not survive re-testing with a freshly
 * minted token. Session cookies (`ts`, `v1st`, `dmvk`, set across the embed
 * redirect) and the Referer/Origin pair are definitely required. The browser
 * supplies the cookies natively, so this may simply work in the extension where
 * it is flaky from a script — but treat Dailymotion as unproven until it has
 * played, and prefer Mp4Upload for a deterministic path.
 */
export class DailymotionExtractor implements Extractor {
    readonly id = "dailymotion"
    readonly hosts = ["dailymotion.com", "dai.ly", "geo.dailymotion.com"]

    // The manifest host and the segment CDNs both require a dailymotion Referer
    // and Origin — without them the edge returns 403 with x-error-code E005.
    // That much is consistent; see the caveat on `extract` about what is not.
    readonly netRules: ExtractorNetRule[] = [
        { urlFilter: "||dmcdn.net", referer: `${HOME}/`, origin: HOME },
        { urlFilter: "||dailymotion.com", referer: `${HOME}/`, origin: HOME }
    ]

    async extract(embedUrl: string, ctx: ExtractCtx): Promise<Stream[]> {
        const videoId = this.videoIdFrom(embedUrl)
        if (!videoId) throw new Error(`no video id in ${embedUrl}`)

        const html = await ctx.text(embedUrl)

        // `ts` and `v1st` sit deep inside dmInternalData, well past the long
        // gatekeepers array — search the whole document, never a prefix of it.
        const ts = html.match(/"ts":(\d+)/)?.[1]
        const v1st = html.match(/"v1st":"([^"]+)"/)?.[1]
        if (!ts || !v1st) throw new Error("could not read ts/v1st from the embed page")

        const params = new URLSearchParams({
            locale: "en-US",
            dmV1st: v1st,
            dmTs: ts,
            is_native_app: "0"
        })
        const metadata = await ctx.json<DailymotionMetadata>(`${HOME}/player/metadata/video/${videoId}?${params}`)

        if (metadata.error) {
            // Password-protected videos need an OAuth + GraphQL dance. Not
            // implemented: report it plainly rather than failing obscurely.
            const type = metadata.error.type ?? "unknown"
            throw new Error(
                type === "password_protected"
                    ? "this Dailymotion video is password-protected"
                    : `Dailymotion returned an error: ${type}`
            )
        }

        const master = metadata.qualities?.auto?.[0]?.url
        if (!master) throw new Error("no master playlist in the metadata response")

        logger.debug(`resolved ${videoId} → master playlist`)

        return [
            {
                url: master,
                kind: "hls",
                label: "Dailymotion",
                // Every request for this stream must be proxied — see the note above.
                fetchVia: "background",
                subtitles: this.subtitlesFrom(metadata)
            }
        ]
    }

    /** `/embed/video/<id>`, `/video/<id>`, or `?video=<id>`. */
    private videoIdFrom(url: string): string | null {
        try {
            const parsed = new URL(url)
            const fromQuery = parsed.searchParams.get("video")
            if (fromQuery) return fromQuery
            const segments = parsed.pathname.split("/").filter(s => s !== "")
            return segments.at(-1) ?? null
        } catch {
            return null
        }
    }

    /**
     * The master playlist already declares its subtitle track, so hls.js picks
     * that up on its own. These are the extras the metadata lists — usually the
     * same track as a standalone .srt, which needs converting before a
     * <track> element will take it.
     */
    private subtitlesFrom(metadata: DailymotionMetadata): Track[] | undefined {
        const data = metadata.subtitles?.data
        if (!data) return undefined

        const tracks: Track[] = []
        for (const [language, entry] of Object.entries(data)) {
            const url = entry.urls?.[0]
            if (!url) continue
            tracks.push({
                url,
                label: entry.label ?? language,
                language,
                format: url.endsWith(".vtt") ? "vtt" : url.endsWith(".srt") ? "srt" : "unknown"
            })
        }
        return tracks.length > 0 ? tracks : undefined
    }
}

interface DailymotionMetadata {
    error?: { type?: string; title?: string }
    qualities?: { auto?: { url: string; type?: string }[] }
    subtitles?: { data?: Record<string, { label?: string; urls?: string[] }> }
    duration?: number
}
