import type { ExtractCtx, Extractor, Stream, Track } from "~/extractors/types"
import { log } from "~/shared/logger"

const logger = log("extractor:megaplay")

/**
 * MegaPlay — the host behind Anikoto and the rest of the AnimeKai/HiAnime family.
 *
 * Two requests and no obfuscation at all:
 *
 *   /stream/s-2/<realId>/sub    → <div id="megaplay-player" data-id="114042">
 *   /stream/getSources?id=…     → { sources: { file }, tracks, intro, outro }
 *
 * The id in the embed URL is *not* the id `getSources` wants — that one is only
 * in the page — which is the whole reason this needs a page fetch rather than
 * being derivable from the URL.
 *
 * The response also carries intro/outro offsets. Anikoto already publishes those
 * through its own API, and it wins where the two disagree since it is closer to
 * the encode, but every other site on this host gets them from here for free.
 *
 * Referer is load-bearing twice over, and neither one can be set from `fetch()`:
 * the embed page answers a Referer-less request with HTTP 200 and an error page,
 * and the CDN 403s without a Referer of the embed host. Both hosts rotate, so
 * both rewrites are installed as DNR rules at playback time rather than declared
 * against hostnames here — see `ensureRefererRule`.
 */
export class MegaPlayExtractor implements Extractor {
    readonly id = "megaplay"

    /**
     * The engine is white-labelled across hosts that come and go — anikoto alone
     * serves it from megaplay.buzz and vidtube.site, and both pages identify
     * themselves as `megaplay-1.buzz` internally — so the path shape is the only
     * durable signal.
     *
     * Matching loosely is safe here: a host that turns out not to be this engine
     * fails on the missing `data-id` and the playback handler falls back to
     * embedding it, which is where an unrecognised host would have landed anyway.
     */
    readonly hosts = (url: string): boolean => {
        try {
            const { pathname } = new URL(url)
            return /^\/stream\/.+\/(h?sub|h?dub|raw)$/i.test(pathname)
        } catch {
            return false
        }
    }

    async extract(embedUrl: string, ctx: ExtractCtx): Promise<Stream[]> {
        const origin = new URL(embedUrl).origin
        const html = await ctx.text(embedUrl, { headers: { Referer: ctx.referer } })

        const fileId =
            /id="megaplay-player"[^>]*\bdata-id="(\d+)"/.exec(html)?.[1] ?? /\bdata-id="(\d+)"/.exec(html)?.[1]
        if (!fileId) {
            /*
             * A missing Referer is answered with HTTP 200 and an error page, not
             * a 4xx — so it arrives here looking exactly like markup that
             * changed. `fetch()` cannot set Referer, so the header comes from a
             * DNR rule the playback handler installs before calling this, and
             * saying which of the two failed is the difference between a
             * five-minute fix and re-deriving the whole extractor.
             */
            const rejected = /<title>\s*Error/i.test(html) || html.includes("mg-error")
            throw new Error(
                rejected
                    ? "megaplay refused the request — it answers 200 with an error page when the Referer is missing"
                    : "no data-id on the megaplay embed page"
            )
        }

        const payload = await ctx.json<SourcesResponse>(`${origin}/stream/getSources?id=${fileId}`, {
            headers: { Referer: embedUrl, "X-Requested-With": "XMLHttpRequest" }
        })

        const file = payload.sources?.file
        if (!file) throw new Error(`megaplay returned no source for file ${fileId}`)

        const subtitles = (payload.tracks ?? [])
            .filter(track => track.kind !== "thumbnails" && Boolean(track.file))
            .map<Track>(track => ({
                url: track.file,
                label: track.label || "Subtitles",
                format: track.file.endsWith(".srt") ? "srt" : "vtt",
                ...(track.default ? { default: true } : {})
            }))

        const skips = spans(payload)
        logger.debug(`file ${fileId} → ${subtitles.length} track(s)${skips ? ", with skip offsets" : ""}`)

        return [
            {
                url: file,
                kind: file.includes(".m3u8") ? "hls" : "mp4",
                label: "MegaPlay",
                // Forbidden header, so this is a request for a DNR rule rather
                // than something the proxy's fetch could set itself.
                headers: { Referer: `${origin}/` },
                ...(subtitles.length > 0 ? { subtitles } : {}),
                ...(skips ? { skips } : {})
            }
        ]
    }
}

interface SourcesResponse {
    sources?: { file?: string }
    tracks?: { file: string; label?: string; kind?: string; default?: boolean }[]
    intro?: { start?: number; end?: number }
    outro?: { start?: number; end?: number }
}

/** `{start: 0, end: 0}` is how this API says "unknown", not "skip nothing". */
function spans(payload: SourcesResponse): Stream["skips"] | null {
    const span = (value?: { start?: number; end?: number }) => {
        const { start, end } = value ?? {}
        if (start === undefined || end === undefined || end <= start) return undefined
        return { startSec: start, endSec: end }
    }

    const intro = span(payload.intro)
    const outro = span(payload.outro)
    if (!intro && !outro) return null
    return { ...(intro ? { intro } : {}), ...(outro ? { outro } : {}) }
}
