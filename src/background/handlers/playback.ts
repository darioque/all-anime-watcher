import { on } from "../router"
import { getAnime } from "~/model/db"
import { fetchCtxFor } from "~/library/library"
import { orderServers } from "~/library/servers"
import { sourceById, sourceForUrl } from "~/sources/registry"
import { extractorFor } from "~/extractors/registry"
import type { ExtractCtx, Stream } from "~/extractors/types"
import type { Server } from "~/sources/types"
import { resolve } from "~/settings/resolver"
import { log } from "~/shared/logger"

const logger = log("handler:playback")

const PROXY_TIMEOUT_MS = 30_000

export function registerPlaybackHandlers() {
    /**
     * Turn one server into playable streams. Deferred until the user picks a
     * server, because a page can list ten and only one gets watched.
     */
    on("playback:streams", async ({ sourceId, server, episodeUrl }) => {
        const source = sourceById(sourceId)
        if (!source) throw new Error(`unknown source "${sourceId}"`)

        const ctx = await fetchCtxFor(source)

        const embedUrl = server.embedUrl ?? (await source.resolveServer?.(server as Server, ctx))
        if (!embedUrl) throw new Error(`could not resolve server "${server.name}" to an embed URL`)

        const extractor = extractorFor(embedUrl)
        if (!extractor) {
            throw new Error(`no extractor knows how to play ${new URL(embedUrl).hostname}`)
        }

        const extractCtx: ExtractCtx = {
            referer: episodeUrl,
            text: (url, init) => ctx.text(url, { headers: init?.headers ?? {} }),
            json: (url, init) => ctx.json(url, { headers: init?.headers ?? {} })
        }

        const streams = await extractor.extract(embedUrl, extractCtx)
        logger.info(`${server.name} → ${extractor.id} → ${streams.length} stream(s)`)
        return { embedUrl, extractorId: extractor.id, streams }
    })

    /**
     * Order the page's servers by preference so the player can try them in turn
     * without the content script needing to know about the settings chain.
     */
    on("playback:orderServers", async ({ sourceId, animeKey, servers }) => {
        const anime = animeKey ? ((await getAnime(animeKey)) ?? null) : null
        const preferred = resolve("preferredServers", { anime, sourceId })
        const variant = resolve("variantPref", { anime, sourceId })

        return orderServers(servers, preferred, variant)
    })

    /**
     * The playback proxy.
     *
     * Video CDNs routinely send no `access-control-allow-origin` usable by a
     * third-party page, and require a Referer the page cannot forge — Dailymotion
     * does both. A background fetch has host permissions, so it is exempt from
     * CORS, and background/dnr.ts supplies the Referer. Every manifest and
     * segment for such a stream comes through here.
     */
    on("playback:fetch", async ({ url, rangeStart, rangeEnd, responseType, headers }) => {
        const requestHeaders: Record<string, string> = { ...headers }
        if (rangeStart !== undefined) {
            requestHeaders["Range"] = `bytes=${rangeStart}-${rangeEnd !== undefined ? rangeEnd - 1 : ""}`
        }

        const response = await fetch(url, {
            headers: requestHeaders,
            credentials: "include",
            redirect: "follow",
            signal: AbortSignal.timeout(PROXY_TIMEOUT_MS)
        })

        if (!response.ok && response.status !== 206) {
            return { status: response.status, error: `HTTP ${response.status}` }
        }

        if (responseType === "text") {
            return { status: response.status, text: await response.text(), url: response.url }
        }
        return { status: response.status, buffer: await response.arrayBuffer(), url: response.url }
    })

    /** Which source, if any, owns an arbitrary URL. Used by the player for embeds. */
    on("playback:sourceForUrl", async ({ url }) => sourceForUrl(url)?.id ?? null)
}

export type { Stream }
