import type { Episode } from "~/model/types"
import type {
    AnimeSource,
    DomainSource,
    EpisodeAvailability,
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

    /**
     * How this site's *episode page* says "posted, but there is nothing to
     * watch yet", read when the viewer opens one.
     *
     * Opt-in, and it has to be: the fallback test is "the player container
     * holds no embed", which is only evidence on a site that inlines its player
     * into the page. A site that builds the player in JavaScript would have
     * every episode declared pending. Say nothing and the check never runs.
     *
     * Separate from `backdatedPlaceholders`, which answers the same question
     * about the *series list* — see `parseEpisodes`. A site with the habit
     * usually wants both: the list rule keeps the post from ever being
     * announced, and this one explains the empty player to somebody who
     * navigated there anyway.
     */
    pending?: PendingMarkers

    /**
     * This site dates a post it cannot play yet to a month gone by, rather than
     * to the day it posted it.
     *
     * Note what this does *not* say: where the post lands in the list. That was
     * the first reading of the habit and it was wrong — the placeholder sorts
     * to the bottom only while the series is young enough that nothing real is
     * older, and stops doing so the moment it is not. What holds is the shape
     * of the date. See `parseEpisodes` for the two conditions and why they are
     * narrow.
     *
     * Dropped during list parsing, so it costs nothing and no caller ever sees
     * it — not the update loop, not the Lab, not the probe.
     */
    backdatedPlaceholders?: boolean

    netRequest?: NetRequestConfig | null
    domainSource?: DomainSource
}

/**
 * The evidence that an episode post has nothing behind it.
 *
 * Both lists are checked against the player container only, never the whole
 * page: the phrase "coming soon" appears in a sidebar widget on half these
 * sites, and matching it there would suppress real episodes.
 *
 * A match is necessary but not sufficient — `episodeAvailability` also requires
 * that no embed was found. A site is free to run a countdown to the *next*
 * episode above a player that works, and that page is not pending.
 */
export interface PendingMarkers {
    /** Selectors, resolved inside the player container. */
    markers?: string[]
    /** Case-insensitive substrings of the player container's text. */
    text?: string[]
    /**
     * How to describe this to the viewer, as the tail of "This episode isn't out
     * yet — …". The selector that matched is not it: it goes in the debug log,
     * where a CSS string is evidence, and never on screen, where it is noise.
     */
    reason?: string
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
    /** The player's own box, which is where a "not yet" notice replaces it. */
    playerContainer: string
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
    playerIframe: "iframe[src]",
    playerContainer: "div.player-embed"
}

const DEFAULT_EPISODE_URL = /^\/[^/]+-episode-[\d.]+\/?$/
const DEFAULT_EPISODE_SUFFIX = /-episode-[\d.]+(?:-[a-z0-9-]*)?$/i

/**
 * Is this timestamp the first day of a month?
 *
 * Half the test for a backdated placeholder — see `parseEpisodes`.
 *
 * Both readings count, because the answer must not depend on where the viewer
 * is. `looseDate` hands `Date.parse` whatever the site wrote, and that fixes
 * the zone: "August 1, 2026" is local midnight, while an ISO "2026-08-01" is
 * UTC midnight and reads as July 31 anywhere west of Greenwich. Accepting
 * either widens this half by one day boundary, which the other half — the entry
 * must also be strictly older than the newest post — is there to catch.
 */
