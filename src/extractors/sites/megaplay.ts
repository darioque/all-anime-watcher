import type { ExtractCtx, Extractor, Stream, Track } from "~/extractors/types"
import { log } from "~/shared/logger"
import { fromBase64Url, toBase64Url } from "~/shared/binary"

const logger = log("extractor:megaplay")

/**
 * MegaPlay — the host behind Anikoto and the rest of the AnimeKai/HiAnime family.
 *
 * Two requests and no obfuscation at all:
 *
 *   /stream/s-2/<realId>/sub    → <div id="megaplay-player" data-id="114042">
 *   /stream/getSourcesNew?id=…  → { sources: { file }, tracks, intro, outro }
 *
 * The id in the embed URL is *not* the id the sources endpoint wants — that one
 * is only in the page — which is the whole reason this needs a page fetch rather
 * than being derivable from the URL.
 *
 * **Both endpoints now answer with `enc` instead of `sources`** (since
 * 2026-09-15; `getSourcesNew` briefly returned the file in plain text after the
 * 2026-09-09 migration, and that window has closed). `enc` is AES-256-CBC over
 * `{"file": "…"}`, base64url, under a key and IV that sit in plain text in the
 * host's own `newclient.min.js` — the same pair it uses to decrypt `/segment/`
 * tokens. The key is 16 characters zero-padded to 32 bytes, which is what makes
 * it AES-256 rather than AES-128; get that wrong and the decrypt fails with a
 * padding error that looks like a rotated key.
 *
 * The file URL is not enough on its own either. The default CDN 403s the master
 * playlist unless it carries `?token=`, minted client-side in `e1-player.min.js`:
 * `base64url("<expiry>|<id1>/<id2>") + "." + base64url(HMAC-SHA256(same))`, where
 * the two ids are the 32-hex path segments and the key is another literal in
 * that bundle. The site signs for 90 seconds; the server only checks that the
 * expiry is in the future (a day and a month both pass), so this signs for an
 * hour — long enough to outlive the warm cache and an in-place recovery, short
 * enough that a stored URL is not a permanent one. Variants and segments are not
 * signed. The other two CDNs accept the token and do not need it; it is added
 * everywhere the URL shape fits, exactly as the site's client does.
 *
 * Then the segments. One of the three CDNs (`?s=tcdn`, "HD-1" on anikoto)
 * hides them on TikTok's image CDN with a 252-byte PNG header glued to the
 * front of each; the client strips it in an XHR hook. The player does the
 * equivalent — see `unwrapSegment` — so nothing here needs to know which CDN
 * a stream came from. The other two serve plain MPEG-TS under `.jpg`/`.png`
 * names, which hls.js does not care about.
 *
 * The `?s=` on the embed URL is the CDN choice and **must be forwarded** to the
 * sources request. The page does that with an inline XHR hook; an extractor that
 * drops it gets the default CDN for every server, so three servers were one.
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

        const cdn = new URL(embedUrl).searchParams.get("s")
        const payload = await sources(origin, fileId, cdn, embedUrl, ctx)
        const file = await signedUrl(payload.sources.file)

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

/** A payload that actually carries a file — what `sources` promises its caller. */
type Played = SourcesResponse & { sources: { file: string } }

const played = (payload: SourcesResponse): payload is Played => Boolean(payload.sources?.file)

/**
 * Ask for the sources, new endpoint first, and say which way it failed.
 *
 * A 404 on either name is expected rather than exceptional — the two endpoints
 * are a migration in progress across a white-labelled engine, and a host serves
 * one or the other — so a throw here moves on to the next name instead of ending
 * the extraction.
 *
 * Either name may answer with the file in plain text (`sources.file`, the
 * pre-2026-09 shape, and possibly a host that has not moved) or encrypted
 * (`enc`). Both are usable; a plain file is taken as-is and `enc` is decrypted.
 * What must not be swallowed is a 200 with neither, which is a file that really
 * has nothing behind it and gets its own sentence.
 */
