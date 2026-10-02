import type { ExtractCtx, Extractor, Stream, Track } from "~/extractors/types"
import { hostOf } from "~/shared/url"
import { log } from "~/shared/logger"

const logger = log("extractor:dood")

/**
 * DoodStream and its mirror domains.
 *
 * Verified 2026-10-01 on playmogo.com, from animexin.dev's "All Sub Player Dood":
 *
 *   embed     https://<mirror>/e/<id>
 *   pass      GET /pass_md5/<…>/<token>        the path is in the embed page's script
 *             → a CDN URL prefix (km270l.cloudatacdn.com, rotating)
 *   file      prefix + 10 random [A-Za-z0-9] + "?token=<token>&expiry=<ms now>"
 *
 * — exactly what the page's own `makePlay()` builds. The file wants the mirror
 * as Referer (302 elsewhere without it, 206 with it); `/pass_md5/` does not care.
 * It is a plain MP4 and `<video src>` is not subject to CORS, so the page plays
 * it and a DNR rule supplies the Referer.
 *
 * Subtitles are VTT files on `srt.doodcdn.io`, one `addRemoteTextTrack` call each
 * in the page, labelled by language name; they need no headers. The `srclang`
 * the page writes is "en" for all of them and is not used.
 *
 * Only playmogo.com has been measured. The others are this engine's well-known
 * mirrors; one that turns out to be something else fails extraction and falls
 * back to its iframe, which is where it stood before.
 */
const MIRRORS =
    /(^|\.)(playmogo\.com|doodstream\.com|dood\.(la|ws|so|pm|to|re|wf|cx|sh|li|yt|watch|stream)|ds2play\.com|ds2video\.com|d0000d\.com|d000d\.com|dooood\.com|do0od\.com|do7go\.com|dsvplay\.com|vidply\.com)$/

export class DoodExtractor implements Extractor {
    readonly id = "dood"
    readonly hosts = (url: string) => MIRRORS.test(hostOf(url))

    async extract(embedUrl: string, ctx: ExtractCtx): Promise<Stream[]> {
        // `/d/` is the download page for the same id; the player lives on `/e/`.
        const url = new URL(embedUrl.replace("/d/", "/e/"))
        const html = await ctx.text(url.toString(), { headers: { Referer: ctx.referer } })

        const pass = /['"](\/pass_md5\/[^'"]+)['"]/.exec(html)?.[1]
        const token = /[?&]token=([a-z0-9]+)/i.exec(html)?.[1]
        if (!pass || !token) throw new Error("dood: no pass_md5 call on the embed page — the file may be gone")

        const prefix = (await ctx.text(`${url.origin}${pass}`, { headers: { Referer: url.toString() } })).trim()
        if (prefix === "RELOAD" || !/^https?:\/\//.test(prefix)) {
            throw new Error(`dood: pass_md5 answered "${prefix.slice(0, 40)}" instead of a URL`)
        }

        logger.debug(`${hostOf(embedUrl)} → ${hostOf(prefix)}`)
        return [
            {
                url: fileUrl(prefix, token, Date.now()),
                kind: "mp4",
                label: "Dood",
                headers: { Referer: `${url.origin}/` },
                fetchVia: "page",
                subtitles: subtitlesOf(html)
            }
        ]
    }
}

/** What the page's `makePlay()` appends to the pass_md5 prefix. */
export function fileUrl(prefix: string, token: string, now: number, random: () => number = Math.random): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    let tail = ""
    for (let i = 0; i < 10; i++) tail += alphabet.charAt(Math.floor(random() * alphabet.length))
    return `${prefix}${tail}?token=${token}&expiry=${now}`
}

export function subtitlesOf(html: string): Track[] {
    const tracks: Track[] = []
    const rx = /addRemoteTextTrack\(\{\s*src:\s*'([^']+)'\s*,\s*label:\s*'([^']*)'/g
    for (let match = rx.exec(html); match !== null; match = rx.exec(html)) {
        const [, src, label] = match
        // The first entry is an empty `data:` placeholder the player always adds.
        if (!src || src.startsWith("data:") || !label?.trim()) continue
        tracks.push({ url: src.startsWith("//") ? `https:${src}` : src, label: label.trim(), format: "vtt" })
    }
    return tracks
}
