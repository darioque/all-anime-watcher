import { hostOf, matchDomain, pathOf } from "~/shared/url"
import type { LabFetchReport, LabSeriesReport } from "./types"
import type { SearchResult } from "~/sources/types"
import type { Stream } from "~/extractors/types"

/**
 * What the Lab actually asserts, with nothing that talks to a network.
 *
 * The probes fetch; these decide. Split that way for the usual reason — a
 * judgement that only ever runs against a live site is a judgement nobody can
 * test — but also because most of these are the checks that would have caught
 * a real bug in this repo, and each one deserves to keep working:
 *
 *  - a source giving a series two identities (see `background/identify.ts`)
 *  - an episode list handed back in the wrong order, which makes "newest" the
 *    oldest and every notification wrong
 *  - a playlist that answers 200 with an error page, which is what a missing
 *    Referer looks like from the outside
 *
 * Exercised by `npm run check:lab`.
 */

export interface Verdict {
    ok: boolean
    /** The finding, one line, past tense. */
    note: string
    /** Worth saying, not worth failing over. */
    warnings?: string[]
}

/** Facts a source publishes about itself. Structural, so a descriptor fits. */
export interface SourceFacts {
    id: string
    name: string
    domains: string[]
    home: string
    languages: string[]
    enabled: boolean
}

/** What an episode page turned out to be. Structural, so a PageIdentity fits. */
export interface PageFacts {
    isEpisode: boolean
    error?: string
    key?: string
    pageInfo?: { title: string; seriesId: string; seriesUrl: string; number: number }
    servers?: { name: string }[]
}

const pass = (note: string, warnings: string[] = []): Verdict =>
    warnings.length > 0 ? { ok: true, note, warnings } : { ok: true, note }

const fail = (note: string, warnings: string[] = []): Verdict =>
    warnings.length > 0 ? { ok: false, note, warnings } : { ok: false, note }

// ------------------------------------------------------------------ 1. source

/**
 * The declared attributes, before a single request is made.
 *
 * Cheap and worth doing first: a source with no domains is invisible to the
 * navigation matcher, and a source whose home does not parse fails every fetch
 * with an error that names the URL rather than the cause.
 */
export function checkAttributes(source: SourceFacts): Verdict {
    const missing: string[] = []
    if (source.id.trim() === "") missing.push("id")
    if (source.name.trim() === "") missing.push("name")
    if (source.domains.length === 0) missing.push("domains")
    if (source.languages.length === 0) missing.push("languages")

    if (missing.length > 0) return fail(`missing ${missing.join(", ")}`)

    let homeHost = ""
    try {
        homeHost = hostOf(source.home)
    } catch {
        homeHost = ""
    }
    if (homeHost === "") return fail(`home "${source.home}" is not a URL`)

    const warnings: string[] = []
    // Not fatal — a source can legitimately have moved — but it means the
    // configured home no longer names any host the source claims.
    if (!source.domains.some(domain => matchDomain(homeHost, domain))) {
        warnings.push(`home is ${homeHost}, which is not in domains (${source.domains.join(", ")})`)
    }
    if (!source.enabled) warnings.push("this source is switched off; the probes below still run")

    return pass(`${source.name} — ${source.domains.length} domain(s), ${source.languages.join(", ")}`, warnings)
}

// ------------------------------------------------------------------ 2. search

