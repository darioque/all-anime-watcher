/**
 * Payload parsing for donghualife.com, kept free of transport so it can be tested.
 *
 * The site is a Next.js App Router app. Its pages carry their data twice: as the
 * rendered HTML, and as the React Server Components payload the client hydrates
 * from — a run of `self.__next_f.push([1, "<chunk>"])` scripts whose chunks
 * concatenate into one text stream. The payload is the better source: it holds
 * the props the page was rendered *from* (season lists, server tokens, the slug
 * of the season an episode belongs to), where the HTML holds only what survived
 * into markup.
 *
 * Nothing in the payload is addressed by position. Each value is found by the
 * prop name that introduces it and read as JSON from there, so a reshuffled page
 * still parses as long as the component props keep their names.
 */

/** The concatenated RSC payload of a page, or "" when it carries none. */
export function rscOf(html: string): string {
    const chunks: string[] = []
    const rx = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g
    for (let match = rx.exec(html); match !== null; match = rx.exec(html)) {
        try {
            chunks.push(JSON.parse(match[1] as string) as string)
        } catch {
            // A chunk that is not a string literal is not one we need.
        }
    }
    return chunks.join("")
}

/**
 * The JSON value that starts at `start`, an object or an array.
 *
 * A bracket counter that knows about strings, because synopses and titles are
 * free text and a brace inside one would otherwise end the value early.
 */
export function jsonAt<T = unknown>(text: string, start: number): T | null {
    const open = text[start]
    if (open !== "{" && open !== "[") return null

    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
        const char = text[i]
        if (inString) {
            if (char === "\\") i++
            else if (char === '"') inString = false
            continue
        }
        if (char === '"') inString = true
        else if (char === "{" || char === "[") depth++
        else if (char === "}" || char === "]") {
            depth--
            if (depth === 0) {
                try {
                    return JSON.parse(text.slice(start, i + 1)) as T
                } catch {
                    return null
                }
            }
        }
    }
    return null
}

/** The value of the first `"<prop>":` in the payload, when it is an object or array. */
export function propValue<T = unknown>(rsc: string, prop: string): T | null {
    const marker = `"${prop}":`
    const at = rsc.indexOf(marker)
    if (at < 0) return null
    return jsonAt<T>(rsc, at + marker.length)
}

/** The first string value of `"<prop>":"…"`. */
export function propString(rsc: string, prop: string): string | null {
    const match = new RegExp(`"${prop}":"((?:[^"\\\\]|\\\\.)*)"`).exec(rsc)
    if (!match?.[1]) return null
    try {
        return JSON.parse(`"${match[1]}"`) as string
    } catch {
        return match[1]
    }
}

// ------------------------------------------------------------------ URLs

/**
 * `/watch/<slug>-<number>` → its two halves.
 *
 * The prefix is *not* an identity. The site's own episode lists build it from
 * the season slug (`wan-jie-du-zun-3-211`), but it also answers to the series
 * slug for single-season shows (`perfect-world-288` is season `perfect-world-1`),
 * and its own JSON-LD advertises that second form. Only the page can say which
 * season it is; see `parseWatchPage`.
 */
export function splitWatchSlug(path: string): { prefix: string; number: number } | null {
    const match = /^\/watch\/(.+)-(\d+(?:\.\d+)?)\/?$/.exec(path)
    if (!match?.[1] || !match[2]) return null
    return { prefix: match[1], number: Number.parseFloat(match[2]) }
}

/** The last path segment of a watch URL, which is what a page calls `currentId`. */
export function watchIdOf(path: string): string | null {
    return /^\/watch\/([^/]+)\/?$/.exec(path)?.[1] ?? null
}

/**
 * The series URL this source stores for one season.
 *
 * The site has a page per *show*, holding every season, and the episodes API
 * wants both slugs. The season rides in the fragment: the link still opens the
 * show's page for a person, and the fragment never reaches the server.
 */
export function seasonUrl(base: string, seriesSlug: string, seasonSlug: string): string {
    return `${base}/series/${seriesSlug}#temporada=${encodeURIComponent(seasonSlug)}`
}

export function seasonOfUrl(url: string): { seriesSlug: string; seasonSlug: string } | null {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return null
    }
    const seriesSlug = /^\/series\/([^/]+)\/?$/.exec(parsed.pathname)?.[1]
    const seasonSlug = /(?:^#|&)temporada=([^&]+)/.exec(parsed.hash)?.[1]
    if (!seriesSlug || !seasonSlug) return null
    return { seriesSlug, seasonSlug: decodeURIComponent(seasonSlug) }
}

// ------------------------------------------------------------------ seasons

/** A season as the show's page lists it. */
export interface SeasonLike {
    slug: string
    label: string
    episodeCount: number
    isSpecial: boolean
}

/** An episode as `/api/series/<s>/seasons/<season>/episodes` returns it. */
export interface ApiEpisode {
    id: string
    number: number
    title?: string
    isVipOnly?: boolean
    isSpecial?: boolean
}

