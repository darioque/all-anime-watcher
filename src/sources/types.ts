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

/**
 * One way of naming a series: the id, and the page that groups it.
 *
 * A source normally has exactly one of these per series. Some have more — see
 * `PageInfo.aliases`.
 */
export interface SeriesIdentity {
    seriesId: string
    /** The grouping page for that id, where the source can name one. */
    seriesUrl?: string
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
    /**
     * Other identities *this page itself states* for the same series.
     *
     * `seriesId` above is the one identity the source picked; a page can carry
     * more than one, and which one the library holds depends on where the series
     * was added from. A myanime.live post is titled in English and tagged with
     * the romanised Chinese name, so the same episode is both
     * "a-record-of-a-mortals-journey-to-immortality" and
     * "fan-ren-xiu-xian-chuan" — nothing about either string suggests the other.
     *
     * These are matched exactly, never fuzzily, which is what makes them safe to
     * consult before `sameSeries`: the page is not being guessed about, it is
     * being read. List every id the page names; the picked one may repeat.
     */
    aliases?: SeriesIdentity[]
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

/**
 * Whether an episode page has anything behind it yet.
 *
 * `pending` is the site saying "posted, but not watchable": a countdown widget
 * where the player goes, a premium early-access window, a placeholder created
 * ahead of the release. `reason` is for the log and the UI and is never acted on.
 */
export interface EpisodeAvailability {
    pending: boolean
    reason?: string
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

    /**
     * Do two of *this source's* series ids name the same show?
     *
     * Optional, and only worth implementing for a source that reconstructs its
     * ids rather than reading them from the site — those can hand out two ids
     * for one series depending on which page you opened, which the library then
     * reads as two series. Only the source can tell the difference between the
     * same show spelled two ways and a second season, and the cost of confusing
     * them is a merged watch history, so nothing generic may guess at it.
     *
     * Consulted only after an exact id match and a series-URL match have both
     * failed. See `library/identity.ts`.
     */
    sameSeries?(a: string, b: string): boolean

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

    /**
     * Does this episode page actually offer something to watch?
     *
     * Optional, and deliberately separate from `isEpisodePage`, which these
     * pages pass: the post is a real episode page, complete with a server list.
     * Every server on it resolves to nothing, which the update loop cannot see —
     * it never opens an episode page at all, it reads the series list, where a
     * placeholder is indistinguishable from a release.
     *
     * Answered from the episode page's own HTML, so verification costs one
     * request per candidate rather than one per server. Only implement it where
     * the site has a marker that means this and nothing else; a source that
     * cannot tell must not guess, because the cost of a false positive is an
     * episode that is never announced at all.
     */
    episodeAvailability?(html: string, url: string): EpisodeAvailability
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
