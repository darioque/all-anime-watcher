import type { ExtractCtx, Extractor, Stream, Track } from "~/extractors/types"
import { hostOf } from "~/shared/url"
import { log } from "~/shared/logger"
import { fromBase64Url } from "~/shared/binary"

const logger = log("extractor:byse")

/**
 * Byse — the host mundodonghua labels "Fm".
 *
 * Nothing in the page to scrape. `/e/<code>` serves a React shell with an empty
 * `<div id="root">`, and the player config arrives from `/api/videos/<code>` as
 * an **AES-256-GCM ciphertext** whose key is handed over in the same response,
 * split across thirty parts. Which two of those thirty make the key is decided
 * by the `version` field, and it changes on every request.
 *
 * That is an obfuscation, not a secret: the whole scheme is in the site's own
 * bundle, and it holds only for as long as nobody reads it. Reimplemented here
 * because the alternative is an iframe — which plays, but loses progress
 * tracking, the quality picker and downloads, and says nothing about why.
 *
 * This host was previously listed as a StreamWish white-label, on the strength
 * of a `/e/<id>` URL shape that half the industry uses. It never was one, so
 * every episode on this server fell back to an iframe while the extractor that
 * claimed it reported "no playlist in the player".
 *
 * The API needs no Referer, and the CDN it points at sets
 * `Access-Control-Allow-Origin: *`, so the page fetches the playlist itself. No
 * header rules on either leg.
 */
export class ByseExtractor implements Extractor {
    readonly id = "byse"

    /**
     * As with every host of this kind, the domains rotate and this list will go
     * stale. Adding one is a one-line change; matching on URL shape instead
     * would swallow the several other families that also serve `/e/<id>`, which
     * is exactly the mistake that hid this host behind StreamWish.
     */
    private static readonly KNOWN = ["bysekoze.com"]

    readonly hosts = (url: string): boolean => {
        const host = hostOf(url)
        return ByseExtractor.KNOWN.some(known => host === known || host.endsWith(`.${known}`))
    }

    async extract(embedUrl: string, ctx: ExtractCtx): Promise<Stream[]> {
        const host = hostOf(embedUrl)
        const code = videoCode(embedUrl)
        if (!code) throw new Error(`${host}: no video code in ${embedUrl}`)

        const origin = new URL(embedUrl).origin
        const video = await ctx.json<ByseVideo>(`${origin}/api/videos/${encodeURIComponent(code)}`, {
            headers: { Referer: embedUrl }
        })

        if (!video?.playback) {
            // A deleted or geo-blocked file answers with the record and no
            // playback block rather than with an error.
            throw new Error(
                `${host}: the API returned no playback config${video?.title ? ` for "${video.title}"` : ""}`
            )
        }

        const config = await decryptPlayback(video.playback)
        const sources = config.sources ?? []
        if (sources.length === 0) throw new Error(`${host}: the playback config carries no sources`)

        const subtitles = tracksOf([...(config.tracks ?? []), ...(video.tracks ?? [])])
        logger.debug(`${host} → ${sources.length} source(s), ${subtitles?.length ?? 0} track(s)`)

        return sources.map(source => ({
            url: source.url,
            kind: source.mime_type === "video/mp4" ? ("mp4" as const) : ("hls" as const),
            label: "Byse",
            ...(source.label ? { quality: source.label } : {}),
            // ACAO is *, so the page can fetch this itself.
            fetchVia: "page" as const,
            ...(subtitles ? { subtitles } : {})
        }))
    }
}

/** `https://bysekoze.com/e/afl6vo7sypot` → `afl6vo7sypot`. */
export function videoCode(embedUrl: string): string | null {
    try {
        return /^\/e\/([A-Za-z0-9]+)/.exec(new URL(embedUrl).pathname)?.[1] ?? null
    } catch {
        return null
    }
}

interface ByseVideo {
    title?: string
    tracks?: ByseTrack[]
    playback?: BysePlayback
}

export interface BysePlayback {
    /** Base64url, 12 bytes. */
    iv: string
    /** Base64url ciphertext with the GCM tag appended, as WebCrypto expects. */
    payload: string
    key_parts: string[]
    /** Decides which two parts make the key. A string in the JSON, not a number. */
    version: string
}

interface ByseSource {
    url: string
    label?: string
    mime_type?: string
    height?: number
}

interface ByseTrack {
    url: string
    title?: string
    language?: string
    kind?: string
    default?: boolean
}

interface ByseConfig {
    sources?: ByseSource[]
    tracks?: ByseTrack[]
}

/**
 * Which two of the key parts make the key.
 *
 * The site builds a lookup of `n → [n, 31 - n]` for n in 1..20 and indexes it
 * with `version`, discarding the pair if either index falls outside the parts
 * it was given. Reproduced exactly, one-based, because a plausible-looking
 * simplification here yields a key that is the right length and wrong, and the
 * only symptom is a decrypt that fails with no explanation.
 */
export function keyIndices(version: string, partCount: number): [number, number] | null {
    const n = Number(String(version).trim())
    if (!Number.isInteger(n) || n < 1 || n > 20) return null

    const pair: [number, number] = [n, 31 - n]
    if (pair.some(index => index < 1 || index > partCount)) return null
    return pair
}

/** The 32-byte AES key, assembled from the two parts `version` names. */
export function assembleKey(playback: Pick<BysePlayback, "key_parts" | "version">): Uint8Array<ArrayBuffer> {
    const indices = keyIndices(playback.version, playback.key_parts.length)
    if (!indices) {
        throw new Error(`byse: version "${playback.version}" names no key parts among ${playback.key_parts.length}`)
    }

    const chosen = indices.map(index => playback.key_parts[index - 1]).filter((part): part is string => Boolean(part))
    const bytes = chosen.map(fromBase64Url)
    const key = new Uint8Array(bytes.reduce((total, part) => total + part.length, 0))

    let offset = 0
    for (const part of bytes) {
        key.set(part, offset)
        offset += part.length
    }

    if (key.length !== 32) throw new Error(`byse: assembled a ${key.length}-byte key, expected 32`)
    return key
}

// Re-exported for the check suite, which pins the site's `-_`, no-padding
// encoding here where it was first needed.
export { fromBase64Url }

export async function decryptPlayback(playback: BysePlayback): Promise<ByseConfig> {
    const key = await crypto.subtle.importKey("raw", assembleKey(playback).buffer, "AES-GCM", false, ["decrypt"])
    const iv = fromBase64Url(playback.iv)
    const payload = fromBase64Url(playback.payload)

    let plain: ArrayBuffer
    try {
        plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, payload)
    } catch {
        // Either the key derivation is out of date or the payload expired in
        // transit. Both look identical from here; say so rather than guess.
        throw new Error("byse: the playback config would not decrypt — the key scheme has probably changed")
    }

    return JSON.parse(new TextDecoder().decode(plain)) as ByseConfig
}

function tracksOf(tracks: ByseTrack[]): Track[] | undefined {
    const mapped = tracks
        .filter(track => Boolean(track.url))
        .map<Track>(track => ({
            url: track.url,
            label: track.title || track.language || "Subtitles",
            ...(track.language ? { language: track.language } : {}),
            format: track.url.endsWith(".vtt") ? "vtt" : track.url.endsWith(".srt") ? "srt" : "unknown",
            ...(track.default ? { default: true } : {})
        }))
    return mapped.length > 0 ? mapped : undefined
}
