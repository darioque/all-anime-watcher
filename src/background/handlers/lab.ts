import { on } from "../router"
import { episodeSourceFor, identifyEpisode } from "../identify"
import { resolveServerStreams } from "../streams"
import { fetchCtxFor } from "~/library/library"
import { sourceById } from "~/sources/registry"
import { extractorFor, allExtractors } from "~/extractors/registry"
import type { ExtractCtx } from "~/extractors/types"
import type { Server } from "~/sources/types"
import { createFetchCtx } from "~/net/fetcher"
import { ensureTrailingSlash, swapOrigin } from "~/shared/url"
import { log } from "~/shared/logger"

const logger = log("lab")

/**
 * Run one piece of a source or extractor on demand, from inside the extension.
 *
 * `npm run probe` does most of this from a terminal and is faster to iterate
 * with, but it has one blind spot that matters: Node's fetch *can* set Referer
 * and Origin, and a browser's cannot. Every header a site demands therefore
 * appears to work under the CLI and then fails in the extension, which is
 * exactly how the MegaPlay failure hid — the probe said the extractor was fine
 * while every playback attempt returned an error page with HTTP 200.
 *
 * So this exists to answer "does it work *here*": same fetch context, same
 * declarativeNetRequest rules, same registry, same everything.
 */
export function registerLabHandlers() {
    on("lab:search", async ({ sourceId, query }) => {
        const source = required(sourceId)
        const ctx = await fetchCtxFor(source)
        return timed(async () => source.search(query, ctx))
    })

    on("lab:series", async ({ sourceId, url }) => {
        const source = required(sourceId)
        const ctx = await fetchCtxFor(source)
        const seriesUrl = swapOrigin(url, ctx.baseUrl)

        return timed(async () => {
            const info = await source.getSeries(seriesUrl, ctx)
            const episodes = await source.getEpisodes(seriesUrl, ctx)
            return {
                seriesId: source.seriesIdFromUrl(seriesUrl),
                info,
                episodeCount: episodes.length,
                // The whole list is rarely what you need and often hundreds of
                // entries; the ends are what tells you the numbering is right.
                first: episodes.slice(0, 3),
                last: episodes.slice(-3)
            }
        })
    })

    /** Fetch and read an episode page exactly as the content script would. */
    on("lab:page", async ({ url }) => {
        const source = episodeSourceFor(url)
        if (!source) throw new Error(`no source claims ${url} as an episode page`)

        const ctx = await fetchCtxFor(source)
        const target = swapOrigin(url, ctx.baseUrl)

        return timed(async () => {
            const html = await ctx.text(target)
            // Never a tracking signal: probing a page must not add a series or
            // move anyone's watch position.
            const identity = await identifyEpisode({ source, url: target, html, track: false })
            return { htmlBytes: html.length, identity }
        })
    })

    on("lab:streams", async ({ sourceId, episodeUrl, server }) => {
        required(sourceId)
        return timed(async () => resolveServerStreams({ sourceId, server: server as Server, episodeUrl }))
    })

    /**
     * Run an extractor against an embed URL directly.
     *
     * The most useful single button here. A dead server is nearly always an
     * extractor that stopped matching the host's markup, and this isolates that
     * from everything upstream of it.
     */
    on("lab:extract", async ({ embedUrl, referer }) => {
        const extractor = extractorFor(embedUrl)
        if (!extractor) {
            throw new Error(
                `no extractor claims ${new URL(embedUrl).hostname}. Known: ` +
                    allExtractors()
                        .map(candidate => candidate.id)
                        .join(", ")
            )
        }

        /*
         * A referer that names one of our sources gives the real fetch context,
         * headers and all. Without one — pasting an embed URL straight in, which
         * is the common way to use this — fall back to a context rooted at the
         * embed's own origin rather than refusing: most extractors only need to
         * reach the host they were handed.
         */
        const source = referer ? episodeSourceFor(referer) : null
        const ctx = source
            ? await fetchCtxFor(source)
            : createFetchCtx({
                  baseUrl: new URL(embedUrl).origin,
                  defaultHeaders: { Referer: ensureTrailingSlash(new URL(embedUrl).origin) }
              })

        const extractCtx: ExtractCtx = {
            referer: referer ?? embedUrl,
            text: (url, init) => ctx.text(url, { headers: init?.headers ?? {} }),
            json: (url, init) => ctx.json(url, { headers: init?.headers ?? {} })
        }

        return timed(async () => ({ extractorId: extractor.id, streams: await extractor.extract(embedUrl, extractCtx) }))
    })

    /**
     * The header rewrites actually installed right now.
     *
     * Three consecutive bugs came down to a rule that was present but scoped to
     * the wrong initiator or the wrong host, and nothing in the extension showed
     * what was in force. This does.
     */
    on("lab:rules", async () => {
        const rules = await chrome.declarativeNetRequest.getDynamicRules()
        logger.debug(`${rules.length} dynamic rule(s) installed`)
        return rules.map(rule => ({
            id: rule.id,
            requestDomains: rule.condition.requestDomains ?? [],
            initiatorDomains: rule.condition.initiatorDomains ?? [],
            resourceTypes: (rule.condition.resourceTypes ?? []) as string[],
            setHeaders: (rule.action.requestHeaders ?? []).map(header => `${header.header}: ${header.value ?? ""}`),
            removeHeaders: (rule.action.responseHeaders ?? []).map(header => header.header)
        }))
    })
}

function required(sourceId: string) {
    const source = sourceById(sourceId)
    if (!source) throw new Error(`unknown source "${sourceId}"`)
    return source
}

/** Every probe reports how long it took; a slow source is a finding too. */
async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; result: T }> {
    const started = Date.now()
    const result = await work()
    return { ms: Date.now() - started, result }
}
