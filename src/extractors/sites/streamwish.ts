import type { ExtractCtx, Extractor, Stream, Track } from "~/extractors/types"
import { unpackAll } from "~/extractors/unpack"
import { hostOf } from "~/shared/url"
import { log } from "~/shared/logger"

const logger = log("extractor:streamwish")

/**
 * The StreamWish / VidHide family — one player, many brands.
 *
 * StreamWish, embedwish, FileLions, VidHide, and a rotating cast of white-label
 * domains all ship the same page: a `p,a,c,k,e,d` block holding a `links` object
 * whose `hls2` entry is a master playlist. One extractor covers all of them,
 * which is the whole argument for keying extractors by host rather than by site
 * — this single class serves lmanime's `morencius` and mundodonghua's `Vh`.
 *
 * The CDN sets `Access-Control-Allow-Origin: *` and needs no Referer, so hls.js
 * fetches it straight from the page. No proxy, no header rules.
 *
 * **The `t=` token is short-lived.** A URL that worked minutes ago returns 403,
 * which looks exactly like a header problem and is not one — resolve the embed
 * immediately before playing and never persist the result.
 */
export class StreamWishExtractor implements Extractor {
    readonly id = "streamwish"

    /**
     * These domains rotate constantly, so this list will go stale. Adding one is
     * a one-line change; the alternative — matching on URL shape — would swallow
     * unrelated hosts and fail confusingly. `bysekoze.com` was listed here on
     * exactly that mistake: it serves `/e/<id>` like this family does and is not
     * this family at all, so every episode on it fell back to an iframe while
     * this extractor reported "no playlist in the player". It has its own now.
     */
    private static readonly KNOWN = [
        "streamwish.com",
        "streamwish.to",
        "embedwish.com",
        "awish.pro",
        "dwish.pro",
        "swdyu.com",
        "wishfast.top",
        "filelions.to",
        "filelions.com",
        "filelions.online",
        "filelions.site",
        "vidhidepro.com",
        "vidhide.com",
        "vidhidevip.com",
        "vidhidepre.com",
        "morencius.com",
        "luluvdo.com"
    ]

    /**
     * Hosts that bind a signed URL to the `Accept-Language` that minted it.
     *
     * luluvdo's CDN issues a token against the mint request's `Accept-Language`
     * and answers **403** to any spend carrying a different value — or none.
     * Measured, 3/3 per cell and perfectly deterministic once mint and spend are
     * controlled: en→en 200, en→es 403, en→absent 403, absent→absent 200,
     * absent→en 403. `Accept` itself is irrelevant — an HTML Accept and a plain
     * wildcard both return 200 — and it is not
     * Referer, Origin or Sec-Fetch — a Node-minted token fails from a browser
     * page even on luluvdo's own origin.
     *
     * We mint through `createFetchCtx`, which sends `BASE_HEADERS`. The page
     * cannot be made to match it — hls.js there sends Chrome's own locale and
     * `Accept-Language` is not something we can rewrite per-request from the
     * page — so these streams go through the proxy, which now sends the same
     * `BASE_HEADERS`. That is the whole fix: mint and spend must look alike.
     */
    private static readonly BOUND_TO_MINT_LANGUAGE = ["luluvdo.com"]

    private boundToMintLanguage(url: string): boolean {
        const host = hostOf(url)
        return StreamWishExtractor.BOUND_TO_MINT_LANGUAGE.some(known => host === known || host.endsWith(`.${known}`))
    }

    readonly hosts = (url: string): boolean => {
        const host = hostOf(url)
        return StreamWishExtractor.KNOWN.some(known => host === known || host.endsWith(`.${known}`))
    }

    async extract(embedUrl: string, ctx: ExtractCtx): Promise<Stream[]> {
        const html = await ctx.text(embedUrl, { headers: { Referer: ctx.referer } })
        const recovered = [html, ...unpackAll(html)].join("\n")

        const master = this.masterPlaylist(recovered)
        if (!master) {
            // A deleted or region-blocked file still returns a player shell.
            const reason = /not found|deleted|removed/i.test(html) ? "the file is gone" : "no playlist in the player"
            throw new Error(`${hostOf(embedUrl)}: ${reason}`)
        }

        logger.debug(`${hostOf(embedUrl)} → ${hostOf(master)}`)

        return [
            {
                url: master,
                kind: "hls",
                label: "StreamWish",
                // ACAO is *, so for most of the family the page can fetch this
                // itself. Hosts that bind the token to its minter cannot: those
                // go through the proxy, which is where the token was minted.
                fetchVia: this.boundToMintLanguage(embedUrl) ? "background" : "page",
                subtitles: this.subtitles(recovered)
            }
        ]
    }

    /**
     * The `links` object carries several entries — `hls2` is the m3u8, `hls3` is
     * a `.txt` redirector. Take a real playlist rather than the first link.
     */
    private masterPlaylist(source: string): string | null {
        const playlists = [...source.matchAll(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/g)].map(m => m[0])
        if (playlists.length === 0) return null
        return playlists.find(url => url.includes("master")) ?? playlists[0] ?? null
    }

    /** `tracks:[{file,label,kind:"captions"}]` in the player config, when present. */
    private subtitles(source: string): Track[] | undefined {
        const tracks: Track[] = []
        for (const match of source.matchAll(
            /\{\s*file\s*:\s*["']([^"']+)["']\s*,\s*label\s*:\s*["']([^"']*)["']\s*,\s*kind\s*:\s*["']captions["']/gi
        )) {
            const url = match[1]
            if (!url) continue

            /*
             * Skip the host's own "upload captions" stub. luluvdo ships
             * `{file:"/srt/empty.srt", label:"Upload captions"}` on every embed:
             * a relative path the player cannot fetch, pointing at an empty file,
             * which would otherwise show up as a real subtitle track that
             * silently renders nothing. Every genuine track here is absolute.
             */
            if (!/^https?:\/\//i.test(url)) continue
            if (/\bempty\.(srt|vtt)$/i.test(url)) continue

            tracks.push({
                url,
                label: match[2] || "Subtitles",
                format: url.endsWith(".vtt") ? "vtt" : url.endsWith(".srt") ? "srt" : "unknown"
            })
        }
        return tracks.length > 0 ? tracks : undefined
    }
}
