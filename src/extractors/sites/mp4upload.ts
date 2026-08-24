import type { ExtractCtx, Extractor, ExtractorNetRule, Stream } from "~/extractors/types"
import { log } from "~/shared/logger"

const logger = log("extractor:mp4upload")

const HOME = "https://www.mp4upload.com"

/**
 * Mp4Upload — the simplest kind of host there is.
 *
 * The embed page ships a videojs config with the file URL inline:
 *   src: "https://a3.mp4upload.com:183/d/<token>/video.mp4"
 *
 * That is a plain progressive MP4, so the <video> element can play it directly:
 * no MSE, no HLS, no proxy, and seeking is the CDN's problem via range requests.
 * The one requirement is a Referer of mp4upload's own origin — without it the
 * file host 403s — which a DNR rule supplies for the page's own media request.
 */
export class Mp4UploadExtractor implements Extractor {
    readonly id = "mp4upload"
    readonly hosts = ["mp4upload.com"]

    readonly netRules: ExtractorNetRule[] = [
        {
            urlFilter: "||mp4upload.com",
            referer: `${HOME}/`,
            // The <video> element issues this request from the page we took over,
            // so the rewrite has to cover page-initiated media, not just our proxy.
            appliesTo: "both",
            resourceTypes: ["media", "xmlhttprequest", "other"]
        }
    ]

    async extract(embedUrl: string, ctx: ExtractCtx): Promise<Stream[]> {
        const html = await ctx.text(embedUrl, { headers: { Referer: ctx.referer } })

        const direct = this.fileUrlFrom(html)
        if (!direct) throw new Error("no video URL in the mp4upload embed page")

        logger.debug(`resolved → ${new URL(direct).host}`)

        return [
            {
                url: direct,
                kind: "mp4",
                label: "Mp4Upload",
                // Straight to the <video> element; the DNR rule handles the Referer.
                fetchVia: "page"
            }
        ]
    }

    /**
     * `src: "…"` inside the player config. Fall back to any absolute .mp4 that
     * is not a player asset, in case the config shape shifts.
     */
    private fileUrlFrom(html: string): string | null {
        const configured = html.match(/\bsrc\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i)?.[1]
        if (configured) return configured

        for (const match of html.matchAll(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/gi)) {
            const url = match[0]
            if (!/\/player\/|videojs|\.min\./i.test(url)) return url
        }
        return null
    }
}
