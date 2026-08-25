/**
 * Minimal HLS playlist reading, kept free of transport so it can be tested.
 *
 * Not a parser — hls.js does the real work. This exists to answer one question
 * the background needs before playback starts: which *hosts* does this playlist
 * refer to? A manifest and its segments are routinely served from unrelated
 * domains, and a header rewrite installed for only the manifest's host gets the
 * manifest and none of the video.
 */

/** True for a master playlist — one that names variants rather than segments. */
export function isMasterPlaylist(text: string): boolean {
    return /#EXT-X-STREAM-INF/.test(text)
}

/**
 * Every URL the playlist refers to, in the order it names them.
 *
 * Bare lines are the obvious ones. The rest hide in `URI="…"` attributes:
 * `#EXT-X-MEDIA` for alternate audio and subtitles, `#EXT-X-KEY` for the
 * decryption key, `#EXT-X-I-FRAME-STREAM-INF` for the trick-play playlist. A key
 * that fails to load is an encrypted stream that never plays, so missing those
 * is not a cosmetic gap.
 *
 * Returned as written: relative entries stay relative, and resolving them is the
 * caller's job because only it knows the playlist's own URL.
 */
export function playlistUrls(text: string): string[] {
    const found: string[] = []

    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed === "") continue

        if (!trimmed.startsWith("#")) {
            found.push(trimmed)
            continue
        }

        for (const match of trimmed.matchAll(/URI="([^"]+)"/g)) {
            if (match[1]) found.push(match[1])
        }
    }

    return found
}

// --------------------------------------------------------------- master playlists

/** One rendition of a master playlist. */
export interface Variant {
    /** As written in the playlist; resolve against the master's own URL. */
    url: string
    bandwidth?: number
    width?: number
    height?: number
    codecs?: string
    /** The NAME attribute, where the packager bothered to set one. */
    name?: string
}

/**
 * The variants a master playlist offers, in the order it lists them.
 *
 * `#EXT-X-STREAM-INF` carries its attributes on the tag line and its URL on the
 * *next* non-comment line, which is why this cannot be a per-line match.
 */
export function playlistVariants(text: string): Variant[] {
    const lines = text.split(/\r?\n/)
    const variants: Variant[] = []

    for (const [index, raw] of lines.entries()) {
        const line = raw.trim()
        if (!line.startsWith("#EXT-X-STREAM-INF")) continue

        const url = lines.slice(index + 1).find(next => next.trim() !== "" && !next.trim().startsWith("#"))
        if (!url) continue

        const attributes = parseAttributes(line)
        const resolution = /^(\d+)x(\d+)$/.exec(attributes.RESOLUTION ?? "")

        variants.push({
            url: url.trim(),
            ...(attributes.BANDWIDTH ? { bandwidth: Number.parseInt(attributes.BANDWIDTH, 10) } : {}),
            ...(resolution ? { width: Number(resolution[1]), height: Number(resolution[2]) } : {}),
            ...(attributes.CODECS ? { codecs: attributes.CODECS } : {}),
            ...(attributes.NAME ? { name: attributes.NAME } : {})
        })
    }

    return variants
}

/**
 * Which rendition to take for a given preference.
 *
 * "1080p" means *at most* 1080p, not exactly: a stream topping out at 720p
 * should still download rather than fail because the preferred height is not on
 * offer. Falling back upward would silently hand someone a 4K file they did not
 * ask for and cannot afford, so the fallback is always downward, and only when
 * nothing at or below the target exists does it take the smallest available.
 */
export function pickVariant(variants: Variant[], preference: string): Variant | undefined {
    if (variants.length === 0) return undefined

    const byQuality = [...variants].sort((a, b) => rank(b) - rank(a))
    if (preference === "highest") return byQuality[0]
    if (preference === "lowest") return byQuality[byQuality.length - 1]

    const target = Number.parseInt(preference, 10)
    if (!Number.isFinite(target)) return byQuality[0]

    return byQuality.find(variant => (variant.height ?? 0) <= target) ?? byQuality[byQuality.length - 1]
}

/** Height where stated, bandwidth otherwise — packagers omit RESOLUTION often. */
function rank(variant: Variant): number {
    if (variant.height) return variant.height
    // Scaled so a bandwidth-only variant still orders sensibly against heights.
    return (variant.bandwidth ?? 0) / 10_000
}

// ---------------------------------------------------------------- media playlists

/** The `#EXT-X-KEY` in force for a segment. */
export interface KeyInfo {
    /** "NONE", "AES-128", "SAMPLE-AES", … as written. */
    method: string
    /** As written; resolve against the playlist URL. */
    uri?: string
    /** Hex as written, "0x…". Absent means the sequence number is the IV. */
    iv?: string
}

