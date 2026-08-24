/** A subtitle or alternate-audio track that travels with a stream. */
export interface Track {
    url: string
    label: string
    language?: string
    /** WebVTT plays natively; ASS/SSA needs a renderer. */
    format?: "vtt" | "srt" | "ass" | "unknown"
    default?: boolean
}

export interface Span {
    startSec: number
    endSec: number
}

export interface Stream {
    url: string
    kind: "hls" | "mp4" | "dash"
    /** "1080p". Absent means an adaptive master playlist. */
    quality?: string
    /** Label shown in the quality/server picker. */
    label?: string
    /** Headers the CDN requires — usually Referer and Origin. */
    headers?: Record<string, string>
    subtitles?: Track[]
    audioTracks?: Track[]
    /** Some hosts ship OP/ED offsets alongside the sources. */
    skips?: { intro?: Span; outro?: Span }
    /**
     * Pin the fetch strategy for this stream. Left unset, the player starts with
     * a direct page fetch and escalates on failure.
     */
    fetchVia?: "page" | "dnr" | "background"
}

export interface ExtractCtx {
    /** Page the embed was found on; most hosts want this as Referer. */
    referer: string
    text(url: string, init?: { headers?: Record<string, string> }): Promise<string>
    json<T = unknown>(url: string, init?: { headers?: Record<string, string> }): Promise<T>
}

/**
 * Turns one embed URL into playable streams.
 *
 * Extractors are keyed by video host, not by site, and shared across every
 * source — this is the layer that makes adding a site cheap. The Aniyomi
 * ecosystem gets ~236 sites out of ~58 of these.
 */
export interface Extractor {
    readonly id: string
    /** Hostnames handled, or a predicate for hosts with rotating domains. */
    readonly hosts: string[] | ((url: string) => boolean)
    extract(embedUrl: string, ctx: ExtractCtx): Promise<Stream[]>
}
