import type { Episode } from "~/model/types"
import type {
    AnimeSource,
    DomainSource,
    FetchCtx,
    NetRequestConfig,
    PageInfo,
    SearchResult,
    SeriesInfo,
    Server
} from "~/sources/types"
import { attrOf, imageUrlFrom, leadingNumber, looseDate, ownText, parse } from "~/sources/html"
import { absoluteUrl, ensureTrailingSlash, hostOf, pathOf } from "~/shared/url"
import { log } from "~/shared/logger"

/**
 * The `animestream` WordPress theme — the anime world's Madara.
 *
 * One base class, one config object per site. Selectors below are the theme's
 * defaults, verified against lmanime.com on 2026-08-24; a site that restyles
 * overrides just the selector that moved.
 */
export interface AnimeStreamConfig {
    id: string
    name: string
    languages: string[]
    domains: string[]
    home: string
    icon?: string
    /** What the site carries whatever the series is, e.g. `["Donghua"]`. */
    categories?: string[]

    /** Matched against pathname. Defaults to the theme's `-episode-N` scheme. */
    episodeUrl?: RegExp
    /**
     * Where this site's series pages live, matched against pathname.
     *
     * Optional, and only some sites can say: lmanime keeps series at the root,
     * where `/genres/` and `/anime-list/` are indistinguishable from a slug.
     * Declaring it lets the user follow a series from its own page, and it also
     * makes `seriesIdFromUrl` honest — see the note there.
     */
    seriesUrl?: RegExp
    /** Path of the browse/filter listing, relative to home. */
    animeListPath?: string
    /** Strips the episode part off a slug to recover the series slug. */
    episodeSuffix?: RegExp

    selectors?: Partial<AnimeStreamSelectors>

    /** Labels to keep, in order, when the site lists servers per language. */
    serverLabelFilter?: (label: string) => boolean

    netRequest?: NetRequestConfig | null
    domainSource?: DomainSource
}

export interface AnimeStreamSelectors {
    searchItem: string
    searchTitle: string
    title: string
    thumb: string
    description: string
    genres: string
    status: string
    episodeItem: string
    episodeNumber: string
    episodeTitle: string
    episodeSub: string
    episodeDate: string
    server: string
    breadcrumbItem: string
    /** The video iframe on a resolved server page, not the page's ad iframes. */
    playerIframe: string
}

const DEFAULT_SELECTORS: AnimeStreamSelectors = {
    searchItem: "div.listupd article a.tip",
    searchTitle: "div.tt, div.ttl",
    title: "h1.entry-title",
    thumb: "div.thumb > img, div.limage > img",
    description: ".entry-content[itemprop=description], .desc",
    genres: "div.genxed > a, li:contains(Genre:) a",
    status: "div.spe span:contains(Status), li:contains(Status:)",
    episodeItem: "div.eplister > ul > li > a",
    episodeNumber: ".epl-num",
    episodeTitle: ".epl-title",
    episodeSub: ".epl-sub",
    episodeDate: ".epl-date",
    server: "select.mirror > option[value], ul.mirror a[data-em]",
    breadcrumbItem: "[itemprop=item]",
    playerIframe: "iframe[src]"
}

const DEFAULT_EPISODE_URL = /^\/[^/]+-episode-[\d.]+\/?$/
const DEFAULT_EPISODE_SUFFIX = /-episode-[\d.]+(?:-[a-z0-9-]*)?$/i

export class AnimeStream implements AnimeSource {
    readonly id: string
    readonly name: string
    readonly languages: string[]
    readonly domains: string[]
    readonly home: string
    readonly icon?: string
    readonly categories?: string[]
    readonly episodeUrl: RegExp
    readonly seriesUrl?: RegExp
    readonly domainSource?: DomainSource

    protected readonly sel: AnimeStreamSelectors
    protected readonly animeListPath: string
    protected readonly episodeSuffix: RegExp
    protected readonly netRequestConfig: NetRequestConfig | null
    protected readonly serverLabelFilter: (label: string) => boolean
    protected readonly logger

    constructor(config: AnimeStreamConfig) {
        this.id = config.id
        this.name = config.name
        this.languages = config.languages
        this.domains = config.domains
        this.home = ensureTrailingSlash(config.home)
        this.icon = config.icon
        this.categories = config.categories
        this.episodeUrl = config.episodeUrl ?? DEFAULT_EPISODE_URL
        this.seriesUrl = config.seriesUrl
        this.animeListPath = config.animeListPath ?? "anime"
        this.episodeSuffix = config.episodeSuffix ?? DEFAULT_EPISODE_SUFFIX
        this.sel = { ...DEFAULT_SELECTORS, ...config.selectors }
        this.netRequestConfig = config.netRequest ?? null
        this.serverLabelFilter = config.serverLabelFilter ?? (() => true)
        this.domainSource = config.domainSource
        this.logger = log(`source:${config.id}`)
    }

    netRequest(): NetRequestConfig | null {
        return this.netRequestConfig
    }