async function sources(
    origin: string,
    fileId: string,
    cdn: string | null,
    embedUrl: string,
    ctx: ExtractCtx
): Promise<Played> {
    const headers = { Referer: embedUrl, "X-Requested-With": "XMLHttpRequest" }
    const query = `id=${fileId}${cdn ? `&s=${encodeURIComponent(cdn)}` : ""}`
    let reached = false

    for (const endpoint of ["getSourcesNew", "getSources"]) {
        let payload: SourcesResponse
        try {
            payload = await ctx.json<SourcesResponse>(`${origin}/stream/${endpoint}?${query}`, { headers })
        } catch {
            continue
        }

        reached = true
        if (endpoint === "getSources") logger.debug(`${origin} still serves the pre-migration endpoint`)
        if (played(payload)) return payload
        if (payload.enc) {
            const { file } = await decryptSources(payload.enc)
            return { ...payload, sources: { ...payload.sources, file } }
        }
    }

    throw new Error(
        reached
            ? `megaplay returned no source for file ${fileId}`
            : `megaplay served neither sources endpoint for file ${fileId}`
    )
}

/*
 * The host's own constants, lifted from its bundles. `newclient.min.js` names the
 * AES pair (as `TRUST_AES_KEY` / `TRUST_AES_IV`, reused for the sources
 * payload); `e1-player.min.js` holds the HMAC key. The page can override any of
 * them through `window.MegaPlayClientConfig`, which it does not set today —
 * if the decrypt starts failing, that config and these bundles are where to
 * look first.
 */
const SOURCES_AES_KEY = "i?LMTAx0Q6,:}50U"
const SOURCES_AES_IV = "W0;27ToaUpl_P%'c"
const CDN_TOKEN_HMAC_KEY = "MpCdnT0k3n!9f2K#xQ7vL5mR8wN1pY4s"
/** The site signs for 90 s; the server checks only that the expiry is ahead. */
const CDN_TOKEN_TTL_SEC = 60 * 60

/** A string as key material of exactly `length` bytes: truncated, or zero-padded. */
function keyBytes(text: string, length: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(length)
    bytes.set(new TextEncoder().encode(text).subarray(0, length))
    return bytes
}

/** The `enc` blob → `{ file }`. Throws on a wrong key, a truncated blob, or a body that is not JSON. */
export async function decryptSources(enc: string): Promise<{ file: string }> {
    const key = await crypto.subtle.importKey("raw", keyBytes(SOURCES_AES_KEY, 32), "AES-CBC", false, ["decrypt"])
    let plain: ArrayBuffer
    try {
        plain = await crypto.subtle.decrypt(
            { name: "AES-CBC", iv: keyBytes(SOURCES_AES_IV, 16) },
            key,
            fromBase64Url(enc)
        )
    } catch {
        throw new Error("megaplay: the sources payload did not decrypt — the host has rotated its key")
    }

    const parsed = JSON.parse(new TextDecoder().decode(plain)) as { file?: unknown }
    if (typeof parsed.file !== "string" || !parsed.file) {
        throw new Error("megaplay: the sources payload decrypted to something without a file")
    }
    return { file: parsed.file }
}

/** The two 32-hex path segments the CDN token is bound to, or null for a URL not shaped that way. */
export function tokenPath(url: string): string | null {
    const match = /\/([a-f0-9]{32})\/([a-f0-9]{32})\//i.exec(url)
    return match ? `${match[1]}/${match[2]}`.toLowerCase() : null
}

/** The CDN token for a path, expiring `ttlSec` after `nowMs`. Pinned by the check suite against one the site minted. */
export async function cdnToken(path: string, nowMs = Date.now(), ttlSec = CDN_TOKEN_TTL_SEC): Promise<string> {
    const message = new TextEncoder().encode(`${Math.floor(nowMs / 1000) + ttlSec}|${path}`)
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(CDN_TOKEN_HMAC_KEY),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    )
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message))
    return `${toBase64Url(message)}.${toBase64Url(signature)}`
}

/**
 * The file URL with its CDN token attached — or unchanged, when the URL is not
 * shaped for one or already carries one. Mirrors the site's client exactly: it
 * too skips a URL without the two-id path rather than refusing to play it.
 */
export async function signedUrl(url: string, nowMs = Date.now()): Promise<string> {
    if (/[?&]token=/.test(url)) return url
    const path = tokenPath(url)
    if (!path) return url
    const separator = url.includes("?") ? "&" : "?"
    return `${url}${separator}token=${encodeURIComponent(await cdnToken(path, nowMs))}`
}

export interface SourcesResponse {
    sources?: { file?: string }
    /** `{ file }`, AES-256-CBC, base64url. What both endpoints answer with now. */
    enc?: string
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