/**
 * The seasons on a show's page, empty ones dropped.
 *
 * A season with no episodes is not something to follow. The site has at least
 * one such row that is really a film's placeholder ("Peli Ep 151- 152", 0
 * episodes), and offering it would add a series that can never update.
 */
export function parseSeasons(rsc: string): SeasonLike[] {
    const raw = propValue<Array<Record<string, unknown>>>(rsc, "seasons") ?? []
    const seasons: SeasonLike[] = []
    for (const season of raw) {
        const slug = typeof season.slug === "string" ? season.slug : ""
        const count = typeof season.episodeCount === "number" ? season.episodeCount : 0
        if (!slug || count <= 0) continue
        seasons.push({
            slug,
            label: String(season.label ?? season.name ?? "").trim(),
            episodeCount: count,
            isSpecial: season.isSpecial === true
        })
    }
    return seasons
}

/**
 * How a season is titled in the library.
 *
 * Every season restarts at episode 1 on this site, so each one is its own
 * series here — the same split AniList makes, which is what lets tracker
 * matching find it. The show's name alone is enough while it has one season;
 * past that the label goes on, in the site's own words ("Temporada 3",
 * "Especial"), which `trackers/matching.ts` reads as a season marker.
 */
export function seasonTitle(showTitle: string, label: string, seasonCount: number): string {
    const show = showTitle.trim()
    if (seasonCount <= 1 || !label) return show
    return `${show} – ${label}`
}

/**
 * The episodes of one season, descending, VIP early-access posts removed.
 *
 * **The site posts episodes before a free viewer can watch them.** The newest
 * one or two of an airing season are VIP-only for a while, and opening one
 * without a subscription redirects to `/vip`. The list carries the flag, so the
 * post is dropped here and never reaches the update loop, the Lab or the probe.
 * When the window closes the flag clears and the episode appears as an ordinary
 * release — late by the length of the window, never lost.
 */
export function parseEpisodes(episodes: ApiEpisode[], episodeUrl: (number: number) => string) {
    return episodes
        .filter(episode => typeof episode.number === "number" && Number.isFinite(episode.number))
        .filter(episode => episode.isVipOnly !== true)
        .map(episode => ({
            number: episode.number,
            url: episodeUrl(episode.number),
            variant: "sub" as const,
            title: episodeTitle(episode)
        }))
        .sort((a, b) => b.number - a.number)
}

/** The site's own title, unless it only restates the number. */
function episodeTitle(episode: ApiEpisode): string | undefined {
    const title = episode.title?.trim()
    if (!title) return undefined
    if (/^(cap[ií]tulo|episodio)\s*0*\d+(\.\d+)?$/i.test(title)) return undefined
    return title
}

// ------------------------------------------------------------------ watch page

export interface PlayerSource {
    id: string
    label: string
    token: string
    /** "video" plays a file of the site's own; "embed" is a third-party player. */
    type: string
    provider: string
    /** "jassub" when the site renders an ASS track over the video; "native" when it is burnt in. */
    subtitleSupport?: string
    priority?: number
}

export interface WatchPage {
    /** The page's own name for itself — the last segment of the URL it was rendered for. */
    currentId: string | null
    seriesSlug: string | null
    seasonSlug: string | null
    /** Seasons the show has, including empty ones the page lists. */
    seasons: Array<{ slug: string; name: string }>
    episodeId: string | null
    /** "Wan Jie Du Zun - Capítulo 211". */
    playerTitle: string | null
    sources: PlayerSource[]
    /** The page is a redirect to `/vip`: an early-access episode, for a viewer without it. */
    vipOnly: boolean
}

export function parseWatchPage(html: string): WatchPage {
    const rsc = rscOf(html)
    // The player's props open with its source list; the object is read whole
    // because the episode id and title sit beside it.
    const playerAt = rsc.indexOf('{"sources":[')
    const playerProps =
        playerAt < 0 ? null : jsonAt<{ sources?: PlayerSource[]; title?: string; episodeId?: string }>(rsc, playerAt)
    const seasons = (propValue<Array<Record<string, unknown>>>(rsc, "seasons") ?? [])
        .map(season => ({ slug: String(season.slug ?? ""), name: String(season.name ?? season.label ?? "") }))
        .filter(season => season.slug !== "")

    return {
        currentId: propString(rsc, "currentId"),
        seriesSlug: propString(rsc, "seriesSlug"),
        seasonSlug: propString(rsc, "seasonSlug"),
        seasons,
        episodeId: playerProps?.episodeId ?? null,
        playerTitle: playerProps?.title ?? null,
        sources: Array.isArray(playerProps?.sources) ? playerProps.sources : [],
        vipOnly: /NEXT_REDIRECT;[a-z]+;\/vip;/.test(rsc)
    }
}

/** "Wan Jie Du Zun - Capítulo 211" → "Wan Jie Du Zun". */
export function showTitleFromPlayer(title: string): string {
    return title.replace(/\s*-\s*(cap[ií]tulo|episodio)\s*[\d.]+\s*$/i, "").trim()
}