export function checkSearch(query: string, results: SearchResult[], source: SourceFacts): Verdict {
    if (results.length === 0) {
        return fail(`no results for "${query}" — either the query is wrong or search() is`)
    }

    const nameless = results.filter(result => result.title.trim() === "").length
    const idless = results.filter(result => !result.seriesId || result.seriesId.trim() === "").length

    // A result with no id cannot become a library entry: the key is built from
    // it. This is a hard failure however many good results sit beside it.
    if (idless > 0) return fail(`${idless} of ${results.length} result(s) carry no seriesId`)

    const warnings: string[] = []
    if (nameless > 0) warnings.push(`${nameless} result(s) have no title and will show as their id`)

    const offsite = results
        .map(result => hostOf(result.url))
        .filter(host => host !== "" && !hosts(source).some(domain => matchDomain(host, domain)))
    if (offsite.length > 0) {
        // Usually a relative URL that was never made absolute, which fails later
        // and further away — at the point something tries to fetch it.
        warnings.push(`${offsite.length} result URL(s) point off-site: ${unique(offsite).join(", ")}`)
    }

    const duplicated = results.length - unique(results.map(result => result.seriesId)).length
    if (duplicated > 0) warnings.push(`${duplicated} duplicate seriesId(s) in the results`)

    return pass(`${results.length} result(s) for "${query}"`, warnings)
}

// ------------------------------------------------------------------ 3. series

export function checkSeries(report: LabSeriesReport, expect: { seriesId: string }): Verdict {
    if (report.episodeCount === 0) return fail("the series page yielded no episodes")

    const warnings: string[] = []

    /*
     * The identity check. Search says one id, the series page says another, and
     * the library ends up with two entries for one series — one of which never
     * updates. Nothing about this is visible in normal use, which is why it is
     * checked here rather than trusted.
     */
    if (report.seriesId !== expect.seriesId) {
        return fail(`search called this "${expect.seriesId}" and the series URL derives "${report.seriesId}"`)
    }

    if (report.info.title.trim() === "") warnings.push("the series has no title and will show as its id")

    // Descending is the contract: everything downstream reads element 0 as the
    // newest episode. Reversed, every "new episode" notification is wrong.
    const descending = report.numbers.every((number, index) => index === 0 || number <= report.numbers[index - 1]!)
    if (!descending) {
        const ascending = report.numbers.every((number, index) => index === 0 || number >= report.numbers[index - 1]!)
        return fail(
            ascending
                ? "the episode list is ascending; getEpisodes must return newest first"
                : "the episode list is not in order, so the newest episode is whichever happens to be first"
        )
    }

    const bad = report.numbers.filter(number => !Number.isFinite(number)).length
    if (bad > 0) return fail(`${bad} episode(s) have no usable number`)

    const repeats = report.numbers.length - unique(report.numbers.map(String)).length
    if (repeats > 0) warnings.push(`${repeats} repeated episode number(s) — a dub and a sub both listed, perhaps`)

    /*
     * Do the URLs this list hands out actually route back to this source? If
     * they do not, clicking an episode opens a page the extension never
     * recognises, and no amount of correct parsing upstream shows.
     */
    const rx = safeRegExp(report.episodePattern)
    if (rx) {
        const unmatched = [...report.first, ...report.last].filter(episode => !rx.test(pathOf(episode.url)))
        if (unmatched.length > 0) {
            return fail(
                `${unmatched.length} episode URL(s) do not match the source's own episodeUrl pattern, ` +
                    `starting with ${unmatched[0]!.url}`
            )
        }
    } else {
        warnings.push(`episodeUrl pattern /${report.episodePattern}/ does not compile`)
    }

    const newest = report.numbers[0]
    const oldest = report.numbers.at(-1)
    return pass(`${report.episodeCount} episode(s), newest E${newest}, oldest E${oldest}`, warnings)
}

// -------------------------------------------------------------------- 4. page

export function checkPage(page: PageFacts, expect: { seriesId: string; number: number }): Verdict {
    if (page.error) return fail(page.error)
    if (!page.isEpisode) return fail("the page was not recognised as an episode page")
    if (!page.pageInfo) return fail("the page was recognised but yielded no episode info")

    const info = page.pageInfo
    const warnings: string[] = []

    /*
     * The same identity check as above, from the other side — and the one that
     * bites, because this is the id the content script keys the library on. When
     * it disagrees with the series page, opening an episode of a followed series
     * offers to follow it again.
     */
    if (info.seriesId !== expect.seriesId) {
        return fail(
            `the series lists this episode under "${expect.seriesId}", the episode page says "${info.seriesId}"`
        )
    }

    if (info.number !== expect.number) {
        return fail(`the list called this episode ${expect.number}, the page reads it as ${info.number}`)
    }

    if (!page.servers || page.servers.length === 0) {
        return fail("no servers on the page — nothing here can be played")
    }

    if (info.title.trim() === "") warnings.push("no title on the episode page")
    if (page.key) warnings.push(`already followed as ${page.key}`)

    return pass(`E${info.number} of "${info.title}" — ${page.servers.length} server(s)`, warnings)
}

