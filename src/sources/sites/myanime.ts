import type { Episode } from "~/model/types"
import type { AnimeSource, FetchCtx, PageInfo, SearchResult, SeriesInfo, Server } from "~/sources/types"
import { attrOf, parse } from "~/sources/html"
import { absoluteUrl, hostOf, pathOf } from "~/shared/url"
import { log } from "~/shared/logger"

const logger = log("source:myanime")

/**
 * myanime.live — a WordPress blog where each post *is* an episode.
 *
 * There are no series pages. A series is a **tag**, and its episodes are the
 * posts carrying that tag, so this source maps:
 *
 *   series   → /tag/<slug>/            seriesId is the tag slug
 *   episode  → /YYYY/MM/DD/<post>/     number parsed from the post title
 *
 * The WordPress REST API is open, so search and episode lists go through
 * `/wp-json/wp/v2/` rather than scraping — proper pagination, no selectors to
 * break, and two requests instead of a 300KB page fetch.
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
     * Only a tag URL carries the series identity. An episode's URL is a dated
     * post slug that does not contain the tag, so identity for those comes from
     * `getPageInfo`, which can read the post's own tags off the page.
     */
    seriesIdFromUrl(url: string): string | null {
        return /^\/tag\/([^/]+)/.exec(pathOf(url))?.[1] ?? null
    }

    episodeNumberFromUrl(url: string): number | null {
        const match = /episode[-\s]*(\d+(?:\.\d+)?)/i.exec(pathOf(url))
        return match?.[1] ? Number.parseFloat(match[1]) : null
    }

    // ------------------------------------------------------------ discovery

    async search(query: string, ctx: FetchCtx): Promise<SearchResult[]> {
        const tags = await ctx.json<WpTag[]>(
            `${ctx.baseUrl}/wp-json/wp/v2/tags?search=${encodeURIComponent(query)}&per_page=20`
        )

        // Tags with no posts are leftovers from deleted content.
        return tags
            .filter(tag => tag.count > 0)
            .map(tag => ({
                title: decodeEntities(tag.name),
                url: `${ctx.baseUrl}/tag/${tag.slug}/`,
                seriesId: tag.slug
            }))
    }

    async getSeries(seriesUrl: string, ctx: FetchCtx): Promise<SeriesInfo> {
        const seriesId = this.seriesIdFromUrl(seriesUrl)
        if (!seriesId) throw new Error(`not a series URL: ${seriesUrl}`)

        const tag = await this.tagBySlug(seriesId, ctx)

        return {
            title: tag ? decodeEntities(tag.name) : seriesId,
            seriesId,
            url: seriesUrl,
            poster: await this.posterFor(tag?.id, ctx),
            status: "unknown"
        }
    }

    async getEpisodes(seriesUrl: string, ctx: FetchCtx): Promise<Episode[]> {
        const seriesId = this.seriesIdFromUrl(seriesUrl)
        if (!seriesId) throw new Error(`not a series URL: ${seriesUrl}`)

        const tag = await this.tagBySlug(seriesId, ctx)
        if (!tag) {
            logger.warn(`no tag matches "${seriesId}"`)
            return []
        }

        const posts = await ctx.json<WpPost[]>(
            `${ctx.baseUrl}/wp-json/wp/v2/posts?tags=${tag.id}&per_page=100&_fields=link,title,date`
        )

        const episodes: Episode[] = []
        for (const post of posts) {
            const title = decodeEntities(post.title?.rendered ?? "")
            // The number lives in the title; the slug is a fallback for posts
            // titled inconsistently.
            const number =
                Number.parseFloat(/episode[\s-]*(\d+(?:\.\d+)?)/i.exec(title)?.[1] ?? "") ||
                this.episodeNumberFromUrl(post.link)
            if (number === null || !Number.isFinite(number)) continue

            const airedAt = Date.parse(post.date ?? "")
            episodes.push({
                number,
                url: post.link,
                variant: "sub",
                ...(Number.isFinite(airedAt) ? { airedAt } : {})
            })
        }

        episodes.sort((a, b) => b.number - a.number)
        logger.debug(`${episodes.length} episodes for tag ${tag.slug}`)
        return episodes
    }

    // ------------------------------------------------------------ page context

    isEpisodePage(html: string, url: string): boolean {
        if (!new RegExp(this.episodeUrl.source).test(pathOf(url))) return false
        return this.videoIframes(html, url).length > 0
    }

    async getPageInfo(html: string, url: string, ctx: FetchCtx): Promise<PageInfo> {
        const $ = parse(html)

        /*
         * A post carries its own tags as rel="tag" links; the sidebar tag cloud
         * uses a different class and no rel, so this picks out exactly the post's
         * tags. Which of them is the *series* is a judgement call — a post tagged
         * "Wang Lin, Xian Ni" names its protagonist and its show — so prefer the
         * tag whose slug prefixes the post slug, which is how this site names
         * episode posts.
         */
        const tags: { slug: string; name: string }[] = []
        $("a[rel=tag]").each((_, element) => {
            const href = attrOf($(element), "href")
            const slug = href ? /\/tag\/([^/]+)/.exec(href)?.[1] : undefined
            if (slug) tags.push({ slug, name: $(element).text().trim() })
        })

        const postSlug = pathOf(url).split("/").filter(Boolean).at(-1) ?? ""
        const chosen = tags.find(tag => postSlug.startsWith(tag.slug)) ?? tags.at(-1) ?? tags[0]
        if (!chosen) throw new Error(`no tags on ${url}, so the series can't be identified`)

        const pageTitle = $("h1.entry-title").first().text().trim() || $("title").first().text().trim()
        const number =
            Number.parseFloat(/episode[\s-]*(\d+(?:\.\d+)?)/i.exec(pageTitle)?.[1] ?? "") ||
            this.episodeNumberFromUrl(url)
        if (number === null || !Number.isFinite(number)) {
            throw new Error(`could not read an episode number from ${url}`)
        }

        return {
            title: chosen.name || chosen.slug,
            seriesId: chosen.slug,
            seriesUrl: `${ctx.baseUrl}/tag/${chosen.slug}/`,
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

    /** Iframes that are players, not comment widgets or ads. */
    private videoIframes(html: string, url: string): string[] {
        const ignored = /jetpack|wordpress\.com|disqus|google|doubleclick|facebook|twitter/i
        const $ = parse(html)
        const found: string[] = []

        $("iframe[src]").each((_, element) => {
            const src = attrOf($(element), "src")
            if (!src || ignored.test(src)) return
            found.push(absoluteUrl(src, url))
        })

        return [...new Set(found)]
    }

    private async tagBySlug(slug: string, ctx: FetchCtx): Promise<WpTag | undefined> {
        const tags = await ctx.json<WpTag[]>(`${ctx.baseUrl}/wp-json/wp/v2/tags?slug=${encodeURIComponent(slug)}`)
        return tags[0]
    }

    /** The newest post's featured image stands in for a series poster. */
    private async posterFor(tagId: number | undefined, ctx: FetchCtx): Promise<string | undefined> {
        if (tagId === undefined) return undefined
        try {
            const posts = await ctx.json<WpPost[]>(
                `${ctx.baseUrl}/wp-json/wp/v2/posts?tags=${tagId}&per_page=1&_embed=wp:featuredmedia`
            )
            return posts[0]?._embedded?.["wp:featuredmedia"]?.[0]?.source_url
        } catch {
            // A missing poster is cosmetic; never fail a series over it.
            return undefined
        }
    }
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
    date?: string
    title?: { rendered?: string }
    _embedded?: { "wp:featuredmedia"?: { source_url?: string }[] }
}

export const myanime = new MyAnime()
