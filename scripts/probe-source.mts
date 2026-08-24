/**
 * Run a source through the whole AnimeSource contract against the live site and
 * report what worked. This is the command-line ancestor of the Lab page from the
 * design doc — the point is to catch a site change here, not in the extension.
 *
 *   npm run probe -- <sourceId> [episodeUrl]
 *
 * With no episode URL it discovers one: search → series → newest episode.
 */
import { allSources, sourceById } from "~/sources/registry"
import { createFetchCtx } from "~/net/fetcher"
import { setLogLevel } from "~/shared/logger"

setLogLevel(process.env.VERBOSE ? "debug" : "warn")

const [sourceId, explicitEpisodeUrl] = process.argv.slice(2)

if (!sourceId) {
    console.error("usage: npm run probe -- <sourceId> [episodeUrl]")
    console.error(`known sources: ${allSources().map(s => s.id).join(", ")}`)
    process.exit(1)
}

const source = sourceById(sourceId)
if (!source) {
    console.error(`unknown source "${sourceId}"`)
    console.error(`known sources: ${allSources().map(s => s.id).join(", ")}`)
    process.exit(1)
}

const base = `https://${source.domains[0]}`
const ctx = createFetchCtx({ baseUrl: base, defaultHeaders: { Referer: `${base}/` } })

let failures = 0

function pass(label: string, detail: string) {
    console.log(`  \x1b[32m✓\x1b[0m ${label.padEnd(20)} ${detail}`)
}

function fail(label: string, error: unknown) {
    failures++
    const message = error instanceof Error ? error.message : String(error)
    console.log(`  \x1b[31m✗\x1b[0m ${label.padEnd(20)} ${message}`)
}

async function step<T>(
    label: string,
    run: () => Promise<T>,
    describe: (value: T) => string,
    /** Return a message to turn a successful call into a failure. */
    assert?: (value: T) => string | null
): Promise<T | null> {
    try {
        const value = await run()
        const problem = assert?.(value) ?? null
        if (problem) {
            fail(label, problem)
            return value
        }
        pass(label, describe(value))
        return value
    } catch (error) {
        fail(label, error)
        return null
    }
}

/**
 * A poster URL has to be something a browser can actually render. Lazy-loading
 * themes keep a blank inline SVG in `src` and the real URL in `data-src`, so
 * "there is a poster" is not the same as "the poster works" — this probe used to
 * pass on a placeholder.
 */
function posterProblem(poster: string | undefined, what: string): string | null {
    if (!poster) return null
    if (poster.startsWith("data:")) {
        return `${what} is a data: URI (${poster.slice(0, 48)}…) — almost certainly a lazy-load placeholder`
    }
    if (!/^https?:\/\//.test(poster)) return `${what} is not an absolute URL: ${poster}`
    return null
}

console.log(`\n\x1b[1m${source.name}\x1b[0m  (${source.id})  →  ${base}\n`)

// -------------------------------------------------------------- search
const results = await step(
    "search",
    () => source.search("a", ctx),
    r => `${r.length} result(s)` + (r[0] ? `, first: "${r[0].title}" → ${r[0].seriesId}` : ""),
    r => (r.length === 0 ? "no results for a one-letter query — the selector is probably wrong" : posterProblem(r[0]?.poster, "search poster"))
)

// -------------------------------------------------------------- series
const seriesUrl = results?.[0]?.url
let episodeUrl = explicitEpisodeUrl

if (seriesUrl) {
    await step(
        "getSeries",
        () => source.getSeries(seriesUrl, ctx),
        s => `"${s.title}", status=${s.status}\n                       poster: ${s.poster ?? "(none)"}`,
        s => posterProblem(s.poster, "series poster")
    )

    const episodes = await step(
        "getEpisodes",
        () => source.getEpisodes(seriesUrl, ctx),
        e => {
            const numbers = e.slice(0, 3).map(x => x.number).join(", ")
            return `${e.length} episode(s), newest first: [${numbers}]`
        },
        e => {
            if (e.length === 0) return "no episodes — the update loop would have nothing to compare"
            if (!e.every((x, i) => i === 0 || e[i - 1]!.number >= x.number)) {
                return "episodes are not sorted descending; the newest-episode check relies on it"
            }
            if (e.some(x => !Number.isFinite(x.number))) return "an episode has a non-numeric number"
            return null
        }
    )

    if (!episodeUrl && episodes?.[0]) episodeUrl = episodes[0].url
}

// -------------------------------------------------------------- episode page
if (!episodeUrl) {
    console.log("\n  no episode URL to probe — stopping here\n")
    process.exit(failures > 0 ? 1 : 0)
}

console.log(`\n  episode: ${episodeUrl}\n`)

const html = await step(
    "fetch episode",
    () => ctx.text(episodeUrl!, { noCache: true }),
    h => `${(h.length / 1024).toFixed(0)} KB`
)

if (html) {
    const isEpisode = source.isEpisodePage(html, episodeUrl)
    if (isEpisode) pass("isEpisodePage", "true")
    else fail("isEpisodePage", "returned false — the reader would never load")

    await step(
        "seriesIdFromUrl",
        async () => source.seriesIdFromUrl(episodeUrl!),
        id => (id ? `"${id}"` : "null — IDENTITY WOULD BREAK")
    )

    await step(
        "getPageInfo",
        () => source.getPageInfo(html, episodeUrl!, ctx),
        i => `"${i.title}" ep ${i.number} → series ${i.seriesUrl}`
    )

    const servers = await step(
        "getServers",
        () => source.getServers(html, episodeUrl!, ctx),
        s => `${s.length}: ${s.map(x => x.name).join(" | ") || "none"}`
    )

    if (servers?.[0] && source.resolveServer) {
        await step(
            "resolveServer",
            () => source.resolveServer!(servers[0]!, ctx),
            url => `${servers[0]!.name} → ${url}`
        )
    }
}

// A poster that parses but 404s is still a broken image in the list.
if (seriesUrl) {
    const info = await source.getSeries(seriesUrl, ctx).catch(() => null)
    if (info?.poster && /^https?:\/\//.test(info.poster)) {
        await step(
            "poster loads",
            async () => {
                const response = await fetch(info.poster!, { headers: { Referer: `${base}/` } })
                return { status: response.status, type: response.headers.get("content-type") ?? "" }
            },
            r => `HTTP ${r.status}, ${r.type}`,
            r => (r.status >= 400 ? `HTTP ${r.status}` : r.type.startsWith("image/") ? null : `not an image: ${r.type}`)
        )
    }
}

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
