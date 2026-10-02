import type { ExtractCtx, Extractor, ExtractorNetRule, Stream } from "~/extractors/types"
import { log } from "~/shared/logger"

const logger = log("extractor:dtube")

/** The player tries one first by visitor country and falls back to the other. */
const NODES = ["https://nas1.d.tube", "https://nas2.d.tube"]
const REFERER = "https://play.d.tube/"

/**
 * D.Tube's player, `play.d.tube/?v=<id>`.
 *
 * Verified 2026-10-01 from animexin.dev and animekhor.org:
 *
 *   id       a UUID, or the same 128 bits in base58     (`3mMLsLreUfvTGzAzSdQkQA`)
 *   master   https://nas{1,2}.d.tube/videos/<uuid>/master.m3u8
 *
 * Read off the player bundle and checked against both sites' embeds. A file
 * lives on one node only (404 on the other), so both are tried in the player's
 * own order. The playlists and MPEG-TS segments send
 * `access-control-allow-origin: *`, and the nodes are **hotlink-protected**:
 * no Referer or `play.d.tube` gets 200, any other site gets 403. The page we
 * take over sends the anime site's, so the player's own is declared as a rule
 * for all of `d.tube`, covering the page's hls.js and our proxy alike.
 *
 * The player also offers `/transcripts/<uuid>.vtt`, a machine transcript. These
 * episodes are hardsubbed, so it is not offered as a subtitle track.
 */
export class DTubeExtractor implements Extractor {
    readonly id = "dtube"
    readonly hosts = ["play.d.tube"]

    readonly netRules: ExtractorNetRule[] = [
        {
            urlFilter: "||d.tube",
            referer: REFERER,
            appliesTo: "both",
            resourceTypes: ["xmlhttprequest", "media", "other"]
        }
    ]

    async extract(embedUrl: string, ctx: ExtractCtx): Promise<Stream[]> {
        const url = new URL(embedUrl)
        const raw =
            url.searchParams.get("v") ??
            url.pathname
                .split("/")
                .filter(part => part && part !== "embed")
                .pop()
        const id = raw ? videoUuid(raw) : null
        if (!id) throw new Error(`no D.Tube video id in ${embedUrl}`)

        for (const node of NODES) {
            const master = `${node}/videos/${id}/master.m3u8`
            try {
                const text = await ctx.text(master, { headers: { Referer: REFERER } })
                if (!text.trimStart().startsWith("#EXTM3U")) continue
                logger.debug(`${raw} → ${new URL(node).hostname}`)
                return [{ url: master, kind: "hls", label: "D.Tube", headers: { Referer: REFERER } }]
            } catch {
                // Not on this node; the other one has it.
            }
        }
        throw new Error("dtube: the video is on neither node — it may have been removed")
    }
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

/** A UUID as given, or the UUID a base58 id encodes; null for anything else. */
export function videoUuid(id: string): string | null {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id.toLowerCase()
    if (id === "" || [...id].some(char => !BASE58.includes(char))) return null

    let value = 0n
    for (const char of id) value = value * 58n + BigInt(BASE58.indexOf(char))
    const hex = value.toString(16).padStart(32, "0")
    if (hex.length > 32) return null
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
