import { on } from "../router"
import { getAnime } from "~/model/db"
import { ensureRefererRule } from "../dnr"
import { fetchSkipTimes } from "~/trackers/aniskip"
import { fetchCtxFor } from "~/library/library"
import { orderServers } from "~/library/servers"
import { sourceById, sourceForUrl } from "~/sources/registry"
import { extractorFor } from "~/extractors/registry"
import type { ExtractCtx, Stream } from "~/extractors/types"
import type { Server } from "~/sources/types"
import { resolve } from "~/settings/resolver"
import { log } from "~/shared/logger"
import { bufferToBase64 } from "~/shared/binary"
import { ExpectedError } from "~/shared/errors"

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

        const resolved = server.embedUrl ?? (await source.resolveServer?.(server as Server, ctx))
        if (!resolved) throw new Error(`could not resolve server "${server.name}" to an embed URL`)

        // A source may answer with just a URL or with extra detail. Sites that
        // hand over their own intro/outro offsets are giving better data than any
        // third party — they measured it against this exact encode.
        const embedUrl = typeof resolved === "string" ? resolved : resolved.embedUrl
        const siteSkips = typeof resolved === "string" ? undefined : resolved.skips

        const host = new URL(embedUrl).hostname
        const extractor = extractorFor(embedUrl)

        /**
         * No extractor is not a failure any more. Hand back an `iframe` stream so
         * the host's own player can run inside our chrome — the viewer keeps
         * episode navigation, the server picker and tracking, and only loses
         * in-video progress. The player prefers a real stream and only settles
         * for this once every server has been tried.
         */
        if (!extractor) {
            logger.info(`${server.name}: no extractor for ${host}, offering the embed itself`)
            return {
                embedUrl,
                extractorId: null,
                streams: [{ url: embedUrl, kind: "iframe" as const, label: host.replace(/^(www|geo)\./, "") }]
            }
        }

        const extractCtx: ExtractCtx = {
            referer: episodeUrl,
            text: (url, init) => ctx.text(url, { headers: init?.headers ?? {} }),
            json: (url, init) => ctx.json(url, { headers: init?.headers ?? {} })
        }

        try {
            const streams = await extractor.extract(embedUrl, extractCtx)
            // The site's own offsets win over anything the host guessed.
            const withSkips = siteSkips
                ? streams.map(stream => ({ ...stream, skips: { ...stream.skips, ...siteSkips } }))
                : streams

            /*
             * A stream may name a Referer its CDN insists on. Neither the proxy
             * nor the page can set that header, so it becomes a DNR rule scoped
             * to the host this particular file came from.
             *
             * Subtitle tracks get the same treatment and often need it more:
             * MegaPlay serves video and captions from two unrelated hosts that
             * both refuse a request without the embed's Referer.
             */
            for (const stream of withSkips) {
                const referer = stream.headers?.Referer ?? stream.headers?.referer
                if (!referer) continue
                for (const target of [stream.url, ...(stream.subtitles ?? []).map(track => track.url)]) {
                    await ensureRefererRule(target, referer)
                }
            }

            logger.info(`${server.name} → ${extractor.id} → ${streams.length} stream(s)`)
            return { embedUrl, extractorId: extractor.id, streams: withSkips }
        } catch (error) {
            // An extractor that knows the host but couldn't read it — a deleted
            // file, a changed player — still leaves the embed itself playable.
            const detail = error instanceof Error ? error.message : String(error)
            logger.info(`${server.name}: ${extractor.id} failed (${detail}), offering the embed itself`)
            return {
                embedUrl,
                extractorId: null,
                streams: [{ url: embedUrl, kind: "iframe" as const, label: host.replace(/^(www|geo)\./, "") }]
            }
        }
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
