import type { Episode } from "~/model/types"
import type { AnimeSource, FetchCtx, PageInfo, SearchResult, SeriesInfo, Server } from "~/sources/types"
import { attrOf, imageUrlFrom, leadingNumber, parse } from "~/sources/html"
import { unpackAll } from "~/extractors/unpack"
import { absoluteUrl, pathOf } from "~/shared/url"
import { log } from "~/shared/logger"

const logger = log("source:mundodonghua")

const HOME = "https://www.mundodonghua.com/"

/**
 * Mundo Donghua — Spanish-subtitled donghua, custom PHP, server-rendered.
 *
 * Verified live 2026-08-24:
 *   series    /donghua/<slug>            og:title / og:image, ul.md-episode-list
 *   episode   /ver/<slug>/<n>            li.md-episode-item[data-ep] gives the number
 *   servers   packed JS, one block each  `$("#<name>_tab")` + an <iframe src>
 *   search    /busquedas/?donghua=       returns the *whole* catalogue, filtered here
 *
 * The site's own default server ("Asura") has no packed block — it is an inline
 * player we can't reach — so only the four embed-backed servers are offered.
 * Three of them are StreamWish-family and one is VOE.
 */
export class MundoDonghua implements AnimeSource {
    readonly id = "mundodonghua"
    readonly name = "Mundo Donghua"
    readonly languages = ["es"]
    readonly domains = ["mundodonghua.com"]
    readonly home = HOME

    /** `/ver/<slug>/<n>`, optionally followed by a base64 token segment. */
    readonly episodeUrl = /^\/ver\/[^/]+\/[\d.]+(\/.*)?$/
    readonly seriesUrl = /^\/donghua\/[^/]+\/?$/

    seriesIdFromUrl(url: string): string | null {
        const path = pathOf(url)
        const series = /^\/donghua\/([^/]+)/.exec(path)
        if (series?.[1]) return series[1]
        const episode = /^\/ver\/([^/]+)\//.exec(path)
        return episode?.[1] ?? null
    }

    episodeNumberFromUrl(url: string): number | null {
        const match = /^\/ver\/[^/]+\/([\d.]+)/.exec(pathOf(url))
        return match?.[1] ? Number.parseFloat(match[1]) : null
    }

    // ------------------------------------------------------------ discovery

    /**
     * The search endpoint ignores its query and returns every series, so the
     * filtering happens here. One 550KB fetch for the whole catalogue is a fair
     * trade for search that actually works.
     */
    async search(query: string, ctx: FetchCtx): Promise<SearchResult[]> {
        const $ = parse(await ctx.text(`${ctx.baseUrl}/busquedas/?donghua=${encodeURIComponent(query)}`))
        const needle = query.trim().toLowerCase()
        const results: SearchResult[] = []

        $("div.md-card a[href^='/donghua/']").each((_, element) => {
            const $a = $(element)
            const href = attrOf($a, "href")
            if (!href) return

            const url = absoluteUrl(href, ctx.baseUrl)
            const seriesId = this.seriesIdFromUrl(url)
            if (!seriesId) return

            const $img = $a.find("img").first()
            const title = $a.find(".md-card-title").first().text().trim() || attrOf($img, "alt") || seriesId
            if (needle !== "" && !title.toLowerCase().includes(needle)) return

            results.push({
                title,
                url,
                seriesId,
                poster: imageUrlFrom($img, ctx.baseUrl, $)
            })
        })

        logger.debug(`search "${query}" → ${results.length} of the full catalogue`)
        return results
    }

    async getSeries(seriesUrl: string, ctx: FetchCtx): Promise<SeriesInfo> {
        const $ = parse(await ctx.text(seriesUrl, { noCache: true }))
        const seriesId = this.seriesIdFromUrl(seriesUrl)
        if (!seriesId) throw new Error(`could not derive a series id from ${seriesUrl}`)

        const meta = (property: string) => $(`meta[property="${property}"]`).attr("content")?.trim()

        return {
            // og:* is more reliable here than the visible heading, which the theme
            // decorates with icons and episode counts.
            title: meta("og:title") || $("h1").first().text().trim() || seriesId,
            seriesId,
            url: seriesUrl,
            poster: meta("og:image"),
            description: meta("og:description"),
            status: "unknown"
        }
    }

    async getEpisodes(seriesUrl: string, ctx: FetchCtx): Promise<Episode[]> {
        const $ = parse(await ctx.text(seriesUrl, { noCache: true }))
        const episodes: Episode[] = []

        $("li.md-episode-item").each((_, element) => {
            const $item = $(element)
            const href = attrOf($item.find("a").first(), "href")
            if (!href) return

            const url = absoluteUrl(href, ctx.baseUrl)
            // data-ep is authoritative; the URL is the fallback.
            const number = leadingNumber(attrOf($item, "data-ep") ?? "") ?? this.episodeNumberFromUrl(url)
            if (number === null) return

            episodes.push({ number, url, variant: "sub" })
        })

        episodes.sort((a, b) => b.number - a.number)
        logger.debug(`${episodes.length} episodes from ${seriesUrl}`)
        return episodes
    }

    // ------------------------------------------------------------ page context

    isEpisodePage(html: string, url: string): boolean {
        if (!new RegExp(this.episodeUrl.source).test(pathOf(url))) return false
        return html.includes("md-server-tabs") || html.includes("md-player-container")
    }

    async getPageInfo(html: string, url: string, ctx: FetchCtx): Promise<PageInfo> {
        const $ = parse(html)
        const seriesId = this.seriesIdFromUrl(url)
        if (!seriesId) throw new Error(`could not derive a series id from ${url}`)

        const number = this.episodeNumberFromUrl(url)
        if (number === null) throw new Error(`could not read an episode number from ${url}`)

        // The player header links back to the series; fall back to composing it.
        const back = attrOf($("a.md-player-back").first(), "href")
        const seriesUrl = back ? absoluteUrl(back, ctx.baseUrl) : `${ctx.baseUrl}/donghua/${seriesId}`

        const heading = $("a.md-player-back span").first().text().trim()
        const title = heading || $('meta[property="og:title"]').attr("content")?.trim() || seriesId

        return { title, seriesId, seriesUrl, number, variant: "sub", episodeUrl: url }
    }

    /**
     * Each server is a packed block that appends an `<iframe>` when its tab is
     * clicked. Unpacking gives the embed URL without running any of it, and the
     * `#<name>_tab` selector inside ties it back to the visible tab label.
     */
    async getServers(html: string, url: string, _ctx: FetchCtx): Promise<Server[]> {
        const $ = parse(html)

        const labels = new Map<string, string>()
        $("button.md-server-tab").each((_, element) => {
            const $button = $(element)
            const id = attrOf($button, "id")?.replace(/_tab$/, "") ?? attrOf($button, "data-target")
            if (!id) return
            // Tabs carry an "ADS" warning span; keep the name, drop the noise.
            const label = $button.clone().find("span").remove().end().text().trim()
            labels.set(id, label || id)
        })

        const servers: Server[] = []
        for (const block of unpackAll(html)) {
            const name = /#(\w+)_tab/.exec(block)?.[1]
            const embedUrl = /<iframe[^>]+src=['"]([^'"]+)['"]/i.exec(block)?.[1]
            if (!name || !embedUrl) continue

            servers.push({
                name: labels.get(name) ?? name,
                variant: "sub",
                embedUrl
            })
        }

        logger.debug(`${servers.length} servers on ${url}`)
        return servers
    }
}

export const mundodonghua = new MundoDonghua()