function firstOfMonth(at: number): boolean {
    const date = new Date(at)
    return date.getDate() === 1 || date.getUTCDate() === 1
}

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
    protected readonly pendingMarkers: PendingMarkers | null
    protected readonly backdatedPlaceholders: boolean
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
        this.pendingMarkers = config.pending ?? null
        this.backdatedPlaceholders = config.backdatedPlaceholders ?? false
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

        /*
         * Drop a post the site made before it had the episode. It is not an
         * episode, so it does not leave this method and nothing downstream is
         * ever told it existed.
         *
         * `backdatedPlaceholders` sites date such a post to the first day of a
         * month gone by, rather than to the day they posted it. Both conditions
         * are needed and the conjunction is the whole safety of it: the entry
         * must be the highest-numbered, strictly older than the newest post in
         * the list, *and* dated to a first of the month. Each half covers the
         * other's false positive — a late re-upload or a corrected typo lands
         * out of order but on a real day, and a real episode does sometimes
         * come out on the 1st, but then it is the newest post and not out of
         * order at all.
         *
         * Anything less certain keeps the episode: a tie for newest (this list
         * carries no clock, so a same-day double release ties), a list where
         * only some posts carry dates. Dropping a real episode is silent, and
         * listing a countdown costs a notification the viewer dismisses.
         *
         * One entry, never a sweep. Sites with the habit have only ever been
         * seen posting one placeholder at a time, and a second pass could only
         * ever remove an episode nothing has been observed to do.
         */
        const dated = episodes.filter(episode => episode.airedAt !== undefined)
        if (this.backdatedPlaceholders && dated.length > 1 && dated.length === episodes.length) {
            const newest = episodes.reduce((a, b) => (b.number > a.number ? b : a))
            const newestAt = Math.max(...dated.map(episode => episode.airedAt!))

            if (newest.airedAt! < newestAt && firstOfMonth(newest.airedAt!)) {
                episodes.splice(episodes.indexOf(newest), 1)
            }
        }

        this.logger.debug(`${episodes.length} episodes from ${baseUrl}`)
        return episodes
    }

    // ------------------------------------------------------------ page context

    isEpisodePage(html: string, url: string): boolean {
        if (!this.matchesPath(this.episodeUrl, url)) return false
        return parse(html)(this.sel.server).length > 0
    }

    /**
     * Is there a video behind this episode post, or only a promise of one?
     *
     * Asked when the viewer opens the page, off HTML already in hand, so it
     * costs nothing: it decides whether opening counts as watching, and gives
     * the player something to say instead of an empty frame. The series list is
     * a separate question with its own answer — `backdatedPlaceholders`.
     *
     * Only answered where the site declared how it says so — see `pending` on
     * the config for why guessing is not an option here.
     *
     * The two clauses are ordered on purpose, and the order is the whole test:
     *
     *  1. **An embed wins outright.** If the player container holds an iframe,
     *     or the page carries `meta[itemprop=embedUrl]`, the episode is
     *     watchable and no notice on the page changes that. This is what keeps a
     *     countdown *to the next episode*, sitting above a player that works,
     *     from suppressing the episode you are actually on.
     *  2. **Then, and only then, the marker.** An empty player container is
     *     suggestive but not conclusive — a theme change or a selector that
     *     drifted looks identical — so something has to positively say "not
     *     yet". Requiring both means a broken selector degrades to "announced as
     *     usual", which is the old behaviour, rather than to a source that
     *     silently stops reporting episodes.
     */
    episodeAvailability(html: string, url: string): EpisodeAvailability {
        const declared = this.pendingMarkers
        if (!declared) return { pending: false }

        const $ = parse(html)
        const $container = $(this.sel.playerContainer)

        const embed =
            attrOf($container.find("iframe[src]").first(), "src") ??
            attrOf($(this.sel.playerIframe).first(), "src") ??
            attrOf($("meta[itemprop=embedUrl][content]").first(), "content")
        if (embed) return { pending: false }

        const reason = declared.reason ?? "the site has posted the page but not the video"

        for (const marker of declared.markers ?? []) {
            if ($container.find(marker).length > 0) {
                this.logger.debug(`pending — "${marker}" stands where the player goes on ${url}`)
                return { pending: true, reason }
            }
        }

        const text = $container.text().toLowerCase()
        for (const phrase of declared.text ?? []) {
            if (text.includes(phrase.toLowerCase())) {
                this.logger.debug(`pending — the player box reads "${phrase}" on ${url}`)
                return { pending: true, reason }
            }
        }

        return { pending: false }
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
