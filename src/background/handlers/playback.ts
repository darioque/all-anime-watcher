import { on } from "../router"
import { getAnime } from "~/model/db"
import { fetchSkipTimes } from "~/trackers/aniskip"
import { orderServers } from "~/library/servers"
import { sourceForUrl } from "~/sources/registry"
import type { Stream } from "~/extractors/types"
import type { Server } from "~/sources/types"
import { resolve } from "~/settings/resolver"
import { resolveServerStreams } from "../streams"
import { log } from "~/shared/logger"
import { bufferToBase64 } from "~/shared/binary"

const logger = log("handler:playback")

const PROXY_TIMEOUT_MS = 30_000

export function registerPlaybackHandlers() {
    /**
     * Turn one server into playable streams. Deferred until the user picks a
     * server, because a page can list ten and only one gets watched.
     *
     * The work itself lives in `../streams`, shared with the download queue —
     * downloading an episode is the same problem as playing it right up to the
     * last step.
     */
    on("playback:streams", async ({ sourceId, server, episodeUrl }) =>
        resolveServerStreams({ sourceId, server: server as Server, episodeUrl })
    )

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

        // Base64, not the raw ArrayBuffer: Chrome JSON-serialises extension
        // messages, so a buffer would arrive as `{}`. See shared/binary.ts.
        const buffer = await response.arrayBuffer()
        return { status: response.status, base64: bufferToBase64(buffer), url: response.url }
    })

    /**
     * Skip offsets from AniSkip, for sources that don't publish their own.
     * Needs a MAL id, which arrives with an AniList link — so this quietly
     * returns nothing for an unmatched series rather than pretending.
     */
    on("playback:skipTimes", async ({ key, number, durationSec }) => {
        if (!key) return null
        const anime = await getAnime(key)
        if (!anime?.malId) return null
        return fetchSkipTimes(anime.malId, number, durationSec ?? 0)
    })

    /** Which source, if any, owns an arbitrary URL. Used by the player for embeds. */
    on("playback:sourceForUrl", async ({ url }) => sourceForUrl(url)?.id ?? null)
}

export type { Stream }
