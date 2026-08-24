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

async function step<T>(label: string, run: () => Promise<T>, describe: (value: T) => string): Promise<T | null> {
    try {
        const value = await run()
        pass(label, describe(value))
        return value
    } catch (error) {
        fail(label, error)
        return null
    }
}

console.log(`\n\x1b[1m${source.name}\x1b[0m  (${source.id})  →  ${base}\n`)

// -------------------------------------------------------------- search
const results = await step(
    "search",
    () => source.search("a", ctx),
    r => `${r.length} result(s)` + (r[0] ? `, first: "${r[0].title}" → ${r[0].seriesId}` : "")
)

// -------------------------------------------------------------- series
const seriesUrl = results?.[0]?.url
let episodeUrl = explicitEpisodeUrl

if (seriesUrl) {
    await step(
        "getSeries",
        () => source.getSeries(seriesUrl, ctx),
        s => `"${s.title}"${s.poster ? ", has poster" : ", NO poster"}, status=${s.status}`
    )

    const episodes = await step(
        "getEpisodes",
        () => source.getEpisodes(seriesUrl, ctx),
        e => {
            const numbers = e.slice(0, 3).map(x => x.number).join(", ")
            const descending = e.every((x, i) => i === 0 || e[i - 1]!.number >= x.number)
            return `${e.length} episode(s), newest first: [${numbers}], sorted=${descending ? "ok" : "WRONG"}`
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

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
