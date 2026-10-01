import type { ExtractCtx, Extractor, Stream } from "~/extractors/types"
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
 * **The file wants `Referer: https://odysee.com/`** — 403 without it, 206 with it,
 * whoever minted the URL. Nothing else is bound: a URL minted from the CLI plays
 * in a browser and vice versa. It is a plain MP4, and a `<video src>` is not
 * subject to CORS, so the page fetches it and a DNR rule supplies the Referer.
 *
 * A burst of requests earns `429 Try again later` from the CDN (`x-powered-by:
 * use-p2`). That is a rate limit, not a header problem — it looked like one for a
 * while, and went away on its own.
 */
export class OdyseeExtractor implements Extractor {
    readonly id = "odysee"
    readonly hosts = ["odysee.com"]

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

        const hls = /\.m3u8(\?|$)/i.test(url) || response.result?.mime_type === "application/x-mpegURL"
        logger.debug(`${uri} → ${new URL(url).hostname}`)
        return [
            {
                url,
                kind: hls ? "hls" : "mp4",
                label: "Odysee",
                headers: { Referer: REFERER },
                fetchVia: "page"
            }
        ]
    }
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
