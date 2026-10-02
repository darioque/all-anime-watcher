import type { ExtractCtx, Extractor, Stream, Track } from "~/extractors/types"
import { hostOf } from "~/shared/url"
import { log } from "~/shared/logger"

const logger = log("extractor:upns")

/**
 * The white-label player behind `*.seekplayer.vip`, `*.upns.live` and
 * `*.p2pstream.vip` — one engine, a subdomain per customer
 * (`animexinfansub.seekplayer.vip`, `animekhor.upns.live`, …).
 *
 * Verified 2026-10-01 against all three, from animexin.dev and animekhor.org:
 *
 *   embed    https://<customer>.<domain>/#<id>        a Vite app; the id is the fragment
 *   config   GET /api/v1/video?id=<id>                hex AES-128-CBC ciphertext
 *   stream   config.cfNative                          HLS master on the embed's own host
 *
 * **The key and IV are fixed ASCII strings** shipped in the player bundle. They
 * were read by hooking `crypto.subtle` in a browser while the real player
 * decrypted its config, not by deobfuscating the bundle, so if decryption ever
 * starts failing, do that again rather than reading the source.
 *
 * **Which URL to play.** The config names several:
 *
 *  - `cfNative` — a master on the embed's own host. 200 without any Referer
 *    and `access-control-allow-origin: *`. Its variants point at a rotating
 *    CDN host (`swk8.harborcrestcreativecollect.cyou`, `sv3.summitnetworklabs.site`)
 *    whose fMP4 segments — disguised as `.woff`/`.woff2` — 403 without the
 *    embed host as Referer and echo the page's Origin back when they have it.
 *    The Referer is declared on the stream, and `coverPlaylistHosts` extends it
 *    to the segment host and the `EXT-X-MAP` init segment.
 *  - `source` — the same master on a bare IP. Needs the Referer too, and a
 *    browser will not accept the certificate for an IP address.
 *  - `cf`, `hlsVideoTiktok` — a `.txt` master that 403s, and a copy staged on
 *    TikTok's CDN. Neither is needed.
 *
 * Soft subtitles, where a customer uploads them, are VTT files on the embed
 * host keyed by language code (seekplayer carries nine, Spanish among them).
 */
export class UpnsExtractor implements Extractor {
    readonly id = "upns"
    readonly hosts = (url: string) => /(^|\.)(seekplayer\.vip|upns\.live|p2pstream\.vip)$/.test(hostOf(url))

    async extract(embedUrl: string, ctx: ExtractCtx): Promise<Stream[]> {
        const url = new URL(embedUrl)
        const id = url.hash.replace(/^#/, "").split(/[&?]/)[0]
        if (!id) throw new Error(`no video id in ${embedUrl}`)

        const origin = url.origin
        const referer = `${origin}/`
        const cipher = await ctx.text(`${origin}/api/v1/video?id=${encodeURIComponent(id)}`, {
            headers: { Referer: referer }
        })
        const config = JSON.parse(await decryptConfig(cipher)) as UpnsConfig

        const master = config.cfNative ?? config.source
        if (!master) throw new Error("upns: the config names no stream")

        logger.debug(`${hostOf(embedUrl)}#${id} → ${hostOf(master)}`)
        return [
            {
                url: absolute(master, origin),
                kind: "hls",
                label: config.title?.replace(/\.mp4(\.mp4)?$/i, "") || "UPNS",
                headers: { Referer: referer },
                subtitles: subtitlesOf(config, origin)
            }
        ]
    }
}

interface UpnsConfig {
    source?: string
    cfNative?: string
    title?: string
    /** Language code → path on the embed host, with the code repeated as a fragment. */
    subtitle?: Record<string, string>
}

const KEY = "kiemtienmua911ca"
const IV = "1234567890oiuytr"

/** The config is hex ciphertext under a fixed key; WebCrypto strips the PKCS#7 padding. */
export async function decryptConfig(hex: string): Promise<string> {
    const clean = hex.trim()
    if (!/^[0-9a-f]+$/i.test(clean) || clean.length % 32 !== 0) {
        throw new Error("upns: the config is not hex ciphertext — the endpoint has probably changed")
    }
    const bytes = new Uint8Array(clean.length / 2)
    for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)

    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey("raw", encoder.encode(KEY), "AES-CBC", false, ["decrypt"])
    try {
        const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: encoder.encode(IV) }, key, bytes)
        return new TextDecoder().decode(plain)
    } catch {
        throw new Error("upns: the config would not decrypt — the key has probably changed")
    }
}

const LANGUAGES: Record<string, string> = {
    en: "English",
    es: "Español",
    pt: "Português",
    fr: "Français",
    de: "Deutsch",
    it: "Italiano",
    id: "Indonesia",
    ar: "العربية",
    tr: "Türkçe",
    th: "ไทย",
    pl: "Polski",
    vi: "Tiếng Việt"
}

function subtitlesOf(config: UpnsConfig, origin: string): Track[] {
    return Object.entries(config.subtitle ?? {}).map(([language, path]) => ({
        url: absolute(path.split("#")[0] ?? path, origin),
        label: LANGUAGES[language] ?? language,
        language,
        format: "vtt" as const
    }))
}

function absolute(value: string, origin: string): string {
    return new URL(value, `${origin}/`).toString()
}
