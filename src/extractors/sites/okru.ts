import type { ExtractCtx, Extractor, Stream } from "~/extractors/types"
import { log } from "~/shared/logger"

const logger = log("extractor:okru")

/**
 * OK.ru (Odnoklassniki) — a common mirror on anime sites.
 *
 * The embed page carries a `data-options` attribute holding JSON, inside which
 * `flashvars.metadata` is *another* JSON string listing every rendition as a
 * direct MP4. No token dance, no packed JS.
 *
 * Those MP4s play straight from the <video> element. A plain `<video src>` is a
 * media load rather than a fetch, so it is not subject to CORS at all — which is
 * why direct-file hosts need neither the proxy nor a response-header rewrite.
 */
export class OkRuExtractor implements Extractor {
    readonly id = "okru"
    readonly hosts = ["ok.ru", "odnoklassniki.ru"]

    /** OK.ru's own names for renditions, worst to best. */
    private static readonly QUALITY: Record<string, string> = {
        mobile: "144p",
        lowest: "240p",
        low: "360p",
        sd: "480p",
        hd: "720p",
        full: "1080p",
        quad: "1440p",
        ultra: "2160p"
    }

    private static readonly ORDER = ["mobile", "lowest", "low", "sd", "hd", "full", "quad", "ultra"]

    async extract(embedUrl: string, ctx: ExtractCtx): Promise<Stream[]> {
        const html = await ctx.text(embedUrl, { headers: { Referer: ctx.referer } })

        const options = this.dataOptions(html)
        if (!options) throw new Error("no data-options block in the ok.ru embed page")

        const raw = options?.flashvars?.metadata
        const metadata: OkMetadata = typeof raw === "string" ? JSON.parse(raw) : ((raw ?? {}) as OkMetadata)

        const videos = metadata.videos ?? []
        if (videos.length === 0) {
            // A private or region-blocked video reaches here with an empty list.
            throw new Error(metadata.movie?.statusText ?? "ok.ru listed no video renditions")
        }

        const streams: Stream[] = videos
            .filter(video => typeof video.url === "string" && video.url !== "")
            .map(video => ({
                url: video.url,
                kind: "mp4" as const,
                quality: OkRuExtractor.QUALITY[video.name] ?? video.name,
                label: `OK.ru ${OkRuExtractor.QUALITY[video.name] ?? video.name}`,
                fetchVia: "page" as const
            }))
            // Best first, so the player's default pick is the highest rendition.
            .sort((a, b) => this.rank(b.quality) - this.rank(a.quality))

        logger.debug(`${streams.length} rendition(s): ${streams.map(s => s.quality).join(", ")}`)
        return streams
    }

    private rank(quality: string | undefined): number {
        if (!quality) return -1
        const index = OkRuExtractor.ORDER.findIndex(name => OkRuExtractor.QUALITY[name] === quality)
        return index === -1 ? Number.parseInt(quality, 10) || -1 : index
    }

    /** `data-options="{...}"` with HTML-escaped JSON inside. */
    private dataOptions(html: string): OkOptions | null {
        const match = html.match(/data-options="([^"]+)"/)
        if (!match?.[1]) return null
        const decoded = match[1]
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&#39;/g, "'")
        try {
            return JSON.parse(decoded) as OkOptions
        } catch {
            return null
        }
    }
}

interface OkOptions {
    flashvars?: { metadata?: string | OkMetadata }
}

interface OkMetadata {
    videos?: { name: string; url: string }[]
    movie?: { title?: string; statusText?: string }
    ondemandHls?: string
}
