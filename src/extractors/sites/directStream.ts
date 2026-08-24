import type { ExtractCtx, Extractor, Stream } from "~/extractors/types"

/**
 * Last resort: the "embed" is already a playable file.
 *
 * Some sources hand back a direct .m3u8 or .mp4 rather than a host page. Matching
 * on the URL shape rather than a hostname means this catches them all, and it is
 * consulted only after every host-specific extractor has declined.
 */
export class DirectStreamExtractor implements Extractor {
    readonly id = "direct"

    readonly hosts = (url: string) => /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(url)

    async extract(embedUrl: string, _ctx: ExtractCtx): Promise<Stream[]> {
        const isHls = /\.m3u8(\?|#|$)/i.test(embedUrl)
        return [
            {
                url: embedUrl,
                kind: isHls ? "hls" : "mp4",
                label: "Direct"
            }
        ]
    }
}