export interface Segment {
    url: string
    durationSec: number
    /** Media sequence number. Doubles as the implicit IV when the key states none. */
    index: number
    key?: KeyInfo
}

export interface MediaPlaylist {
    segments: Segment[]
    /** `#EXT-X-MAP` — the fMP4 initialisation segment, written before the rest. */
    initUrl?: string
    totalDurationSec: number
    /**
     * What we can actually do with it. `unsupported` is honest rather than
     * optimistic: writing out SAMPLE-AES segments produces a file that looks
     * complete and plays as noise.
     */
    encryption: "none" | "aes-128" | "unsupported"
    /** The method that made it unsupported, for the message shown to the user. */
    encryptionMethod?: string
}

/**
 * Segments in play order, with whatever is needed to turn them into a file.
 *
 * `#EXT-X-KEY` and `#EXT-X-MAP` are *stateful* — they apply to every segment
 * after them until superseded — so this cannot be a filter over lines. A
 * mid-playlist key rotation is normal and dropping it produces a file that is
 * half video and half noise.
 */
export function readMediaPlaylist(text: string): MediaPlaylist {
    const segments: Segment[] = []
    let initUrl: string | undefined
    let key: KeyInfo | undefined
    let duration = 0
    let index = readSequenceStart(text)
    let unsupported: string | undefined

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (line === "") continue

        if (!line.startsWith("#")) {
            segments.push({
                url: line,
                durationSec: duration,
                index: index++,
                ...(key && key.method !== "NONE" ? { key } : {})
            })
            duration = 0
            continue
        }

        if (line.startsWith("#EXTINF")) {
            duration = Number.parseFloat(line.slice(line.indexOf(":") + 1)) || 0
        } else if (line.startsWith("#EXT-X-MAP")) {
            initUrl = parseAttributes(line).URI ?? initUrl
        } else if (line.startsWith("#EXT-X-KEY")) {
            const attributes = parseAttributes(line)
            const method = attributes.METHOD ?? "NONE"
            key = {
                method,
                ...(attributes.URI ? { uri: attributes.URI } : {}),
                ...(attributes.IV ? { iv: attributes.IV } : {})
            }
            if (method !== "NONE" && method !== "AES-128") unsupported = method
        }
    }

    const encrypted = segments.some(segment => segment.key)

    return {
        segments,
        ...(initUrl ? { initUrl } : {}),
        totalDurationSec: segments.reduce((total, segment) => total + segment.durationSec, 0),
        encryption: unsupported ? "unsupported" : encrypted ? "aes-128" : "none",
        ...(unsupported ? { encryptionMethod: unsupported } : {})
    }
}

/**
 * The container the segments are in.
 *
 * Nothing here remuxes — that needs ffmpeg, and shipping it would be several
 * times the size of the whole extension. Concatenated segments *are* a valid
 * file, just not always an MP4: transport-stream segments make a .ts, which
 * every desktop player opens and most browsers do not. Naming the file after
 * what it actually contains is the honest option; calling it .mp4 would produce
 * something that fails to open with no explanation.
 */
export function containerFor(playlist: MediaPlaylist): "mp4" | "ts" {
    if (playlist.initUrl) return "mp4"
    const first = playlist.segments[0]?.url ?? ""
    return /\.(m4s|mp4|m4v)(\?|$)/i.test(first) ? "mp4" : "ts"
}

/** The start of `#EXT-X-MEDIA-SEQUENCE`, which is the first segment's IV. */
function readSequenceStart(text: string): number {
    const stated = /#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/.exec(text)?.[1]
    return stated ? Number.parseInt(stated, 10) : 0
}

/**
 * `KEY=value` / `KEY="value"` pairs off a tag line.
 *
 * Commas inside quotes do not separate attributes — CODECS="avc1.4d401f,
 * mp4a.40.2" is one value — so this walks the string rather than splitting it.
 */
function parseAttributes(line: string): Record<string, string> {
    const attributes: Record<string, string> = {}
    const body = line.slice(line.indexOf(":") + 1)

    let key = ""
    let value = ""
    let inKey = true
    let quoted = false

    const commit = () => {
        if (key.trim() !== "") attributes[key.trim()] = value.trim()
        key = ""
        value = ""
        inKey = true
    }

    for (const character of body) {
        if (inKey) {
            if (character === "=") inKey = false
            else key += character
            continue
        }
        if (character === '"') {
            quoted = !quoted
            continue
        }
        if (character === "," && !quoted) {
            commit()
            continue
        }
        value += character
    }
    commit()

    return attributes
}
