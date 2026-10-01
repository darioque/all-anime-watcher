/**
 * Run a source through the whole AnimeSource contract against the live site and
 * report what worked. This is the command-line ancestor of the Lab page from the
 * design doc — the point is to catch a site change here, not in the extension.
 *
 *   npm run probe -- <sourceId> [episodeUrl]
 *
 * With no episode URL it discovers one: search → series → newest episode.
 *
 * **Known blind spot.** Node's fetch can set `Referer` and `Origin`; the
 * extension's cannot — both are forbidden header names there, and only a DNR
 * rule can supply them. So this probe is *more capable* than the thing it is
 * testing, and a host that needs one of those headers passes here and fails in
 * the browser. MegaPlay did exactly that: it answers a Referer-less request with
 * HTTP 200 and an error page, so the extension read it as markup that had
 * changed while the probe stayed green. The stream checks below simulate the DNR
 * rewrites for this reason; the extractor's own page fetches do not yet.
 */
import { allSources, sourceById } from "~/sources/registry"
import { createFetchCtx } from "~/net/fetcher"
import { extractorFor } from "~/extractors/registry"
import type { ResolvedServer } from "~/sources/types"
import type { ExtractCtx, ExtractorNetRule } from "~/extractors/types"
import { setLogLevel } from "~/shared/logger"
import { assToVtt, isAss, isVtt, srtToVtt } from "~/shared/vtt"

setLogLevel(process.env.VERBOSE ? "debug" : "warn")

/**
 * Node's fetch keeps no cookie jar; the browser does. Several hosts hand out a
 * session cookie on the embed page and require it on the manifest — Dailymotion
 * sets ts/v1st/dmvk that way — so without a jar the probe fails where the
 * extension would succeed, which is a false alarm rather than a finding.
 *
 * This shim gives the probe the same cookie behaviour the background's
 * `credentials: "include"` fetch gets for free.
 */
function installCookieJar() {
    const jar = new Map<string, Map<string, string>>()
    cookieJar = jar
    const nativeFetch = globalThis.fetch

    const domainKey = (host: string) => host.split(".").slice(-2).join(".")

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const host = new URL(url).hostname
        const cookies = jar.get(domainKey(host))

        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        if (cookies && cookies.size > 0 && !headers.has("cookie")) {
            headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "))
        }

        const response = await nativeFetch(input, { ...init, headers })

        for (const [name, value] of response.headers) {
            if (name.toLowerCase() !== "set-cookie") continue
            const pair = value.split(";")[0]?.trim()
            if (!pair) continue
            const eq = pair.indexOf("=")
            if (eq <= 0) continue
            const key = domainKey(host)
            if (!jar.has(key)) jar.set(key, new Map())
            jar.get(key)!.set(pair.slice(0, eq), pair.slice(eq + 1))
        }
        // getSetCookie() exposes all of them where the runtime supports it.
        const all = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
        for (const value of all) {
            const pair = value.split(";")[0]?.trim()
            if (!pair) continue
            const eq = pair.indexOf("=")
            if (eq <= 0) continue
            const key = domainKey(host)
            if (!jar.has(key)) jar.set(key, new Map())
            jar.get(key)!.set(pair.slice(0, eq), pair.slice(eq + 1))
        }

        return response
    }
}

/** Exposed so the node:https path below can send the same cookies as fetch. */
let cookieJar: Map<string, Map<string, string>> | null = null

installCookieJar()

function cookieHeaderFor(url: string): string {
    const host = new URL(url).hostname
    const cookies = cookieJar?.get(host.split(".").slice(-2).join("."))
    if (!cookies || cookies.size === 0) return ""
    return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ")
}

const [sourceId, explicitEpisodeUrl] = process.argv.slice(2)

if (!sourceId) {
    console.error("usage: npm run probe -- <sourceId> [episodeUrl]")
    console.error(
        `known sources: ${allSources()
            .map(s => s.id)
            .join(", ")}`
    )
    process.exit(1)
}

const source = sourceById(sourceId)
if (!source) {
    console.error(`unknown source "${sourceId}"`)
    console.error(
        `known sources: ${allSources()
            .map(s => s.id)
            .join(", ")}`
    )
    process.exit(1)
}

const base = `https://${source.domains[0]}`
/*
 * The browser UA goes on the *context*, not just the final fetch.
 *
 * Setting it only on the last request made ok.ru fail 8/8 with HTTP 400 where it
 * had passed: its file URLs are bound to the client that minted them, and the
 * probe minted them through this context under Node's default UA and then asked
 * for them as a browser. Which UA is sent matters far less than sending the same
 * one throughout, so it belongs here, where every source, extractor and stream
 * fetch inherits it.
 */
