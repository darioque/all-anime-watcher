/** A subtitle or alternate-audio track that travels with a stream. */
export interface Track {
    url: string
    label: string
    language?: string
    /** WebVTT plays natively; ASS/SSA needs a renderer. */
    format?: "vtt" | "srt" | "ass" | "unknown"
    default?: boolean
    /**
     * The file arrives wrapped in a JSON object; the track is this key's string.
     * donghualife.com serves `{ "content": "<ASS script>" }` rather than a file.
     */
    jsonField?: string
}

export interface Span {
    startSec: number
    endSec: number
}

export interface Stream {
    url: string
    /**
     * `iframe` is the fallback for a host we can't extract: the embed plays in
     * its own player inside our chrome. Episode navigation, the server picker and
     * the library all keep working; only in-video progress is lost, since the
     * page can't see inside a cross-origin frame. Better than a dead end, and it
     * means an unknown host is degraded rather than unsupported.
     */
    kind: "hls" | "mp4" | "dash" | "iframe"
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

/**
 * A Referer/Origin rewrite the video host demands.
 *
 * Neither header can be set from `fetch()` — both are forbidden header names — so
 * the only way to send them is a declarativeNetRequest rule scoped to requests
 * the extension itself initiates. An extractor declares what it needs and
 * background/dnr.ts installs it. Same mechanism AMR uses to get past hotlink
 * protection on image CDNs.
 */
export interface ExtractorNetRule {
    /** DNR urlFilter, e.g. "||dmcdn.net". Prefer this over regexFilter. */
    urlFilter?: string
    /** Restrict to these request domains (subdomains included). */
    requestDomains?: string[]
    referer?: string
    origin?: string
    /**
     * Request headers to strip entirely.
     *
     * Chrome always sends `Accept-Encoding`, and `fetch()` cannot remove it —
     * it is a forbidden header name. Some CDNs reject any request that carries
     * it: Dailymotion's manifest host 403s on *any* value, including `identity`,
     * and only succeeds when the header is absent. DNR removal is the only way
     * to satisfy that.
     */
    removeHeaders?: string[]
    /**
     * Whose requests to rewrite.
     *
     *  - `extension` (default): the background proxy's fetches.
     *  - `page`: requests the taken-over page makes itself, e.g. a <video src>
     *    pointing at a direct MP4. Scoped to our sources' own pages.
     *  - `both`.
     */
    appliesTo?: "extension" | "page" | "both"
    /** Defaults to xmlhttprequest + media + other. */
    resourceTypes?: ("xmlhttprequest" | "media" | "other" | "image")[]
}

/** What an extractor may ask of a request. POST exists for hosts whose API is JSON-RPC, like Odysee's. */
export interface ExtractRequestInit {
    headers?: Record<string, string>
    method?: "GET" | "POST"
    body?: string
}

export interface ExtractCtx {
    /** Page the embed was found on; most hosts want this as Referer. */
    referer: string
    text(url: string, init?: ExtractRequestInit): Promise<string>
    json<T = unknown>(url: string, init?: ExtractRequestInit): Promise<T>
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
    /** Header rewrites this host's CDN requires. Installed once at startup. */
    readonly netRules?: ExtractorNetRule[]
}
