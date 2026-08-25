import { ensureRefererRule } from "./dnr"
import { fetchCtxFor } from "~/library/library"
import { sourceById } from "~/sources/registry"
import { extractorFor } from "~/extractors/registry"
import type { ExtractCtx, Stream } from "~/extractors/types"
import type { Server } from "~/sources/types"
import { isMasterPlaylist, playlistUrls } from "~/shared/m3u8"
import { log } from "~/shared/logger"

const logger = log("streams")

export interface ResolvedStreams {
    embedUrl: string
    extractorId: string | null
    streams: Stream[]
}

/**
 * One server → playable streams, with every header rewrite it needs installed.
 *
 * Extracted from the playback handler because downloading an episode is the same
 * problem as playing it right up to the last step, and a second copy of this
 * would drift: the Referer rules below took three attempts to get right, and
 * only one of the two copies would have received the fixes.
 */
/**
 * Recently resolved streams, so a warmed one is ready when the viewer arrives.
 *
 * Short-lived on purpose. Extracted URLs are routinely signed with a token that
 * expires, and a cache that outlives one produces a dead stream that looks like
 * a dead server. Three minutes is long enough to cover "warm it near the end of
 * an episode, use it at the start of the next" and short enough that a stale
 * entry is not something you can sit on.
 */
const CACHE_TTL_MS = 3 * 60 * 1000
const cache = new Map<string, { at: number; value: ResolvedStreams }>()

function cacheKey(sourceId: string, episodeUrl: string, server: Server): string {
    return `${sourceId}|${episodeUrl}|${server.name}|${server.embedUrl ?? ""}`
}

export async function resolveServerStreams(options: {
    sourceId: string
    server: Server
    episodeUrl: string
    /** Read from the warm cache when something is there. */
    allowCached?: boolean
}): Promise<ResolvedStreams> {
    const key = cacheKey(options.sourceId, options.episodeUrl, options.server)

    if (options.allowCached) {
        const hit = cache.get(key)
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
            logger.debug(`${options.server.name}: served from the warm cache`)
            return hit.value
        }
        cache.delete(key)
    }

    const resolved = await resolveInner(options)

    // Only a real stream is worth keeping. An `iframe` result means extraction
    // failed, and caching that would make one bad moment stick for three minutes.
    if (resolved.extractorId) {
        cache.set(key, { at: Date.now(), value: resolved })
        // Unbounded growth would be a slow leak in a worker that can live for
        // hours; the oldest entries are the ones already past their TTL.
        if (cache.size > 24) {
            const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
            if (oldest) cache.delete(oldest[0])
        }
    }

    return resolved
}

async function resolveInner(options: {
    sourceId: string
    server: Server
    episodeUrl: string
}): Promise<ResolvedStreams> {
    const source = sourceById(options.sourceId)
    if (!source) throw new Error(`unknown source "${options.sourceId}"`)

    const ctx = await fetchCtxFor(source)

    const resolved = options.server.embedUrl ?? (await source.resolveServer?.(options.server, ctx))
    if (!resolved) throw new Error(`could not resolve server "${options.server.name}" to an embed URL`)

    // A source may answer with just a URL or with extra detail. Sites that hand
    // over their own intro/outro offsets are giving better data than any third
    // party — they measured it against this exact encode.
    const embedUrl = typeof resolved === "string" ? resolved : resolved.embedUrl
    const siteSkips = typeof resolved === "string" ? undefined : resolved.skips

    const host = new URL(embedUrl).hostname
    const extractor = extractorFor(embedUrl)

    /*
     * No extractor is not a failure. Hand back an `iframe` stream so the host's
     * own player can run inside our chrome — the viewer keeps episode
     * navigation, the server picker and tracking, and only loses in-video
     * progress. Downloading is the one thing this cannot serve, and the download
     * queue says so by name rather than silently skipping it.
     */
    if (!extractor) {
        logger.info(`${options.server.name}: no extractor for ${host}, offering the embed itself`)
        return { embedUrl, extractorId: null, streams: [iframeStream(embedUrl, host)] }
    }

    const extractCtx: ExtractCtx = {
        referer: options.episodeUrl,
        text: (url, init) => ctx.text(url, { headers: init?.headers ?? {} }),
        json: (url, init) => ctx.json(url, { headers: init?.headers ?? {} })
    }

    /*
     * The embed page itself needs a Referer, and `fetch()` cannot set one — it is
     * a forbidden header, so the request arrives bare however carefully the
     * extractor spells it out. MegaPlay answers such a request with HTTP 200 and
     * an error page, which reads downstream as "the markup changed" rather than
     * "the request was rejected".
     */
    await ensureRefererRule(embedUrl, `${ctx.baseUrl}/`)

    try {
        const streams = await extractor.extract(embedUrl, extractCtx)
        const withSkips = siteSkips
            ? streams.map(stream => ({ ...stream, skips: { ...stream.skips, ...siteSkips } }))
            : streams

        await installStreamRules(withSkips)

        logger.info(`${options.server.name} → ${extractor.id} → ${streams.length} stream(s)`)
        return { embedUrl, extractorId: extractor.id, streams: withSkips }
    } catch (error) {
        // An extractor that knows the host but couldn't read it — a deleted file,
        // a changed player — still leaves the embed itself playable.
        const detail = error instanceof Error ? error.message : String(error)
        logger.info(`${options.server.name}: ${extractor.id} failed (${detail}), offering the embed itself`)
        return { embedUrl, extractorId: null, streams: [iframeStream(embedUrl, host)] }
    }
}

