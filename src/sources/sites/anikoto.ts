import type { Episode } from "~/model/types"
import type { AnimeSource, DomainSource, FetchCtx, PageInfo, SearchResult, SeriesInfo, Server } from "~/sources/types"
import { attrOf, imageUrlFrom, parse } from "~/sources/html"
import { rc4ToBase64 } from "~/shared/crypto"
import { absoluteUrl, pathOf } from "~/shared/url"
import { log } from "~/shared/logger"

const logger = log("source:anikoto")

/** The key sits in the site's own bundle; this is obfuscation, not security. */
const VRF_KEY = "simple-hash"

/**
 * Anikoto — the AnimeKai/AnimeSuge family.
 *
 * Everything past the page shell is AJAX, and the episode list is signed:
 * `vrf = base64(rc4("simple-hash", animeId))`. The key and the algorithm both
 * come from the site's own `main.js`, where the same routine decodes the
 * `window.__cfg` blob — decoding that to valid JSON is how the scheme was
 * confirmed rather than guessed.
 *
 * The chain, verified live 2026-08-24:
 *   watch page                       → data-id (anime id), data-url (series URL)
 *   ajax/episode/list/<id>?vrf=…     → <a data-num data-ids data-sub data-dub>
 *   ajax/server/list?servers=<ids>   → li[data-link-id] grouped by div.type[data-type]
 *   ajax/server?get=<link-id>        → { url, skip_data:{intro,outro} }
 *
 * That last response hands over intro/outro timestamps for free, which is the
 * data the skip feature needs.
 *
 * Embeds land on megaplay.buzz and friends, which have no extractor — the
 * player's iframe fallback covers them.
 */
export class Anikoto implements AnimeSource {
    readonly id = "anikoto"
    readonly name = "Anikoto"
    readonly languages = ["en"]

    /** This family rotates hosts constantly; see `domainSource` below. */
    readonly domains = ["anikototv.to", "anikototv.se", "anikoto.me", "anikoto.cz", "anikoto.net"]
    readonly home = "https://anikototv.to/"

    readonly episodeUrl = /^\/watch\/[^/]+\/ep-[\d.]+\/?$/
    readonly seriesUrl = /^\/watch\/[^/]+\/?$/

    /** Anikoto publishes its live domains on a static page. */
    readonly domainSource: DomainSource = { url: "https://anikoto.site/" }

    seriesIdFromUrl(url: string): string | null {
        return /^\/watch\/([^/]+)/.exec(pathOf(url))?.[1] ?? null
    }

    episodeNumberFromUrl(url: string): number | null {
        const match = /\/ep-([\d.]+)/.exec(pathOf(url))
        return match?.[1] ? Number.parseFloat(match[1]) : null
    }

    // ------------------------------------------------------------ discovery

    async search(query: string, ctx: FetchCtx): Promise<SearchResult[]> {
        const $ = parse(await ctx.text(`${ctx.baseUrl}/filter?keyword=${encodeURIComponent(query)}`))
        const results: SearchResult[] = []
        const seen = new Set<string>()

        $("div.item a[href*='/watch/']").each((_, element) => {
            const $a = $(element)
            const href = attrOf($a, "href")
            if (!href) return

            const url = absoluteUrl(href, ctx.baseUrl)
            const seriesId = this.seriesIdFromUrl(url)
            if (!seriesId || seen.has(seriesId)) return
            seen.add(seriesId)

            const $img = $a.find("img").first()
            const title = attrOf($img, "alt") || $a.find(".title").first().text().trim() || seriesId

            results.push({
                title,
                url: `${ctx.baseUrl}/watch/${seriesId}`,
                seriesId,
                poster: imageUrlFrom($img, ctx.baseUrl, $)
            })
        })

        logger.debug(`search "${query}" → ${results.length} result(s)`)
        return results
    }

