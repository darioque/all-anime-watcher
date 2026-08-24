import type { Episode } from "~/model/types"
import type { AnimeSource, FetchCtx, PageInfo, SearchResult, SeriesInfo, Server } from "~/sources/types"
import { attrOf, parse } from "~/sources/html"
import { absoluteUrl, fragmentOf, hostOf, pathOf, samePath } from "~/shared/url"
import { log } from "~/shared/logger"
import {
    numberPosts,
    searchQueryFor,
    searchQueryFromUrl,
    sameSeries,
    seriesSlugOf,
    seriesTitleOf,
    slugify,
    statedNumber,
    type PostLike
} from "./myanime.parse"

const logger = log("source:myanime")

/** WordPress caps `per_page` here, whatever you ask for. */
const PER_PAGE = 100

/**
 * How many pages of results one series will pull. A 500-episode donghua is real;
 * a search that matches thousands of posts is a query gone wrong, and paging
 * through all of it would hammer a site that already rate-limits hard.
 */
const MAX_PAGES = 8

/**
 * myanime.live — a WordPress blog where each post *is* an episode.
 *
 * There are no series pages, so a "series" is whatever groups posts together.
 * The site does not group them one way, it groups them four ways, and which one
 * is available depends on how nervous it was about the rights holder:
 *
 *   1. an "All Episodes" button in the post, linking to `/?s=<query>` — the
 *      site's own grouping, and the only one that works for posts it has
 *      deliberately stripped of a title;
 *   2. the post slug, minus its episode marker
 *      ("wan-jie-du-zun-…-episode-476-english-sub" → "wan-jie-du-zun-…");
 *   3. the post title, same cut, which is where the display name comes from;
 *   4. the post's tags — the original approach, and the least reliable of the
 *      four: plenty of posts carry none, and where they do the tag is as likely
 *      to name the protagonist ("Lin Feng") as the show.
 *
 * Episode lists come from `/wp-json/wp/v2/` — proper pagination, no selectors to
 * break. The tag path is kept because entries added before this rework are keyed
 * by tag slug, and it is still the better list where a tag really does cover a
 * whole series.
 *
 * Verified live 2026-08-24. Episodes embed Dailymotion and OK.ru, both of which
 * already have extractors.
 */
export class MyAnime implements AnimeSource {
    readonly id = "myanime"
    readonly name = "MyAnime"
    readonly languages = ["en"]
    readonly domains = ["myanime.live"]
    readonly home = "https://myanime.live/"

    readonly episodeUrl = /^\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/?$/
    readonly seriesUrl = /^\/tag\/[^/]+\/?$/