    // ------------------------------------------------------------ identity

    /**
     * Series identity from a URL — and only from one that is actually a series
     * URL, where the site says which those are.
     *
     * Slug arithmetic assumes an episode slug is its series slug plus a marker.
     * That holds on lmanime and fails on luciferdonghua.in, which publishes
     * `perfect-world-wanmei-shijie-episode-284-…` under `/anime/perfect-world-new/`
     * — a stem that looks like a series id, names no series, and would key a
     * second library entry that never updates. So when a site declares where
     * its series live, anything else returns null and identity comes from
     * `getPageInfo`, which reads the theme's breadcrumb. Sites that cannot
     * declare it keep the old behaviour, which is the best guess available.
     */
    seriesIdFromUrl(url: string): string | null {
        if (this.seriesUrl && !this.matchesPath(this.seriesUrl, url)) return null
        return this.slugFromUrl(url)
    }

    /**
     * Last non-empty path segment, with any `-episode-N` suffix removed. Works
     * for series at the root (`/slug/`) and under a prefix (`/anime/slug/`).
     */
    protected slugFromUrl(url: string): string | null {
        const segments = pathOf(url)
            .split("/")
            .filter(s => s !== "")
        const last = segments.at(-1)
        if (!last) return null
        const slug = last.replace(this.episodeSuffix, "")
        return slug === "" ? null : slug
    }

    /** A source's own pattern, matched without the `g` flag's sticky lastIndex. */
    protected matchesPath(pattern: RegExp, url: string): boolean {
        return new RegExp(pattern.source, pattern.flags.replace("g", "")).test(pathOf(url))
    }

    episodeNumberFromUrl(url: string): number | null {
        const match = pathOf(url).match(/-episode-(\d+(?:\.\d+)?)/i)
        return match?.[1] ? Number.parseFloat(match[1]) : null
    }

    // ------------------------------------------------------------ discovery

    async search(query: string, ctx: FetchCtx, page = 1): Promise<SearchResult[]> {
        const url =
            query.trim() === ""
                ? `${ctx.baseUrl}/${this.animeListPath}/?page=${page}&order=update`
                : `${ctx.baseUrl}/page/${page}/?s=${encodeURIComponent(query)}`

        const $ = parse(await ctx.text(url, { noCache: true }))
        const results: SearchResult[] = []

        $(this.sel.searchItem).each((_, element) => {
            const $a = $(element)
            const href = attrOf($a, "href")
            if (!href) return
            const absolute = absoluteUrl(href, ctx.baseUrl)
            const seriesId = this.seriesIdFromUrl(absolute)
            if (!seriesId) return

            const $title = $a.find(this.sel.searchTitle).first()
            const title = ($title.length ? ownText($title) || $title.text().trim() : $a.attr("title")) ?? seriesId

            results.push({
                title: title.trim(),
                url: absolute,
                seriesId,
                poster: imageUrlFrom($a.find("img").first(), ctx.baseUrl, $)
            })
        })

        this.logger.debug(`search "${query}" → ${results.length} results`)
        return results
    }

    async getSeries(seriesUrl: string, ctx: FetchCtx): Promise<SeriesInfo> {
        const html = await ctx.text(seriesUrl, { noCache: true })
        return this.parseSeries(html, seriesUrl, ctx)
    }

    protected parseSeries(html: string, seriesUrl: string, ctx: FetchCtx): SeriesInfo {
        const $ = parse(html)
        const seriesId = this.seriesIdFromUrl(seriesUrl)
        if (!seriesId) throw new Error(`could not derive a series id from ${seriesUrl}`)

        const genres: string[] = []
        $(this.sel.genres).each((_, el) => {
            const text = $(el).text().trim()
            if (text !== "") genres.push(text)
        })

        const statusText = $(this.sel.status).first().text().toLowerCase()
        const status: SeriesInfo["status"] = statusText.includes("ongoing")
            ? "airing"
            : statusText.includes("completed") || statusText.includes("finished")
              ? "completed"
              : "unknown"

        return {
            title: $(this.sel.title).first().text().trim() || seriesId,
            seriesId,
            url: seriesUrl,
            poster: imageUrlFrom($(this.sel.thumb).first(), ctx.baseUrl, $),
            description: $(this.sel.description).first().text().trim() || undefined,
            genres: genres.length ? genres : undefined,
            status
        }
    }

    async getEpisodes(seriesUrl: string, ctx: FetchCtx): Promise<Episode[]> {
        const html = await ctx.text(seriesUrl, { noCache: true })
        return this.parseEpisodes(html, seriesUrl, ctx)
    }