const ctx = createFetchCtx({
    baseUrl: base,
    defaultHeaders: { Referer: `${base}/`, ...browserHeaders() }
})

let failures = 0

function pass(label: string, detail: string) {
    console.log(`  \x1b[32m✓\x1b[0m ${label.padEnd(20)} ${detail}`)
}

function fail(label: string, error: unknown) {
    failures++
    const message = error instanceof Error ? error.message : String(error)
    console.log(`  \x1b[31m✗\x1b[0m ${label.padEnd(20)} ${message}`)
}

/** Something that did not work here but does not prove the extension is broken. */
function warn(label: string, message: string) {
    console.log(`  \x1b[33m!\x1b[0m ${label.padEnd(20)} ${message}`)
}

/** Site-published intro/outro offsets, shown so a source that stops sending them is visible. */
function describeSkips(skips: ResolvedServer["skips"]): string {
    if (!skips) return ""
    const parts = [
        skips.intro && `intro ${skips.intro.startSec}–${skips.intro.endSec}s`,
        skips.outro && `outro ${skips.outro.startSec}–${skips.outro.endSec}s`
    ].filter(Boolean)
    return parts.length > 0 ? `  \x1b[2m(site skips: ${parts.join(", ")})\x1b[0m` : ""
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
    r =>
        r.length === 0
            ? "no results for a one-letter query — the selector is probably wrong"
            : posterProblem(r[0]?.poster, "search poster")
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
            const numbers = e
                .slice(0, 3)
                .map(x => x.number)
                .join(", ")
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
        // Null is legitimate: some sites put nothing identifying in an episode
        // URL, and getPageInfo supplies the identity instead. The check that
        // actually matters is the one below, that getPageInfo yields a seriesId.
        id => (id ? `"${id}"` : "null — identity comes from getPageInfo instead")
    )

    await step(
        "getPageInfo",
        () => source.getPageInfo(html, episodeUrl!, ctx),
        i => `"${i.title}" ep ${i.number} → series ${i.seriesUrl}`,
        i => {
            if (!i.seriesId) return "no seriesId — the library key can't be formed"
            if (!Number.isFinite(i.number)) return "episode number is not a number"
            if (!i.seriesUrl) return "no seriesUrl — the update loop would have nothing to poll"
            return null
        }
    )

    const servers = await step(
        "getServers",
        () => source.getServers(html, episodeUrl!, ctx),
        s => `${s.length}: ${s.map(x => x.name).join(" | ")}`,
        // Zero servers is a defect, not a quiet pass: the player would have
        // nothing to try, and it reads identically to a selector that broke.
        s => (s.length === 0 ? "no servers found — the player would have nothing to play" : null)
    )

    // PROBE_SERVER picks which of the page's servers to follow. Sites list many
    // and they resolve to different hosts, so this is how you exercise one
    // extractor at a time.
    const wanted = Number.parseInt(process.env.PROBE_SERVER ?? "0", 10)
    const chosen = servers?.[Number.isFinite(wanted) ? wanted : 0]

    let embedUrl: string | null = null
    if (chosen) {
        if (servers && servers.length > 1) {
            console.log(`  \x1b[2m(server ${wanted} of ${servers.length}; set PROBE_SERVER to pick another)\x1b[0m`)
        }
        /*
         * A source may hand back the embed URL directly or defer it. Either way
         * the extractor chain below has to run — gating this on `resolveServer`
         * silently skipped the most valuable check for every source that
         * resolves eagerly.
         *
         * `resolveServer` may also answer with a ResolvedServer carrying the
         * site's own skip offsets rather than a bare string. Normalising here is
         * what the extension does too; not doing it handed `new URL()` the text
         * "[object Object]".
         */
        const resolved = chosen.embedUrl
            ? await step(
                  "server embed",
                  async () => ({ embedUrl: chosen.embedUrl! }) as ResolvedServer,
                  r => `${chosen.name} → ${r.embedUrl}`
              )
            : source.resolveServer
              ? await step(
                    "resolveServer",
                    async () => {
                        const answer = await source.resolveServer!(chosen, ctx)
                        return (typeof answer === "string" ? { embedUrl: answer } : answer) as ResolvedServer
                    },
                    r =>
                        `${chosen.name} → ${r.embedUrl}${describeSkips(r.skips)}` +
                        (r.subtitles?.length ? `, ${r.subtitles.length} site subtitle track(s)` : "")
                )
              : null

        embedUrl = resolved?.embedUrl ?? null

        /*
         * Subtitles the site keeps beside the video. The extractor never sees
         * them, so the extract step below cannot report them; this fetches the
         * default one the way the player will — the site as Referer, unwrapped,
         * converted — and counts the cues. Node sets that Referer itself; in the
         * extension it is a DNR rule from `background/streams.ts`.
         */
        const track = resolved?.subtitles?.find(candidate => candidate.default) ?? resolved?.subtitles?.[0]
        if (track) {
            await step(
                "site subtitles",
                async () => {
                    const text = await ctx.text(track.url, { headers: { Referer: `${ctx.baseUrl}/` } })
                    const raw = track.jsonField
                        ? ((JSON.parse(text) as Record<string, unknown>)[track.jsonField] as string | undefined)
                        : text
                    if (typeof raw !== "string") throw new Error(`no "${track.jsonField}" in the response`)
                    const vtt = isVtt(raw) ? raw : isAss(raw) ? assToVtt(raw) : srtToVtt(raw)
                    return { label: track.label, cues: (vtt.match(/ --> /g) ?? []).length, ass: isAss(raw) }
                },
                r => `"${r.label}", ${r.ass ? "ASS → " : ""}WebVTT with ${r.cues} cue(s)`,
                r => (r.cues === 0 ? "the track converted to nothing" : null)
            )
        }

        if (!embedUrl) {
            fail("server embed", `"${chosen.name}" has no embedUrl and the source has no resolveServer`)
        }
    }

    // ---------------------------------------------------- extractor + playback
    if (embedUrl) {
        const extractor = extractorFor(embedUrl)
        if (!extractor) {
            // Not a failure: the player embeds the host's own frame instead. The
            // viewer keeps episode navigation and tracking and loses only their
            // position inside the episode, so this is degraded, not broken.
            warn("extractor", `no extractor for ${new URL(embedUrl).hostname} — the player will embed it instead`)
        } else {
            pass("extractor", `${new URL(embedUrl).hostname} → ${extractor.id}`)

            const extractCtx: ExtractCtx = {
                referer: episodeUrl!,
                text: (url, init) => ctx.text(url, { ...init, headers: init?.headers ?? {} }),
                json: (url, init) => ctx.json(url, { ...init, headers: init?.headers ?? {} })
            }

            const streams = await step(
                "extract",
                () => extractor.extract(embedUrl!, extractCtx),
                s => {
                    const first = s[0]!
                    return (
                        `${s.length} stream(s), first: ${first.kind}${first.fetchVia ? ` via ${first.fetchVia}` : ""}` +
                        (first.subtitles?.length ? `, ${first.subtitles.length} subtitle track(s)` : "")
                    )
                },
                s => (s.length === 0 ? "the extractor returned no streams" : null)
            )

            // The manifest (or the file itself) is what the player loads first.
            // Simulate the DNR rewrites the extension applies, since Node can send
            // header sets that fetch() in the extension cannot.
            /*
             * Every stream, not just the first.
             *
             * The player walks renditions, so a extractor that returns one good
             * stream and three dead ones is a server that fails partway through
             * for reasons the probe used to call green. Reporting only
             * `streams[0]` also hid the reverse — a host whose first rendition
             * happens to answer while the rest 403 — and both read downstream as
             * "the server is flaky" rather than as a fault with an address.
             */
            for (const [index, stream] of (streams ?? []).entries()) {
                const label = (streams?.length ?? 0) > 1 ? ` #${index + 1}/${streams!.length}` : ""

                if (stream.kind !== "hls") {
                    await step(
                        `media loads${label}`,
                        async () => {
                            const headers = {
                                ...browserHeaders(),
                                ...netHeadersFor(stream.url, extractor.netRules, stream),
                                Range: "bytes=0-2000"
                            }
                            const response = await fetch(stream.url, { headers })
                            return {
                                status: response.status,
                                type: response.headers.get("content-type") ?? "",
                                ranges: response.headers.get("accept-ranges") ?? ""
                            }
                        },
                        r => `HTTP ${r.status}, ${r.type}${r.ranges ? `, ranges: ${r.ranges}` : ""}`,
                        r => (r.status >= 400 ? `HTTP ${r.status} — check the extractor's netRules` : null)
                    )
                    continue
                }

                await step(
                    `manifest loads${label}`,
                    async () => {
                        const rule = netRuleFor(stream.url, extractor.netRules)
                        const headers = netHeadersFor(stream.url, extractor.netRules, stream)
                        const result = await fetchWithRule(stream.url, rule, headers)
                        return { ...result, headers, removed: rule?.removeHeaders ?? [] }
                    },
                    r => {
                        const variants = (r.body.match(/#EXT-X-STREAM-INF/g) ?? []).length
                        const resolutions = [...r.body.matchAll(/RESOLUTION=\d+x(\d+)/g)].map(m => `${m[1]}p`)
                        return variants > 0
                            ? `HTTP ${r.status}, ${variants} variant(s): ${[...new Set(resolutions)].join(", ")}`
                            : `HTTP ${r.status}, single-rendition playlist`
                    },
                    r => {
                        if (r.status >= 400) {
                            const sent = Object.keys(r.headers).join(", ") || "none"
                            const dropped = r.removed.length > 0 ? `, removed: ${r.removed.join(", ")}` : ""
                            return `HTTP ${r.status} (sent: ${sent}${dropped}) — check the extractor's netRules`
                        }
                        if (!r.body.startsWith("#EXTM3U")) return "response is not an HLS playlist"
                        return null
                    }
                )
            }
        }
    }
}

/**
 * A browser-shaped User-Agent, because Node's default is a tell.
 *
 * The documented blind spot is this probe being *too strong* — Node can set a
 * `Referer` a browser cannot, so a host that demands one passes here and fails
 * in the extension. Node's default `User-Agent` is the same blind spot pointing
 * the other way: luluvdo's CDN 403s it and serves a browser one, 3/3 each way,
 * so the probe failed a stream the extension fetches fine and the obvious next
 * move — adding a netRule — would have been wrong twice over, since Chrome does
 * not let an extension set a UA and the real one is already browser-shaped.
 * Sending one here keeps the probe's *weaknesses* the same as a browser's; the
 * Lab is still what settles the strengths.
 */
function browserHeaders(): Record<string, string> {
    return {
        "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        // Mirrors BASE_HEADERS in src/net/fetcher.ts on purpose. Some hosts bind
        // a signed URL to the header set that minted it — luluvdo does — so a
        // stream fetch that sends a different set than the extractor's fetch is a
        // different client and gets a 403. Minting through `ctx` and spending
        // through a bare fetch was exactly that mismatch, and it looked like a
        // flaky CDN until the two were lined up.
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
    }
}

/** Mirror what background/dnr.ts installs, so the probe tests the real path. */
function netRuleFor(url: string, rules: readonly ExtractorNetRule[] | undefined): ExtractorNetRule | undefined {
    if (!rules) return undefined
    const host = new URL(url).hostname
    return rules.find(rule => {
        const token = rule.urlFilter?.replace(/^\|\|/, "")
        const byFilter = token ? host === token || host.endsWith(`.${token}`) : false
        const byDomain = rule.requestDomains?.some(d => host === d || host.endsWith(`.${d}`)) ?? false
        return byFilter || byDomain
    })
}

/**
 * Headers the extension will end up sending: the extractor's declared rules,
 * plus anything the stream itself asked for. The second half matters because a
 * host whose CDN rotates cannot be written into a static rule — the extension
 * installs those at playback time, and skipping them here reported a working
 * stream as a 403.
 */
function netHeadersFor(
    url: string,
    rules: readonly ExtractorNetRule[] | undefined,
    stream?: { headers?: Record<string, string> }
): Record<string, string> {
    const rule = netRuleFor(url, rules)
    return {
        ...(rule?.referer ? { Referer: rule.referer } : {}),
        ...(rule?.origin ? { Origin: rule.origin } : {}),
        ...(stream?.headers ?? {})
    }
}

/**
 * Fetch honouring a rule's `removeHeaders`.
 *
 * Node's fetch always sends `Accept-Encoding` and offers no way to drop it, the
 * same limitation the extension has — which is exactly why the real fix is a DNR
 * removal rule. `node:https` lets the probe send precisely the header set the
 * extension will end up sending, so this check tests the real thing rather than
 * an approximation.
 */
async function fetchWithRule(
    url: string,
    rule: ExtractorNetRule | undefined,
    headers: Record<string, string>
): Promise<{ status: number; body: string }> {
    const removals = (rule?.removeHeaders ?? []).map(h => h.toLowerCase())
    if (removals.length === 0) {
        const response = await fetch(url, { headers: { ...browserHeaders(), ...headers } })
        return { status: response.status, body: response.ok ? await response.text() : "" }
    }

    const https = await import("node:https")
    const target = new URL(url)
    const cookie = cookieHeaderFor(url)
    const sendHeaders: Record<string, string> = {
        accept: "*/*",
        ...browserHeaders(),
        ...(cookie ? { cookie } : {}),
        ...headers
    }
    for (const name of Object.keys(sendHeaders)) {
        if (removals.includes(name.toLowerCase())) delete sendHeaders[name]
    }

    return new Promise((resolve, reject) => {
        const request = https.get(
            {
                host: target.hostname,
                path: target.pathname + target.search,
                port: target.port || 443,
                headers: sendHeaders
            },
            response => {
                let body = ""
                response.setEncoding("utf8")
                response.on("data", chunk => (body += chunk))
                response.on("end", () => resolve({ status: response.statusCode ?? 0, body }))
            }
        )
        request.on("error", reject)
        request.setTimeout(25_000, () => request.destroy(new Error("timed out")))
    })
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