    async getSeries(seriesUrl: string, ctx: FetchCtx): Promise<SeriesInfo> {
        const $ = parse(await ctx.text(seriesUrl, { noCache: true }))
        const seriesId = this.seriesIdFromUrl(seriesUrl)
        if (!seriesId) throw new Error(`could not derive a series id from ${seriesUrl}`)

        const meta = (property: string) => $(`meta[property="${property}"]`).attr("content")?.trim()
        const title =
            $("h1.title").first().text().trim() ||
            attrOf($("[data-jp]").first(), "data-jp") ||
            meta("og:title") ||
            seriesId

        return {
            // og:title carries the site name; the heading doesn't.
            title: title.replace(/\s*[-|]\s*Anikoto.*$/i, "").trim(),
            seriesId,
            url: seriesUrl,
            poster: meta("og:image") ?? imageUrlFrom($("div.poster img").first(), ctx.baseUrl, $),
            description: meta("og:description"),
            status: "unknown"
        }
    }

    async getEpisodes(seriesUrl: string, ctx: FetchCtx): Promise<Episode[]> {
        const seriesId = this.seriesIdFromUrl(seriesUrl)
        if (!seriesId) throw new Error(`could not derive a series id from ${seriesUrl}`)

        const html = await ctx.text(seriesUrl, { noCache: true })
        const animeId = this.animeIdFrom(html)
        if (!animeId) throw new Error(`no anime id on ${seriesUrl}`)
        return this.episodesFor(animeId, seriesId, ctx)
    }

    // ------------------------------------------------------------ page context

    isEpisodePage(html: string, url: string): boolean {
        if (!new RegExp(this.episodeUrl.source).test(pathOf(url))) return false
        return this.animeIdFrom(html) !== null
    }

    async getPageInfo(html: string, url: string, ctx: FetchCtx): Promise<PageInfo> {
        const $ = parse(html)
        const seriesId = this.seriesIdFromUrl(url)
        if (!seriesId) throw new Error(`could not derive a series id from ${url}`)

        const number = this.episodeNumberFromUrl(url)
        if (number === null) throw new Error(`could not read an episode number from ${url}`)

        const seriesFromPage = attrOf($("div.watch-wrap").first(), "data-url")
        const title =
            $("h1.title").first().text().trim() ||
            (
                $("title")
                    .first()
                    .text()
                    .split(/\s+Episode\s+/i)[0] ?? ""
            )
                .replace(/^Anikoto\s*[-|]\s*/i, "")
                .trim() ||
            seriesId

        return {
            title,
            seriesId,
            seriesUrl: seriesFromPage ? absoluteUrl(seriesFromPage, ctx.baseUrl) : `${ctx.baseUrl}/watch/${seriesId}`,
            number,
            episodeUrl: url
        }
    }

    /**
     * The page ships no server list — it is fetched twice over: once for the
     * episode entry (which carries an opaque `data-ids` token) and once for the
     * servers that token unlocks.
     */
    async getServers(html: string, url: string, ctx: FetchCtx): Promise<Server[]> {
        const animeId = this.animeIdFrom(html)
        const number = this.episodeNumberFromUrl(url)
        if (!animeId || number === null) return []

        const entries = await this.episodeEntries(animeId, ctx)
        const entry = entries.find(e => e.number === number)
        if (!entry?.ids) {
            logger.warn(`no server token for episode ${number}`)
            return []
        }

        const body = await this.ajax(`ajax/server/list?servers=${encodeURIComponent(entry.ids)}`, ctx, url)
        // Every ajax/* endpoint answers with a JSON envelope, not bare HTML.
        const $ = parse(this.unwrap(body, "server list"))
        const servers: Server[] = []

        $("div.type").each((_, group) => {
            const $group = $(group)
            // sub / dub, which is exactly the variant the settings chain filters on.
            const variant = attrOf($group, "data-type") ?? undefined
            $group.find("li[data-link-id]").each((_, element) => {
                const $li = $(element)
                const linkId = attrOf($li, "data-link-id")
                if (!linkId) return
                servers.push({
                    name: $li.text().trim() || "Server",
                    ...(variant ? { variant } : {}),
                    // Deferred: each embed costs another request, and only one
                    // server is ever watched.
                    resolve: { linkId }
                })
            })
        })

        logger.debug(`${servers.length} servers for episode ${number}`)
        return servers
    }