    protected parseEpisodes(html: string, baseUrl: string, ctx: FetchCtx): Episode[] {
        const $ = parse(html)
        const episodes: Episode[] = []

        $(this.sel.episodeItem).each((_, element) => {
            const $a = $(element)
            const href = attrOf($a, "href")
            if (!href) return

            const url = absoluteUrl(href, ctx.baseUrl)
            const numberText = $a.find(this.sel.episodeNumber).first().text().trim()
            const number = leadingNumber(numberText) ?? this.episodeNumberFromUrl(url)
            if (number === null) {
                this.logger.warn(`skipping episode with no parseable number: ${url}`)
                return
            }

            const title = $a.find(this.sel.episodeTitle).first().text().trim()
            const variant = $a.find(this.sel.episodeSub).first().text().trim()
            const airedAt = looseDate($a.find(this.sel.episodeDate).first().text())

            episodes.push({
                number,
                url,
                ...(title && title !== "" ? { title } : {}),
                ...(variant && variant !== "" ? { variant: variant.toLowerCase() } : {}),
                ...(airedAt ? { airedAt } : {})
            })
        })

        episodes.sort((a, b) => b.number - a.number)
        this.logger.debug(`${episodes.length} episodes from ${baseUrl}`)
        return episodes
    }

    // ------------------------------------------------------------ page context

    isEpisodePage(html: string, url: string): boolean {
        if (!this.matchesPath(this.episodeUrl, url)) return false
        return parse(html)(this.sel.server).length > 0
    }

    async getPageInfo(html: string, url: string, ctx: FetchCtx): Promise<PageInfo> {
        const $ = parse(html)

        // The theme emits a schema.org breadcrumb: home → series → episode. Read
        // the series URL from there rather than doing slug arithmetic, which
        // breaks on slugs that themselves contain "-episode-".
        const crumbs: string[] = []
        $(this.sel.breadcrumbItem).each((_, el) => {
            const href = attrOf($(el), "href", "content")
            if (href) crumbs.push(absoluteUrl(href, ctx.baseUrl))
        })

        const normalized = (value: string) => value.replace(/\/+$/, "")
        const candidates = crumbs.filter(
            c => normalized(c) !== normalized(url) && normalized(c) !== normalized(this.home)
        )
        const seriesUrl = candidates.at(-1) ?? this.seriesUrlFromEpisodeUrl(url, ctx)

        const seriesId = this.seriesIdFromUrl(seriesUrl)
        if (!seriesId) throw new Error(`could not derive a series id from ${seriesUrl}`)

        const pageTitle = $(this.sel.title).first().text().trim()
        const number = this.episodeNumberFromUrl(url) ?? leadingNumber(pageTitle.replace(/^\D+/, "")) ?? 1

        return {
            // Strip the trailing "Episode N" the theme appends to episode titles.
            title: pageTitle.replace(/\s*episode\s*[\d.]+\s*$/i, "").trim() || seriesId,
            seriesId,
            seriesUrl,
            number,
            episodeUrl: url
        }
    }

    protected seriesUrlFromEpisodeUrl(url: string, ctx: FetchCtx): string {
        const seriesId = this.slugFromUrl(url)
        const prefix =
            this.animeListPath && pathOf(url).startsWith(`/${this.animeListPath}/`) ? `/${this.animeListPath}` : ""
        return `${ctx.baseUrl}${prefix}/${seriesId}/`
    }

    async getServers(html: string, url: string, _ctx: FetchCtx): Promise<Server[]> {
        const $ = parse(html)
        const servers: Server[] = []

        $(this.sel.server).each((_, element) => {
            const $el = $(element)
            const label = $el.text().trim()
            if (label === "" || !this.serverLabelFilter(label)) return

            // <option value> holds either a URL to fetch or base64-encoded HTML.
            // <a data-em> always holds base64. Either way, resolution is deferred:
            // a page can list eight servers and only one gets watched.
            const payload = $el.is("option") ? attrOf($el, "value") : attrOf($el, "data-em")
            if (!payload) return

            servers.push({ name: label, resolve: { payload, referer: url } })
        })

        this.logger.debug(`${servers.length} servers on ${url}`)
        return servers
    }

    async resolveServer(server: Server, ctx: FetchCtx): Promise<string> {
        if (server.embedUrl) return server.embedUrl

        const { payload, referer } = (server.resolve ?? {}) as { payload?: string; referer?: string }
        if (!payload) throw new Error(`server "${server.name}" carries no resolvable payload`)

        const html = /^https?:\/\//i.test(payload)
            ? await ctx.text(payload, { headers: referer ? { Referer: referer } : {} })
            : this.decodeBase64(payload)

        const $ = parse(html)
        const iframe = attrOf($(this.sel.playerIframe).first(), "src")
        if (iframe) return absoluteUrl(iframe, ctx.baseUrl)

        const meta = attrOf($("meta[itemprop=embedUrl][content]").first(), "content")
        if (meta) return absoluteUrl(meta, ctx.baseUrl)

        throw new Error(`no embed URL found for server "${server.name}"`)
    }

    // ------------------------------------------------------------ helpers

    protected decodeBase64(value: string): string {
        try {
            return atob(value)
        } catch {
            throw new Error("server payload was neither a URL nor valid base64")
        }
    }

    /** Host currently configured, for logging and Referer defaults. */
    protected get primaryHost(): string {
        return this.domains[0] ?? hostOf(this.home)
    }
}