    /**
     * Works for a tag URL, a `/?s=` grouping URL and — since the slug carries the
     * series name — most episode URLs too. It returns null for the untitled
     * posts, whose identity only `getPageInfo` can reach, because it can read the
     * "All Episodes" link out of the body.
     */
    seriesIdFromUrl(url: string): string | null {
        // Pinned by groupingUrlFor when the search query is deliberately broader
        // than the series name.
        const pinned = /(?:^|[#&])aaw=([^&]+)/.exec(fragmentOf(url))?.[1]
        if (pinned) return decodeURIComponent(pinned)

        const tag = /^\/tag\/([^/]+)/.exec(pathOf(url))?.[1]
        if (tag) return tag

        const query = searchQueryFromUrl(url)
        if (query) return slugify(query)

        const postSlug = pathOf(url).split("/").filter(Boolean).at(-1) ?? ""
        return seriesSlugOf(postSlug)
    }

    episodeNumberFromUrl(url: string): number | null {
        const postSlug = pathOf(url).split("/").filter(Boolean).at(-1) ?? ""
        return statedNumber(postSlug)
    }

    // ------------------------------------------------------------ discovery

    /**
     * Search posts rather than tags. Tags miss whole series and misname others,
     * and the post list is the same data the episode lists come from, so what you
     * find here is what you can actually follow.
     */
    async search(query: string, ctx: FetchCtx): Promise<SearchResult[]> {
        const posts = await this.posts(ctx, { search: query }, 1, true)

        const bySeries = new Map<string, SearchResult>()
        for (const post of posts) {
            const seriesId = seriesSlugOf(post.slug)
            if (!seriesId || bySeries.has(seriesId)) continue

            const title = seriesTitleOf(post.title) ?? seriesId.replace(/-/g, " ")
            bySeries.set(seriesId, {
                title,
                url: this.groupingUrlFor(ctx, seriesId, title),
                seriesId,
                ...(post.poster ? { poster: post.poster } : {})
            })
        }

        return [...bySeries.values()]
    }

    async getSeries(seriesUrl: string, ctx: FetchCtx): Promise<SeriesInfo> {
        const seriesId = this.seriesIdFromUrl(seriesUrl)
        if (!seriesId) throw new Error(`not a series URL: ${seriesUrl}`)

        const query = searchQueryFromUrl(seriesUrl)
        const posts = await this.postsForSeries(seriesUrl, ctx)

        // The newest post is the best source of both: its title still names the
        // series, and its featured image is a frame from the show. The bulk list
        // is fetched without featured media — it would be a hundred times the
        // payload for one image — so the poster costs one extra request.
        const newest = [...posts].sort((a, b) => b.date - a.date)[0]
        const poster = newest ? await this.posterFor(newest.slug, ctx) : undefined

        return {
            title: (newest ? seriesTitleOf(newest.title) : null) ?? query ?? seriesId.replace(/-/g, " "),
            seriesId,
            url: seriesUrl,
            ...(poster ? { poster } : {}),
            status: "unknown"
        }
    }

    async getEpisodes(seriesUrl: string, ctx: FetchCtx): Promise<Episode[]> {
        const posts = await this.postsForSeries(seriesUrl, ctx)
        const numbered = numberPosts(posts)

        const inferred = numbered.filter(post => post.inferred).length
        const dropped = posts.length - numbered.length
        if (inferred > 0 || dropped > 0) {
            logger.info(
                `${seriesUrl}: ${numbered.length} episodes ` +
                    `(${inferred} numbered by position, ${dropped} unnumberable and skipped)`
            )
        }

        return numbered.map(post => ({
            number: post.number,
            url: post.link,
            variant: "sub",
            ...(post.inferred ? { title: `Episode ${post.number} (numbered by posting order)` } : {}),
            ...(Number.isFinite(post.date) ? { airedAt: post.date } : {})
        }))
    }

    // ------------------------------------------------------------ page context

    isEpisodePage(html: string, url: string): boolean {
        if (!new RegExp(this.episodeUrl.source).test(pathOf(url))) return false
        return this.videoIframes(html, url).length > 0
    }

    async getPageInfo(html: string, url: string, ctx: FetchCtx): Promise<PageInfo> {
        const $ = parse(html)

        const postSlug = pathOf(url).split("/").filter(Boolean).at(-1) ?? ""
        const pageTitle = this.postTitle($)

        /*
         * The site's own "All Episodes" button, which points at the search that
         * gathers this series. It is the only identity available on a post the
         * site has stripped of title, slug and tags, and where it exists it beats
         * anything derived, because it is what the site itself groups by.
         */
        const allEpisodes = this.allEpisodesQuery($, url)

        const fromSlug = seriesSlugOf(postSlug)
        const fromTitle = seriesTitleOf(pageTitle)
        const tag = this.postTags($).find(candidate => postSlug.startsWith(candidate.slug))

        const seriesId = fromSlug ?? (allEpisodes ? slugify(allEpisodes) : null) ?? tag?.slug ?? null
        if (!seriesId) {
            throw new Error(
                `${url} carries no title, slug, tag or "All Episodes" link, so there is nothing to group it by`
            )
        }

        const title = fromTitle ?? allEpisodes ?? tag?.name ?? seriesId.replace(/-/g, " ")
        const seriesUrl =
            fromSlug || allEpisodes
                ? // The site's own "All Episodes" query first: it is tuned for
                  // recall across however many ways the site has titled this
                  // series over the years, which the current title is not.
                  this.groupingUrlFor(ctx, seriesId, allEpisodes ?? fromTitle ?? undefined)
                : `${ctx.baseUrl}/tag/${seriesId}/`

        let number = statedNumber(pageTitle) ?? statedNumber(postSlug)

        /*
         * An untitled post states nothing at all. Its number can still be
         * recovered from where it sits among its siblings — see numberPosts — but
         * only by fetching them, so this stays the last resort rather than the
         * first move.
         */
        if (number === null) {
            logger.debug(`${url}: no episode number on the page, recovering it from the series' post order`)
            const episodes = await this.getEpisodes(seriesUrl, ctx)
            number = episodes.find(episode => samePath(episode.url, url))?.number ?? null
        }

        if (number === null || !Number.isFinite(number)) {
            throw new Error(`could not work out which episode ${url} is`)
        }

        return {
            title,
            seriesId,
            seriesUrl,
            number,
            variant: "sub",
            episodeUrl: url
        }
    }

    async getServers(html: string, url: string, _ctx: FetchCtx): Promise<Server[]> {
        return this.videoIframes(html, url).map(embedUrl => ({
            // The page doesn't label its players, so name them by host — which is
            // what the viewer is actually choosing between anyway.
            name: hostOf(embedUrl).replace(/^(www|geo)\./, ""),
            variant: "sub",
            embedUrl
        }))
    }

    // ------------------------------------------------------------ helpers

    /** `/?s=<query>` — a real, browsable page on the site, not a synthetic URL. */
    private groupingUrl(ctx: FetchCtx, query: string): string {
        return `${ctx.baseUrl}/?s=${encodeURIComponent(query)}`
    }

    /**
     * A grouping URL that reads back as the same series id.
     *
     * The best query and the series id are often not the same words. The site
     * groups "Wan Jie Du Zun – Ten Thousand Worlds" under a search for "Wan Jie
     * Du Zun", because its older posts were titled without the second half —
     * searching the full title finds 121 of its 180 episodes, and searching the
     * short one finds all of them. So the query has to stay broad while the id
     * stays specific enough to filter the results.
     *
     * When the two disagree the id is pinned in the fragment, which the site
     * never sees and a browser never sends.
     */
    private groupingUrlFor(ctx: FetchCtx, seriesId: string, preferred?: string): string {
        const query = searchQueryFor(seriesId, preferred)
        const url = this.groupingUrl(ctx, query)
        return slugify(query) === seriesId ? url : `${url}#aaw=${seriesId}`
    }

    /**
     * The post's own heading. The theme calls it `entry-header-title`, but it has
     * been renamed before, so this falls back through the metadata the post also
     * carries — one of the four never goes missing at once.
     */
    private postTitle($: ReturnType<typeof parse>): string {
        const heading = $("h1.entry-header-title, h1.entry-title, h1.post-title").first().text().trim()
        if (heading !== "") return heading

        const og = $('meta[property="og:title"]').attr("content")?.trim()
        if (og) return og

        // The document title carries the site name; the heading does not.
        return $("title")
            .first()
            .text()
            .replace(/\s*[-|–]\s*(My\s*Anime|myanime\.live).*$/i, "")
            .trim()
    }

    /** Iframes that are players, not comment widgets or ads. */
    private videoIframes(html: string, url: string): string[] {
        const ignored = /jetpack|wordpress\.com|wp\.com|disqus|google|doubleclick|facebook|twitter/i
        const $ = parse(html)
        const found: string[] = []

        $("iframe[src]").each((_, element) => {
            const src = attrOf($(element), "src")
            if (!src || ignored.test(src)) return
            found.push(absoluteUrl(src, url))
        })

        return [...new Set(found)]
    }

    /** The post's own tags — `rel="tag"` links, which the sidebar cloud lacks. */
    private postTags($: ReturnType<typeof parse>): { slug: string; name: string }[] {
        const tags: { slug: string; name: string }[] = []
        $("a[rel=tag]").each((_, element) => {
            const href = attrOf($(element), "href")
            const slug = href ? /\/tag\/([^/]+)/.exec(href)?.[1] : undefined
            if (slug) tags.push({ slug, name: $(element).text().trim() })
        })
        return tags
    }

    /** The `?s=` query behind the post's "All Episodes" button, if it has one. */
    private allEpisodesQuery($: ReturnType<typeof parse>, url: string): string | null {
        let found: string | null = null
        $("a[href*='?s=']").each((_, element) => {
            if (found) return
            const href = attrOf($(element), "href")
            if (!href) return
            // The theme's own search form lands on the same shape; only links
            // inside the post body carry a series query.
            const query = searchQueryFromUrl(absoluteUrl(href, url))
            if (query) found = query
        })
        return found
    }

    /**
     * Every post belonging to a series, from whichever groupings are available.
     *
     * Tag results are authoritative when there are any — a tag that covers the
     * series covers it completely. Search results need filtering, because the
     * query behind a series ("Wan Jie Du Zun") also matches posts that merely
     * mention it; a post is kept when its own slug names the same series.
     *
     * The two are combined rather than ranked: tags on this site are applied
     * inconsistently, so the tag list is often a strict subset of the search, and
     * the search alone misses nothing the tag has.
     */
    private async postsForSeries(seriesUrl: string, ctx: FetchCtx): Promise<WpPostView[]> {
        const seriesId = this.seriesIdFromUrl(seriesUrl)
        if (!seriesId) throw new Error(`not a series URL: ${seriesUrl}`)

        const tagSlug = /^\/tag\/([^/]+)/.exec(pathOf(seriesUrl))?.[1]
        const tag = tagSlug ? await this.tagBySlug(tagSlug, ctx) : undefined

        const tagPosts = tag ? await this.posts(ctx, { tags: String(tag.id) }) : []

        const query = searchQueryFromUrl(seriesUrl) ?? searchQueryFor(seriesId)
        const searchPosts = await this.posts(ctx, { search: query })

        /*
         * A tag named after a character tells us nothing by itself, but the posts
         * carrying it do: whatever slug most of them share is the name the site
         * files this series under, which finds the episodes the tag was never
         * applied to.
         */
        const dominant = mostCommon(tagPosts.map(post => seriesSlugOf(post.slug)))
        const wanted = [seriesId, ...(dominant ? [dominant] : [])]

        /*
         * A post whose slug names a *different* series is noise from a broad
         * query and goes. A post whose slug names no series at all stays: those
         * are the untitled ones, and the only reason a full-text search reached
         * one is that its body carries this series' own "All Episodes" link.
         * Dropping them lost exactly the newest episodes of the series that need
         * this treatment most.
         */
        const strict = searchPosts.filter(post => {
            const slug = seriesSlugOf(post.slug)
            return slug === null || wanted.some(candidate => sameSeries(candidate, slug))
        })

        /*
         * Nothing matched strictly and there is no tag: this is a series the site
         * publishes untitled, so no post can name it and the query — a code the
         * site invented for exactly this purpose — is the only grouping there is.
         */
        const pool = tagPosts.length > 0 || strict.length > 0 ? [...tagPosts, ...strict] : searchPosts

        const byLink = new Map<string, WpPostView>()
        for (const post of pool) byLink.set(post.link, post)
        return [...byLink.values()]
    }

    /**
     * Paginated `/wp-json/wp/v2/posts`, flattened to what identity needs.
     *
     * `_fields` is not an optimisation here: without it a 500-episode series
     * means half a megabyte of rendered post bodies per page, and this site
     * rate-limits hard enough to time out over it. Featured images are asked for
     * only where one is actually going to be shown.
     */
    private async posts(
        ctx: FetchCtx,
        params: Record<string, string>,
        maxPages = MAX_PAGES,
        withPoster = false
    ): Promise<WpPostView[]> {
        const collected: WpPostView[] = []

        for (let page = 1; page <= maxPages; page++) {
            const query = new URLSearchParams({
                ...params,
                per_page: String(PER_PAGE),
                page: String(page),
                // `_embed` needs `_links` in the response, so the two are
                // mutually exclusive with a narrow `_fields`.
                ...(withPoster ? { _embed: "wp:featuredmedia" } : { _fields: "link,slug,title,date" })
            })

            let batch: WpPost[]
            try {
                batch = await ctx.json<WpPost[]>(`${ctx.baseUrl}/wp-json/wp/v2/posts?${query}`)
            } catch (error) {
                // WordPress answers HTTP 400 for a page past the end, which is a
                // normal way for this loop to finish rather than a failure.
                if (page > 1) break
                throw error
            }

            if (!Array.isArray(batch)) break
            for (const post of batch) {
                collected.push({
                    slug: post.slug ?? "",
                    title: decodeEntities(post.title?.rendered ?? ""),
                    date: Date.parse(post.date ?? ""),
                    link: post.link,
                    poster: post._embedded?.["wp:featuredmedia"]?.[0]?.source_url
                })
            }

            if (batch.length < PER_PAGE) break
        }

        return collected
    }

    /** One post's featured image, standing in for a series poster. */
    private async posterFor(slug: string, ctx: FetchCtx): Promise<string | undefined> {
        try {
            const posts = await this.posts(ctx, { slug }, 1, true)
            return posts[0]?.poster
        } catch {
            // A missing poster is cosmetic; never fail a series over it.
            return undefined
        }
    }

    private async tagBySlug(slug: string, ctx: FetchCtx): Promise<WpTag | undefined> {
        try {
            const tags = await ctx.json<WpTag[]>(`${ctx.baseUrl}/wp-json/wp/v2/tags?slug=${encodeURIComponent(slug)}`)
            return tags[0]
        } catch {
            return undefined
        }
    }
}

interface WpPostView extends PostLike {
    link: string
    poster?: string
}

/** The value that appears most often, ignoring nulls. Ties go to the first seen. */
function mostCommon(values: (string | null)[]): string | null {
    const counts = new Map<string, number>()
    for (const value of values) {
        if (value === null) continue
        counts.set(value, (counts.get(value) ?? 0) + 1)
    }

    let best: string | null = null
    let bestCount = 0
    for (const [value, count] of counts) {
        if (count > bestCount) {
            best = value
            bestCount = count
        }
    }
    return best
}

/** WordPress renders titles with HTML entities: "Xian Ni &#8211; Renegade Immortal". */
function decodeEntities(value: string): string {
    return value
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .trim()
}

interface WpTag {
    id: number
    name: string
    slug: string
    count: number
}

interface WpPost {
    link: string
    slug?: string
    date?: string
    title?: { rendered?: string }
    _embedded?: { "wp:featuredmedia"?: { source_url?: string }[] }
}

export const myanime = new MyAnime()
