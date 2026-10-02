import type { ExtractCtx, Extractor, Stream, Track } from "~/extractors/types"
import { hostOf } from "~/shared/url"
import { log } from "~/shared/logger"

const logger = log("extractor:vidara")

/**
 * Vidara — a JW Player page that asks its own API for the stream.
 *
 * Verified 2026-10-01 from animekhor.org's "DaraPlayer":
 *
 *   embed    https://vidara.to/e/<filecode>
 *   stream   POST /api/stream {filecode, device, codecs}   → { streaming_url, subtitles }
 *
 * No encryption and no headers anywhere: the master, its variants and the
 * segments (fMP4 served as `font/woff2`) all answer without a Referer and with
 * `access-control-allow-origin: *`. The playlist token carries the client's IP,
 * which is harmless here — the extension fetches it from the machine that plays it.
 *
 * `codecs` is the page's guess at AV1/HEVC support; sending none gets the H.264
 * ladder every browser decodes. Subtitles of `type: 0` are the side-loaded VTT
 * files the page itself hands JW Player.
 */
export class VidaraExtractor implements Extractor {
    readonly id = "vidara"
    readonly hosts = (url: string) => /(^|\.)vidara\.(to|so)$/.test(hostOf(url))

    async extract(embedUrl: string, ctx: ExtractCtx): Promise<Stream[]> {
        const url = new URL(embedUrl)
        const filecode = url.pathname.split("/").filter(Boolean).pop()
        if (!filecode) throw new Error(`no file code in ${embedUrl}`)

        const data = await ctx.json<VidaraStream>(`${url.origin}/api/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Referer: embedUrl },
            body: JSON.stringify({ filecode, device: "web", codecs: [] })
        })
        if (!data.streaming_url) throw new Error("vidara: the API returned no stream — the file may be gone")

        logger.debug(`${filecode} → ${hostOf(data.streaming_url)}`)
        return [
            {
                url: data.streaming_url,
                kind: /\.m3u8(\?|$)/.test(data.streaming_url) ? "hls" : "mp4",
                label: data.title || "Vidara",
                subtitles: tracksOf(data)
            }
        ]
    }
}

interface VidaraStream {
    streaming_url?: string
    title?: string
    default_sub_lang?: string
    subtitles?: Array<{ type?: number; language?: string; file_path?: string }>
}

function tracksOf(data: VidaraStream): Track[] {
    const preferred = data.default_sub_lang?.toLowerCase()
    return (data.subtitles ?? [])
        .filter(sub => sub.type === 0 && sub.file_path)
        .map(sub => ({
            url: sub.file_path!,
            label: sub.language || "Subtitle",
            format: "vtt" as const,
            default: preferred !== undefined && sub.language?.toLowerCase() === preferred
        }))
}