// ----------------------------------------------------------------- 5. streams

export function checkStreams(resolved: { extractorId: string | null; embedUrl: string; streams: Stream[] }): Verdict {
    if (resolved.streams.length === 0) {
        return fail(`nothing came back for ${resolved.embedUrl}`)
    }

    /*
     * An iframe result is the "we could not extract this" fallback, not a
     * stream. It plays, so normal use gives no sign anything is wrong — while
     * progress, quality and downloads are all silently gone.
     */
    if (!resolved.extractorId) {
        const host = hostOf(resolved.embedUrl)
        return fail(`no extractor claims ${host || resolved.embedUrl}; falling back to an iframe`)
    }

    const playable = resolved.streams.filter(stream => stream.kind !== "iframe")
    if (playable.length === 0) {
        return fail(`${resolved.extractorId} returned only iframe fallbacks`)
    }

    const warnings: string[] = []
    const subtitles = playable.reduce((total, stream) => total + (stream.subtitles?.length ?? 0), 0)
    if (subtitles === 0) warnings.push("no subtitle tracks came with the stream")

    const kinds = unique(playable.map(stream => stream.kind))
    return pass(`${resolved.extractorId} → ${playable.length} stream(s) (${kinds.join(", ")})`, warnings)
}

// ------------------------------------------------------------------- 6. fetch

/**
 * The last step, and the only one the CLI probe structurally cannot do.
 *
 * Node's fetch can set Referer and Origin; a browser's cannot, so a host that
 * demands either passes every terminal probe and fails in the extension. What
 * that failure looks like from the outside is exactly this: HTTP 200, a
 * plausible byte count, and a body that is not a playlist.
 */
export function checkFetch(report: LabFetchReport, expect: { playlist: boolean }): Verdict {
    if (!report.ok) {
        return fail(`HTTP ${report.status} from ${hostOf(report.url) || report.url}`)
    }

    if (!expect.playlist) {
        // A progressive file. Only the first slice was asked for, so the test is
        // that the host served it at all — and that what it served is video
        // rather than the login page it redirected to.
        if (report.bytes === 0) return fail(`HTTP ${report.status} with an empty body`)
        if (/text\/html/i.test(report.contentType)) {
            return fail(`HTTP ${report.status}, but the host answered with HTML instead of video`)
        }
        return pass(`HTTP ${report.status} — ${report.bytes} bytes of ${report.contentType || "unlabelled data"}`)
    }

    if (report.kind === "not a playlist") {
        return fail(
            `HTTP ${report.status}, ${report.bytes} bytes, but the body is not a playlist — ` +
                `a host answering an error page under a 200 is exactly what a missing Referer looks like`
        )
    }

    if (report.entries === 0) {
        return fail(`an empty ${report.kind}`)
    }

    const warnings: string[] = []
    if (report.kind === "master playlist" && report.entries === 1) {
        warnings.push("only one variant, so there is nothing for the quality picker to offer")
    }

    return pass(
        `HTTP ${report.status} — a ${report.kind} with ${report.entries} ` +
            `${report.kind === "master playlist" ? "variant" : "segment"}(s)`,
        warnings
    )
}

// ------------------------------------------------------------------- shared

function hosts(source: SourceFacts): string[] {
    return source.domains
}

function unique(values: string[]): string[] {
    return [...new Set(values)]
}

function safeRegExp(pattern: string): RegExp | null {
    try {
        return new RegExp(pattern)
    } catch {
        return null
    }
}