    async resolveServer(server: Server, ctx: FetchCtx): Promise<string> {
        if (server.embedUrl) return server.embedUrl

        const { linkId } = (server.resolve ?? {}) as { linkId?: string }
        if (!linkId) throw new Error(`server "${server.name}" carries no link id`)

        const body = await this.ajax(`ajax/server?get=${encodeURIComponent(linkId)}`, ctx)
        const payload = JSON.parse(body) as {
            status?: number
            message?: string
            // Same {status, result} envelope as every other endpoint, except here
            // `result` is an object rather than HTML.
            result?: { url?: string; skip_data?: { intro?: number[]; outro?: number[] } }
        }

        if (payload.status !== 200) {
            throw new Error(`server "${server.name}" refused: ${payload.message ?? `status ${payload.status}`}`)
        }

        const url = payload.result?.url
        if (!url) throw new Error(`no embed URL for server "${server.name}"`)

        // `result.skip_data` carries intro/outro offsets. Nothing consumes them
        // yet — these embeds play in an iframe, where we can't seek — so they are
        // deliberately not plumbed through rather than carried unused.
        return url
    }

    // ------------------------------------------------------------ helpers

    /** `data-id` on the watch wrapper is the numeric anime id the API wants. */
    private animeIdFrom(html: string): string | null {
        return (
            /<div[^>]+class="[^"]*watch-wrap[^"]*"[^>]*data-id="(\d+)"/.exec(html)?.[1] ??
            /data-id="(\d+)"/.exec(html)?.[1] ??
            null
        )
    }

    private async episodesFor(animeId: string, seriesId: string, ctx: FetchCtx): Promise<Episode[]> {
        const entries = await this.episodeEntries(animeId, ctx)
        // The episode URL is built from the *series* slug. `data-slug` on an entry
        // is the episode's own slug ("1"), which is not what the path wants.
        const episodes: Episode[] = entries.map(entry => ({
            number: entry.number,
            url: `${ctx.baseUrl}/watch/${seriesId}/ep-${entry.number}`,
            ...(entry.dub && !entry.sub ? { variant: "dub" } : entry.sub ? { variant: "sub" } : {})
        }))
        episodes.sort((a, b) => b.number - a.number)
        return episodes
    }

    private async episodeEntries(animeId: string, ctx: FetchCtx): Promise<EpisodeEntry[]> {
        const vrf = rc4ToBase64(VRF_KEY, animeId)
        const body = await this.ajax(`ajax/episode/list/${animeId}?vrf=${encodeURIComponent(vrf)}`, ctx)

        const $ = parse(this.unwrap(body, `episode list for anime ${animeId}`))
        const entries: EpisodeEntry[] = []

        $("a[data-num]").each((_, element) => {
            const $a = $(element)
            const number = Number.parseFloat(attrOf($a, "data-num") ?? "")
            if (!Number.isFinite(number)) return
            entries.push({
                number,
                ids: attrOf($a, "data-ids"),
                slug: attrOf($a, "data-slug"),
                sub: attrOf($a, "data-sub") === "1",
                dub: attrOf($a, "data-dub") === "1"
            })
        })

        return entries
    }

    /**
     * Pull the HTML out of the `{status, result}` envelope every ajax/* endpoint
     * wraps its answer in. Parsing the envelope as markup finds nothing and looks
     * exactly like a selector that stopped matching, so this is a single helper
     * rather than something each caller remembers to do.
     */
    private unwrap(body: string, what: string): string {
        const payload = JSON.parse(body) as { status?: number; result?: unknown; message?: string }
        if (payload.status !== 200) {
            throw new Error(
                `${what} refused: status ${payload.status}${payload.message ? ` — ${payload.message}` : ""}`
            )
        }
        if (typeof payload.result !== "string") {
            throw new Error(`${what} returned no HTML`)
        }
        return payload.result
    }

    /** Every AJAX call needs the XHR marker; without it the site returns its shell. */
    private async ajax(path: string, ctx: FetchCtx, referer?: string): Promise<string> {
        return ctx.text(`${ctx.baseUrl}/${path}`, {
            headers: {
                "X-Requested-With": "XMLHttpRequest",
                Referer: referer ?? `${ctx.baseUrl}/`
            },
            noCache: true
        })
    }
}

interface EpisodeEntry {
    number: number
    ids?: string
    slug?: string
    sub: boolean
    dub: boolean
}

export const anikoto = new Anikoto()
