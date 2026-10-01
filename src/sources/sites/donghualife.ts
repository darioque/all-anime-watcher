import type { Episode } from "~/model/types"
import type { Track } from "~/extractors/types"
import type { AnimeSource, FetchCtx, PageInfo, ResolvedServer, SearchResult, SeriesInfo, Server } from "~/sources/types"
import { attrOf, imageUrlFrom, parse } from "~/sources/html"
import { absoluteUrl, pathOf } from "~/shared/url"
import { log } from "~/shared/logger"
import {
    parseEpisodes,
    parseSeasons,
    parseWatchPage,
    rscOf,
    seasonOfUrl,
    seasonTitle,
    seasonUrl,
    showTitleFromPlayer,
    splitWatchSlug,
    watchIdOf,
    type ApiEpisode,
    type PlayerSource,
    type SeasonLike,
    type WatchPage
} from "./donghualife.parse"

const logger = log("source:donghualife")

/** How many search hits get their seasons read. Each one costs a request. */
const MAX_SEARCH_SHOWS = 10

/** What `getServers` hands `resolveServer`. Structured-cloneable on purpose. */
interface DonghuaLifeServer {
    token: string
    episodeId: string | null
    /** Attach the site's own subtitle track: true unless the video has them burnt in. */
    softSubs: boolean
}

/**
 * DonghuaLife — Spanish-subtitled donghua, a Next.js app with a small JSON API.
 *
 * Verified live 2026-10-01:
 *   search    /series?q=<query>&page=N                server-rendered `a.poster-card`
 *   show      /series/<slug>                          seasons in the RSC payload
 *   episodes  /api/series/<slug>/seasons/<season>/episodes   JSON, the whole season
 *   episode   /watch/<season-slug>-<n>                servers as signed tokens in the RSC payload
 *   server    POST /api/player/source {token}         → { url }, 30-minute expiry
 *             POST /api/player/refresh {token}        → { token } once it has expired
 *   subtitles /api/subtitles?episodeId=<id>           → [{ id, language }]
 *             /api/subtitles/<id>                     → { content: "<ASS>" }, Referer required
 *
 * **A show is not a series here; a season is.** Every season restarts at
 * episode 1 (Wan Jie Du Zun has seasons of 50, 224 and 213), so one show-level
 * entry would hold three episode 1s. Each season is followed on its own, keyed by
 * its slug — the same split AniList makes. The stored URL is the show's page with
 * the season in the fragment (`seasonUrl`).
 *
 * **Identity never comes from an episode URL.** The site's own lists link
 * `/watch/<season-slug>-<n>`, but `/watch/<series-slug>-<n>` also works for a
 * single-season show and lands in season `<series-slug>-1`; the episode's JSON-LD
 * advertises that second form. Both URLs end in a number, and stripping it yields
 * two different ids for one season. The page states its `seasonSlug`, and that is
 * what `getPageInfo` reads; `seriesIdFromUrl` answers only for our own season URLs.
 *
 * **It is a client-side app**, so the viewer moves between episodes without a page
 * load and the DOM handed over by the content script still carries the *first*
 * page's payload. Every page reader checks the payload's `currentId` against the
 * URL and fetches the page fresh when they disagree.
 *
 * **Servers**: R2 is the site's own HLS on `videos.donghualife.com`, whose CDN
 * allows the site's origin, so it plays from the page — but the video is raw
 * (only the Chinese line is burnt in) and the Spanish is a separate ASS track,
 * attached here through `ResolvedServer.subtitles`. Rumble and Odysee are
 * embeds with the subtitles burnt in ("native"); Rumble has an extractor,
 * Odysee does not yet and falls back to its iframe.
 *
 * **VIP early access** is this site's version of "posted, but not out": the
 * newest episodes of an airing season are subscriber-only for a while, and a
 * free viewer opening one is redirected to `/vip`. The API flags them, so
 * `parseEpisodes` drops them from the list; see `isEpisodePage` for why there is
 * no page-level check to go with it.
 *
 * The site sends its CSP as `Content-Security-Policy-Report-Only`, which blocks
 * nothing, so `stripCsp` stays off.
 */
export class DonghuaLife implements AnimeSource {
    readonly id = "donghualife"
    readonly name = "DonghuaLife"
    /** The catalogue is Chinese animation only; the site is named after it. */
    readonly categories = ["Donghua"]
    readonly languages = ["es"]
    readonly domains = ["donghualife.com"]
    readonly home = "https://donghualife.com/"

    readonly episodeUrl = /^\/watch\/[^/]+-\d+(?:\.\d+)?\/?$/

    /**
     * Only our own season URLs carry an identity. A show's page holds several
     * seasons and names none of them, and an episode URL's prefix is ambiguous —
     * see the class comment — so both return null and the page is read instead.
     */
    seriesIdFromUrl(url: string): string | null {
        return seasonOfUrl(url)?.seasonSlug ?? null
    }

    episodeNumberFromUrl(url: string): number | null {
        return splitWatchSlug(pathOf(url))?.number ?? null
    }

    // ------------------------------------------------------------ discovery

