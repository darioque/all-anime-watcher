import type { ExtractCtx, Extractor, Stream } from "~/extractors/types"
import { log } from "~/shared/logger"

const logger = log("extractor:rumble")

export class RumbleExtractor implements Extractor {
    readonly id = "rumble"
    readonly hosts = ["rumble.com"]

    async extract(embedUrl: string, ctx: ExtractCtx): Promise<Stream[]> {
        const match = embedUrl.match(/rumble\.com\/embed\/([a-zA-Z0-9]+)/)
        if (!match?.[1]) {
            throw new Error(`Could not parse Rumble video ID from ${embedUrl}`)
        }
        const videoId = match[1]

        const apiUrl = `https://rumble.com/embedJS/u3/?request=video&ver=2&v=${videoId}`

        const data = await ctx.json<any>(apiUrl, {
            headers: {
                Referer: embedUrl
            }
        })

        const streams: Stream[] = []

        // Extract MP4 progressive streams if available
        const mp4 = data.ua?.mp4 || data.u?.mp4
        if (mp4) {
            for (const [quality, info] of Object.entries<any>(mp4)) {
                if (info?.url) {
                    streams.push({
                        url: info.url,
                        kind: "mp4",
                        quality: `${quality}p`,
                        label: `Rumble ${quality}p`
                    })
                }
            }
        }

        // Extract HLS adaptive stream
        const hlsUrl = data.ua?.hls?.auto?.url || data.u?.hls?.url
        if (hlsUrl) {
            streams.push({
                url: hlsUrl,
                kind: "hls",
                label: "Rumble HLS"
            })
        }

        if (streams.length === 0) {
            throw new Error("No streams found in Rumble response")
        }

        // Sort streams (HLS first, then MP4 by quality descending)
        streams.sort((a, b) => {
            if (a.kind === "hls" && b.kind !== "hls") return -1
            if (b.kind === "hls" && a.kind !== "hls") return 1
            const qA = parseInt(a.quality || "0", 10)
            const qB = parseInt(b.quality || "0", 10)
            return qB - qA
        })

        logger.debug(`resolved ${videoId} → ${streams.length} stream(s)`)
        return streams
    }
}
