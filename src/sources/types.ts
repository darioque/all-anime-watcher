import type { Episode, Variant } from "~/model/types"

/** A search or browse hit. */
export interface SearchResult {
    title: string
    /** Series page URL. */
    url: string
    seriesId: string
    poster?: string
}

/** Metadata for a series page, beyond the episode list. */
export interface SeriesInfo {
    title: string
    seriesId: string
    url: string
    poster?: string
    description?: string
    genres?: string[]
    status?: "airing" | "completed" | "unknown"
    /** Alternate titles, used to improve tracker matching. */
    altTitles?: string[]
}

/** What the content script learned by being on the page. */
export interface PageInfo {
    /** Series title as shown on the episode page. */
    title: string
    seriesId: string
    /** Absolute URL of the series page this episode belongs to. */
    seriesUrl: string
    /** The episode being watched. */
    number: number
    variant?: Variant
    episodeUrl: string
}

/**
 * One playback option offered by the episode page.
 *
 * Sites present these as "servers" or "mirrors". The name is usually a label the
 * site chose ("English", "Multisub", "Server 2") rather than the actual video
 * host — the host is only known once `embedUrl` is resolved, which is why
 * resolution is deferred: a page may list eight servers and the user watches one.
 */
export interface Server {
    /** User-facing label, and the key for server preference ordering. */
    name: string
    variant?: Variant
    /** Present when the page exposed the embed URL directly. */
    embedUrl?: string
    /**
     * Opaque payload for `resolveServer` when a second request is needed.
     * Must be structured-cloneable: it crosses the message boundary.
     */
    resolve?: unknown
}

/** A resolved server, when the site tells us more than just the URL. */
export interface ResolvedServer {
    embedUrl: string
    /** Seconds from the start of the episode. */
    skips?: { intro?: { startSec: number; endSec: number }; outro?: { startSec: number; endSec: number } }
}

export interface FetchCtx {
    /** Fetch a page as text, following the source's own escalation rules. */
    text(url: string, init?: SourceRequestInit): Promise<string>
    /** Fetch and parse JSON. */
    json<T = unknown>(url: string, init?: SourceRequestInit): Promise<T>
    /** The origin currently believed live for this source, with no trailing slash. */
    baseUrl: string
    /** Tab that triggered this work, when there is one. Lets a source fetch in page context. */
    tabId?: number
}

export interface SourceRequestInit {
    method?: "GET" | "POST"
    headers?: Record<string, string>
    body?: BodyInit
    /** Milliseconds; defaults to the source's own timeout. */
    timeoutMs?: number
    /** Skip the HTTP cache. */
    noCache?: boolean
}

/** Referer/Origin rewriting installed as a declarativeNetRequest rule. */
export interface NetRequestConfig {
    /** Value used for both Referer and Origin. */
    mainUrl: string
    urlFilter?: string
    regexFilter?: string
}

/** An "official domains" announcement page, for sites that rotate hosts. */
export interface DomainSource {
    url: string
    /**
     * Pull candidate hosts out of the page. Defaults to every external link whose
     * hostname shares a token with the source's known domains.
     */
    extract?(html: string): string[]
}

/**
 * The site plugin. Direct heir to AMR's MirrorImplementation, split so that the
 * cheap, background-only method (`getEpisodes`) is separate from the expensive,
 * page-context ones (`getServers`, `resolveServer`).
 *
 * All of this runs in the background service worker: HTML arrives as a string and
 * is parsed with cheerio, so no source ever touches a real DOM.
 */
export interface AnimeSource {
    /** Stable forever. This is half the library key — renaming it orphans entries. */
    readonly id: string
    /** Display name. Safe to change. */
    readonly name: string
    /** Language codes the site serves. */
    readonly languages: string[]
    /** Known hosts, no scheme, no `www.`. Index 0 is the default preference. */
    readonly domains: string[]
    /** Full origin used as the request base, with trailing slash. */
    readonly home: string
    /** Data-URI or bundled icon. */
    readonly icon?: string

    /**
     * What this site carries, categorically, whatever the series is.
     *
     * A site that only ever publishes donghua knows something the tracker would
     * also tell us — but sooner, without a round trip, and for the many series
     * AniList has never heard of it is the only thing that ever will. Matched
     * against category *names*, so declaring "Donghua" fills the built-in shelf.
     */
    readonly categories?: string[]

    /** Matched against `pathname`. Must not carry the `g` flag. */
    readonly episodeUrl: RegExp
    /** Optional: lets the user follow a series from its own page. */
    readonly seriesUrl?: RegExp

    /** Stable series identity from either a series or an episode URL. */
    seriesIdFromUrl(url: string): string | null
    /** Episode number from a URL, when the URL carries it. */
    episodeNumberFromUrl?(url: string): number | null

    search(query: string, ctx: FetchCtx, page?: number): Promise<SearchResult[]>
    getSeries(seriesUrl: string, ctx: FetchCtx): Promise<SeriesInfo>
    /** Descending by episode number. The only method the update scheduler calls. */
    getEpisodes(seriesUrl: string, ctx: FetchCtx): Promise<Episode[]>

    /** Cheap structural check against the already-loaded page HTML. */
    isEpisodePage(html: string, url: string): boolean
    getPageInfo(html: string, url: string, ctx: FetchCtx): Promise<PageInfo>
    getServers(html: string, url: string, ctx: FetchCtx): Promise<Server[]>
    /**
     * Turn a deferred server into an embed URL. Required if any Server omits
     * embedUrl. May return extra detail — some sites hand over intro/outro
     * offsets alongside the URL, which is better data than any third party has.
     */
    resolveServer?(server: Server, ctx: FetchCtx): Promise<string | ResolvedServer>

    netRequest?(): NetRequestConfig | null
    readonly domainSource?: DomainSource

    /**
     * Remove this site's Content-Security-Policy on episode pages.
     *
     * Only set it where a CSP actually blocks the injected player's use of Media
     * Source Extensions — it is a real security relaxation on the site's own
     * pages. Most sites send no CSP at all, so leave it off until playback is
     * observed to fail with a CSP violation in the console.
     */
    readonly stripCsp?: boolean
}