    /**
     * The site searches shows; this returns seasons.
     *
     * A hit only names the show, so each one's page is read for its seasons —
     * one request per show, capped, because a search result has to carry the id
     * the series will be keyed by and only the season has one.
     */
    async search(query: string, ctx: FetchCtx, page = 1): Promise<SearchResult[]> {
        const params = new URLSearchParams({ q: query })
        if (page > 1) params.set("page", String(page))
        const $ = parse(await ctx.text(`${ctx.baseUrl}/series?${params.toString()}`))

        const shows: Array<{ slug: string; title: string; poster?: string }> = []
        $("a.poster-card[href^='/series/']").each((_, element) => {
            const $a = $(element)
            const slug = /^\/series\/([^/?#]+)/.exec(attrOf($a, "href") ?? "")?.[1]
            if (!slug || shows.some(show => show.slug === slug)) return
            const $img = $a.find("img").first()
            const title = $a.find("p").first().text().trim() || attrOf($img, "alt") || slug
            shows.push({ slug, title, poster: imageUrlFrom($img, ctx.baseUrl, $) })
        })

        const results = await Promise.all(
            shows.slice(0, MAX_SEARCH_SHOWS).map(async show => {
                try {
                    const seasons = await this.seasonsOf(show.slug, ctx)
                    return seasons.map(season => ({
                        title: seasonTitle(show.title, season.label, seasons.length),
                        url: seasonUrl(ctx.baseUrl, show.slug, season.slug),
                        seriesId: season.slug,
                        poster: show.poster
                    }))
                } catch (error) {
                    logger.debug(`could not read the seasons of ${show.slug}`, error)
                    return []
                }
            })
        )

        logger.debug(`search "${query}" → ${shows.length} show(s)`)
        return results.flat()
    }

    async getSeries(seriesUrl: string, ctx: FetchCtx): Promise<SeriesInfo> {
        const { seriesSlug, seasonSlug } = this.season(seriesUrl)
        const html = await ctx.text(`${ctx.baseUrl}/series/${seriesSlug}`, { noCache: true })
        const $ = parse(html)
        const seasons = parseSeasons(rscOf(html))
        const season = seasons.find(candidate => candidate.slug === seasonSlug)

        // The JSON-LD is the page's own summary of the show and the tidiest
        // place to read it from; the heading is the fallback.
        let ld: { name?: string; description?: string; genre?: string[]; image?: string } = {}
        try {
            ld = JSON.parse($('script[type="application/ld+json"]').first().text() || "{}")
        } catch {
            // Fall through to the markup.
        }
        const show = ld.name?.trim() || $("h1").first().text().trim() || seriesSlug
        const original = $("p:contains('Título original') span").first().text().trim()

        return {
            title: seasonTitle(show, season?.label ?? "", seasons.length),
            seriesId: seasonSlug,
            url: seriesUrl,
            poster: ld.image ? absoluteUrl(ld.image, ctx.baseUrl) : undefined,
            description: ld.description,
            genres: Array.isArray(ld.genre) ? ld.genre : undefined,
            status: "unknown",
            altTitles: original ? [original] : undefined
        }
    }

    /** One request: the season's whole episode list, from the site's own API. */
    async getEpisodes(seriesUrl: string, ctx: FetchCtx): Promise<Episode[]> {
        const { seriesSlug, seasonSlug } = this.season(seriesUrl)
        const response = await ctx.json<{ episodes?: ApiEpisode[] }>(
            `${ctx.baseUrl}/api/series/${encodeURIComponent(seriesSlug)}/seasons/${encodeURIComponent(seasonSlug)}/episodes`,
            { noCache: true }
        )
        const listed = response.episodes ?? []
        const episodes = parseEpisodes(listed, number => `${ctx.baseUrl}/watch/${seasonSlug}-${number}`)

        const held = listed.length - episodes.length
        logger.debug(`${episodes.length} episodes in ${seasonSlug}` + (held > 0 ? `, ${held} VIP-only held back` : ""))
        return episodes
    }

    // ------------------------------------------------------------ page context

    /**
     * The URL decides, and the HTML only has to be this site's app — the player
     * markup is not checked, because after a client-side navigation the DOM is
     * an earlier page's and `watchPage` refetches anyway.
     *
     * The one page refused is a VIP redirect. It names no season, no series and
     * no server, so there is nothing to identify, and the browser is already on
     * its way to `/vip`. That is also why this source declares no
     * `episodeAvailability`: the only "not out yet" page the site has is one
     * that cannot be read, and its episode never reached the list.
     */
    isEpisodePage(html: string, url: string): boolean {
        if (!new RegExp(this.episodeUrl.source).test(pathOf(url))) return false
        if (!html.includes("self.__next_f")) return false
        const page = parseWatchPage(html)
        return !(page.vipOnly && page.sources.length === 0 && page.seasonSlug === null)
    }

    async getPageInfo(html: string, url: string, ctx: FetchCtx): Promise<PageInfo> {
        const page = await this.watchPage(html, url, ctx)
        const number = this.episodeNumberFromUrl(url)
        if (number === null) throw new Error(`could not read an episode number from ${url}`)
        if (!page.seasonSlug || !page.seriesSlug) {
            throw new Error("the page does not say which season it belongs to")
        }

        const showTitle = page.playerTitle ? showTitleFromPlayer(page.playerTitle) : page.seriesSlug
        const season = page.seasons.find(candidate => candidate.slug === page.seasonSlug)
        // The watch page lists seasons with no episode counts, so an empty
        // placeholder season would inflate the count — the show's page is the
        // authority on that, but a title is not worth a request.
        const title = seasonTitle(showTitle, season?.name ?? "", page.seasons.length)

        return {
            title,
            seriesId: page.seasonSlug,
            seriesUrl: seasonUrl(ctx.baseUrl, page.seriesSlug, page.seasonSlug),
            number,
            variant: "sub",
            episodeUrl: url
        }
    }

    async getServers(html: string, url: string, ctx: FetchCtx): Promise<Server[]> {
        const page = await this.watchPage(html, url, ctx)
        const servers = [...page.sources]
            .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
            .filter((source): source is PlayerSource => typeof source.token === "string" && source.token !== "")
            .map((source): Server => ({
                name: source.label || source.provider,
                variant: "sub",
                resolve: {
                    token: source.token,
                    episodeId: page.episodeId,
                    softSubs: source.subtitleSupport !== undefined && source.subtitleSupport !== "native"
                } satisfies DonghuaLifeServer
            }))

        logger.debug(`${servers.length} servers on ${url}`)
        return servers
    }

    /**
     * Spend a server's token. Tokens expire after thirty minutes, so a page left
     * open — or read ahead by the look-ahead — has to trade an expired one for a
     * fresh one first, which is what the site's own player does.
     */
    async resolveServer(server: Server, ctx: FetchCtx): Promise<ResolvedServer> {
        const payload = server.resolve as DonghuaLifeServer | undefined
        if (!payload?.token) throw new Error(`server "${server.name}" carries no token`)

        const embedUrl = await this.spend(payload.token, ctx)
        const subtitles = payload.softSubs && payload.episodeId ? await this.subtitlesOf(payload.episodeId, ctx) : []
        return { embedUrl, subtitles }
    }

    // ------------------------------------------------------------ helpers

    private season(seriesUrl: string): { seriesSlug: string; seasonSlug: string } {
        const season = seasonOfUrl(seriesUrl)
        if (!season) throw new Error(`${seriesUrl} does not name a season`)
        return season
    }

    private async seasonsOf(seriesSlug: string, ctx: FetchCtx): Promise<SeasonLike[]> {
        return parseSeasons(rscOf(await ctx.text(`${ctx.baseUrl}/series/${seriesSlug}`)))
    }

    /** The payload for *this* URL — refetched when the HTML in hand is another page's. */
    private async watchPage(html: string, url: string, ctx: FetchCtx): Promise<WatchPage> {
        const page = parseWatchPage(html)
        const current = watchIdOf(pathOf(url))
        if (page.currentId !== null && page.currentId === current) return page

        logger.debug(`payload is for ${page.currentId ?? "nothing"}, not ${current}; fetching ${url}`)
        return parseWatchPage(await ctx.text(url, { noCache: true }))
    }

    private async spend(token: string, ctx: FetchCtx): Promise<string> {
        const post = <T>(path: string, body: unknown) =>
            ctx.json<T>(`${ctx.baseUrl}${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                noCache: true
            })

        try {
            const source = await post<{ url?: string }>("/api/player/source", { token })
            if (source.url) return source.url
        } catch (error) {
            logger.debug("token refused, refreshing it", error)
        }

        const refreshed = await post<{ token?: string }>("/api/player/refresh", { token })
        if (!refreshed.token) throw new Error("the site would not refresh an expired server token")
        const source = await post<{ url?: string; error?: string }>("/api/player/source", { token: refreshed.token })
        if (!source.url) throw new Error(source.error ?? "the site returned no URL for this server")
        return source.url
    }

    /** Spanish first, the way the site's own player picks its default. */
    private async subtitlesOf(episodeId: string, ctx: FetchCtx): Promise<Track[]> {
        try {
            const response = await ctx.json<{ subtitles?: Array<{ id: string; label?: string; language?: string }> }>(
                `${ctx.baseUrl}/api/subtitles?episodeId=${encodeURIComponent(episodeId)}`,
                { noCache: true }
            )
            const listed = response.subtitles ?? []
            const preferred = listed.find(track => track.language === "es") ?? listed[0]
            return listed.map(track => ({
                url: `${ctx.baseUrl}/api/subtitles/${encodeURIComponent(track.id)}`,
                label: track.label || track.language || "Subtítulos",
                language: track.language,
                format: "ass",
                jsonField: "content",
                default: track === preferred
            }))
        } catch (error) {
            // A missing subtitle list must not cost the episode its video.
            logger.warn(`could not list subtitles for ${episodeId}`, error)
            return []
        }
    }
}

export const donghualife = new DonghuaLife()
