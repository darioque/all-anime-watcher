import { on } from "../router"
import { BASE_HEADERS } from "~/net/fetcher"
import { getAnime } from "~/model/db"
import { fetchSkipTimes } from "~/trackers/aniskip"
import { orderServers } from "~/library/servers"
import { sourceForUrl } from "~/sources/registry"
import type { Stream } from "~/extractors/types"
import type { Server } from "~/sources/types"
import { resolve } from "~/settings/resolver"
import { resolveServerStreams } from "../streams"
import { episodeSourceFor, identifyEpisode } from "../identify"
import { fetchCtxFor } from "~/library/library"
import { sourceById } from "~/sources/registry"
import { swapOrigin } from "~/shared/url"
import type { PageIdentity } from "~/shared/messages"
import { log } from "~/shared/logger"
import { bufferToBase64 } from "~/shared/binary"

const logger = log("handler:playback")

const PROXY_TIMEOUT_MS = 30_000

/**
 * A parsed episode page stays useful much longer than an extracted stream does:
 * the markup does not expire, only the signed URLs inside it. Ten minutes keeps
 * a look-ahead alive across a long episode without holding a stale server list
 * from an earlier session.
 */
const PREPARE_TTL_MS = 10 * 60 * 1000
const prepared = new Map<string, { at: number; identity: PageIdentity }>()

/**
 * Resolve the server the player would pick, so arriving costs only the attach.
 *
 * Fire-and-forget on purpose: a warm-up that fails has cost nothing, and making
 * the caller wait for it would turn an optimisation into a delay.
 */
async function warmFirstServer(sourceId: string, episodeUrl: string, identity: PageIdentity): Promise<void> {
    const server = identity.servers?.[0]
    if (!server) return
    try {
        await resolveServerStreams({ sourceId, server, episodeUrl })
        logger.debug(`warmed ${server.name} for ${episodeUrl}`)
    } catch (error) {
        logger.debug(`could not warm ${server.name}`, error)
    }
}

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
        // `allowCached`: the prefetcher may already have resolved this exact
        // server for this exact episode moments ago.
        resolveServerStreams({ sourceId, server: server as Server, episodeUrl, allowCached: true })
    )

    /**
     * Read the next episode's page ahead of time.
     *
     * The expensive part of moving to the next episode was never the video — it
     * was loading a whole site page, running its scripts, and only then having
     * something to parse. Fetching and parsing it here while the current episode
     * is still playing lets the player swap in place, with no navigation at all.
     *
     * Deliberately not a tracking signal: looking ahead at episode 48 must not
     * mark it watched.
     */
    on("playback:prepare", async ({ sourceId, episodeUrl, warm }) => {
        const cached = prepared.get(episodeUrl)
        if (cached && Date.now() - cached.at < PREPARE_TTL_MS) {
            if (warm) void warmFirstServer(sourceId, episodeUrl, cached.identity)
            return cached.identity
        }

        const source = episodeSourceFor(episodeUrl) ?? sourceById(sourceId)
        if (!source) throw new Error(`unknown source "${sourceId}"`)

        const ctx = await fetchCtxFor(source)
        const url = swapOrigin(episodeUrl, ctx.baseUrl)
        const html = await ctx.text(url)

        const identity = await identifyEpisode({ source, url, html, track: false })
        prepared.set(episodeUrl, { at: Date.now(), identity })
        if (prepared.size > 8) prepared.delete([...prepared.keys()][0]!)

        logger.info(
            `prepared ${url} — ${identity.isEpisode ? `${identity.servers?.length ?? 0} server(s)` : "not an episode"}`
        )
        if (warm) void warmFirstServer(sourceId, url, identity)
        return identity
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
        /*
         * The proxy must look like the fetcher that minted the URL. Some CDNs
         * bind a signed token to the mint request's `Accept-Language` — luluvdo
         * 403s any spend with a different value or none — and the extractor
         * minted through `createFetchCtx`, which sends BASE_HEADERS. A bare
         * fetch here sends Chrome's own locale instead, which is a different
         * client as far as the CDN is concerned. The caller still wins on any
         * header it sets explicitly.
         */
        const requestHeaders: Record<string, string> = { ...BASE_HEADERS, ...headers }
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