function iframeStream(embedUrl: string, host: string): Stream {
    return { url: embedUrl, kind: "iframe", label: host.replace(/^(www|geo)\./, "") }
}

/**
 * Install every header rewrite a set of streams asks for.
 *
 * A stream may name a Referer its CDN insists on, and neither the proxy nor the
 * page can set that header, so it becomes a DNR rule scoped to the host the file
 * actually came from. Subtitle tracks get the same treatment and often need it
 * more: MegaPlay serves video and captions from two unrelated hosts that both
 * refuse a request without the embed's Referer.
 */
export async function installStreamRules(streams: Stream[]): Promise<void> {
    for (const stream of streams) {
        const referer = refererOf(stream)
        if (!referer) continue
        for (const target of [stream.url, ...(stream.subtitles ?? []).map(track => track.url)]) {
            await ensureRefererRule(target, referer)
        }
        if (stream.kind === "hls") await coverPlaylistHosts(stream.url, referer)
    }
}

export function refererOf(stream: Stream): string | undefined {
    return stream.headers?.Referer ?? stream.headers?.referer
}

/**
 * Extend a stream's Referer rewrite to the hosts named inside its playlist.
 *
 * An HLS manifest is not one host. MegaPlay serves the manifest from
 * `cdn.watching.onl` and every segment from `cr0x1.cloudvideo.lat`, and both
 * reject a request without the embed's Referer — so a rule covering only the URL
 * the extractor handed back gets the manifest and none of the video. The symptom
 * is not an error: hls.js retries a failing segment for a long time, so it looks
 * like buffering that never ends.
 *
 * Two levels, because that is how deep HLS goes: a master playlist names variant
 * playlists, and a variant names segments. Best-effort throughout — this is
 * insurance, and failing to take it out must not stop playback that might have
 * worked anyway.
 */
export async function coverPlaylistHosts(url: string, referer: string, depth = 0): Promise<void> {
    if (depth > 1) return

    let text: string
    try {
        const response = await fetch(url, {
            credentials: "include",
            redirect: "follow",
            signal: AbortSignal.timeout(15_000)
        })
        if (!response.ok) return
        text = await response.text()
    } catch (error) {
        logger.debug(`could not read ${url} to find its other hosts`, error)
        return
    }

    const seen = new Set<string>()
    let firstChild: string | null = null

    for (const raw of playlistUrls(text)) {
        const absolute = new URL(raw, url).toString()
        if (firstChild === null) firstChild = absolute

        const host = new URL(absolute).hostname
        if (host === new URL(url).hostname || seen.has(host)) continue
        seen.add(host)
        await ensureRefererRule(absolute, referer)
    }

    if (seen.size > 0) logger.info(`${new URL(url).hostname} playlist also uses ${[...seen].join(", ")}`)

    // A master playlist's variants sit on its own host, so the segment hosts only
    // show up one level down.
    if (firstChild && isMasterPlaylist(text)) {
        await coverPlaylistHosts(firstChild, referer, depth + 1)
    }
}
