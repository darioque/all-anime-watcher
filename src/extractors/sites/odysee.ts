import type { ExtractCtx, Extractor, ExtractorNetRule, Stream } from "~/extractors/types"
import { log } from "~/shared/logger"

const logger = log("extractor:odysee")

const API = "https://api.na-backend.odysee.com/api/v1/proxy?m=get"
const REFERER = "https://odysee.com/"

/**
 * Odysee (LBRY). The embed names a claim; one JSON-RPC call turns it into a file.
 *
 * Verified 2026-10-01 against donghualife.com's embeds, measured in a browser and
 * from the CLI with the mint and the spend swapped both ways:
 *
 *   embed     odysee.com/$/embed/@dlife:3/Ws-288:1?signature=…&signature_ts=…
 *   claim     lbry://@dlife#3/Ws-288#1           `:` in a path is `#` in a URI
 *   get       POST /api/v1/proxy?m=get           → result.streaming_url
 *   file      secure.odycdn.com/<hash>,<exp>/v6/streams/…mp4
 *
 * **Unlisted claims need the embed's own signature.** Without `signature` and
 * `signature_ts` the API answers "missing required signature param", and the
 * `player.odycdn.com/…/free/…` URL the embed page also prints answers 401. The
 * signature is passed through as the embed carries it; a public claim has none
 * and needs none.
 *
 * **Everything on the CDN wants `Referer: https://odysee.com/`** — 403 without
 * it, whoever minted the URL. Nothing else is bound: a URL minted from the CLI
 * plays in a browser and vice versa. Declared as a DNR rule for all of
 * `odycdn.com`, because the extractor's own playlist fetch runs in the worker,
 * which cannot set the header, and the page's `<video>` and hls.js need it too.
 *
 * **`streaming_url` names an MP4 the CDN may refuse to serve.** Once Odysee has
 * transcoded a claim, its player's `HEAD` on that `.mp4` is answered with a 308
 * to `…/master.m3u8`, and a `GET` with `429 Try again later` (`x-powered-by:
 * use-p2`) — every time, for as long as you care to retry. That read as a rate
 * limit until the player was watched doing the HEAD. Before transcoding is
 * done it is the other way round: the MP4 plays and `master.m3u8` is a 404,
 * "transcoding is in progress". Both measured 2026-10-01, on animexin's and
 * donghualife's claims respectively. So the playlist is tried first and the
 * file is the fallback.
 */
export class OdyseeExtractor implements Extractor {
    readonly id = "odysee"
    readonly hosts = ["odysee.com"]

    readonly netRules: ExtractorNetRule[] = [
        {
            urlFilter: "||odycdn.com",
            referer: REFERER,
            appliesTo: "both",
            resourceTypes: ["media", "xmlhttprequest", "other"]
        }
    ]

    async extract(embedUrl: string, ctx: ExtractCtx): Promise<Stream[]> {
        const uri = claimUri(embedUrl)
        if (!uri) throw new Error(`could not read an Odysee claim from ${embedUrl}`)

        const query = new URL(embedUrl).searchParams
        const params: Record<string, unknown> = { uri, save_file: false }
        const signature = query.get("signature")
        const signatureTs = query.get("signature_ts")
        if (signature && signatureTs) {
            params.signature = signature
            params.signature_ts = signatureTs
        }

        const response = await ctx.json<{
            result?: { streaming_url?: string; mime_type?: string }
            error?: { message?: string }
        }>(API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "get", params })
        })

        const url = response.result?.streaming_url
        if (!url) throw new Error(response.error?.message ?? "Odysee returned no streaming URL")

        const master = await transcoded(url, ctx)
        if (master) {
            logger.debug(`${uri} → HLS on ${new URL(master).hostname}`)
            return [{ url: master, kind: "hls", label: "Odysee", headers: { Referer: REFERER } }]
        }

        logger.debug(`${uri} → MP4 on ${new URL(url).hostname}`)
        return [{ url, kind: "mp4", label: "Odysee", headers: { Referer: REFERER }, fetchVia: "page" }]
    }
}

/**
 * The HLS master beside a `streaming_url`, when the claim has been transcoded.
 *
 * The CDN keeps it at the MP4's path with `/master.m3u8` in place of `.mp4`,
 * same token. Null on anything but a playlist — a 404 there means the original
 * file is what gets served.
 */
async function transcoded(url: string, ctx: ExtractCtx): Promise<string | null> {
    const master = masterOf(url)
    if (!master) return null
    try {
        const text = await ctx.text(master, { headers: { Referer: REFERER } })
        return text.trimStart().startsWith("#EXTM3U") ? master : null
    } catch {
        return null
    }
}

export function masterOf(url: string): string | null {
    const master = url.replace(/\.mp4(?=\?|$)/i, "/master.m3u8")
    return master === url ? null : master
}

/**
 * The LBRY URI an Odysee URL names, or null.
 *
 *   /$/embed/@dlife:3/Ws-288:1       → lbry://@dlife#3/Ws-288#1
 *   /@dlife:3/Ws-288:1               → lbry://@dlife#3/Ws-288#1   (a watch page)
 *   /$/embed/Ws-288/1f4508…           → lbry://Ws-288#1f4508…       (name + claim id)
 */
export function claimUri(url: string): string | null {
    let path: string
    try {
        path = decodeURIComponent(new URL(url).pathname)
    } catch {
        return null
    }
    const claim = path.replace(/^\/\$\/embed\//, "").replace(/^\/+|\/+$/g, "")
    if (!claim || claim.startsWith("$/")) return null

    const parts = claim.split("/")
    if (parts.length === 2 && !parts[0]!.startsWith("@") && /^[0-9a-f]{40}$/.test(parts[1]!)) {
        return `lbry://${parts[0]}#${parts[1]}`
    }
    return `lbry://${claim.replace(/:/g, "#")}`
}
