import { getAnimeBySource, getSourceState, putAnime, putSourceState } from "~/model/db"
import type { SourceState } from "~/model/types"
import type { AnimeSource } from "~/sources/types"
import { allSources, sourceById } from "~/sources/registry"
import { createFetchCtx } from "~/net/fetcher"
import { cachedSettings } from "~/settings/storage"
import { hostOf, swapOrigin } from "~/shared/url"
import { log } from "~/shared/logger"

const logger = log("domains")

const HOUR = 3_600_000
const HEALTH_TIMEOUT_MS = 12_000

export interface DomainResolution {
    sourceId: string
    /** Host in use before this run. */
    previous: string
    /** Host in use after it. */
    current: string
    moved: boolean
    /** Every host that answered. */
    healthy: string[]
    /** Hosts discovered from the announcement page this run. */
    discovered: string[]
    /** Library entries whose stored URL was rewritten. */
    rewritten: number
    error?: string
}

/**
 * Keep up with a site that has moved.
 *
 * These sites rotate hosts constantly and several publish where they went —
 * anikoto lists its live domains on a separate static page. So: read the
 * announcement, health-check every candidate, and promote one that answers.
 *
 * The reason this is cheap rather than a migration is that identity never comes
 * from a URL. A library key is `sourceId/seriesId`, so a domain move only has to
 * rewrite the *navigation* URLs — nothing about what the user has watched, or
 * their settings, or their schedule, is touched.
 */
export async function resolveDomains(
    source: AnimeSource,
    options: { force?: boolean } = {}
): Promise<DomainResolution | null> {
    const state = await ensureState(source)

    // A pinned domain is the user's decision and outranks anything we discover.
    if (state.pinnedDomain) {
        logger.debug(`${source.id}: pinned to ${state.pinnedDomain}, skipping`)
        return null
    }

    const intervalMs = Math.max(1, cachedSettings().domainCheckIntervalHours) * HOUR
    if (!options.force && Date.now() - state.lastDomainCheckAt < intervalMs) {
        return null
    }

    const previous = currentHost(source, state)
    const result: DomainResolution = {
        sourceId: source.id,
        previous,
        current: previous,
        moved: false,
        healthy: [],
        discovered: [],
        rewritten: 0
    }

    // 1. Ask the site where it lives now, if it says.
    if (source.domainSource) {
        try {
            result.discovered = await discover(source)
        } catch (error) {
            logger.warn(`${source.id}: could not read the domain list`, error)
        }
    }

    // 2. Candidates, current host first so a working site stays put.
    const candidates = [...new Set([previous, ...state.knownDomains, ...source.domains, ...result.discovered])].filter(
        host => host !== ""
    )

    // 3. Health-check in order and stop at the first that answers. Checking all
    //    of them would be tidier and would also hammer every mirror of a site
    //    that is working perfectly well.
    let promoted: string | null = null
    for (const host of candidates) {
        if (await isHealthy(host, source)) {
            result.healthy.push(host)
            promoted = host
            break
        }
        logger.debug(`${source.id}: ${host} did not answer`)
    }

    state.knownDomains = [...new Set([...state.knownDomains, ...source.domains, ...result.discovered])]
    state.lastDomainCheckAt = Date.now()

    if (!promoted) {
        state.lastDomainCheckResult = "unreachable"
        result.error = "no known domain answered"
        await putSourceState(state)
        logger.warn(`${source.id}: nothing answered — tried ${candidates.join(", ")}`)
        return result
    }

    result.current = promoted
    result.moved = promoted !== previous
    state.preferredDomain = promoted
    state.lastDomainCheckResult = result.moved ? "moved" : "ok"
    await putSourceState(state)

    if (result.moved && cachedSettings().autoPromoteDomain) {
        result.rewritten = await rewriteUrls(source.id, promoted)
        logger.info(`${source.id}: ${previous} → ${promoted}, ${result.rewritten} entries updated`)
    } else if (result.moved) {
        logger.info(`${source.id}: ${promoted} answers but auto-promotion is off; leaving URLs alone`)
    }

    return result
}

/** Run every source that is due. Called from the scheduler tick. */
export async function resolveAllDomains(options: { force?: boolean } = {}): Promise<DomainResolution[]> {
    const results: DomainResolution[] = []
    for (const source of allSources()) {
        try {
            const result = await resolveDomains(source, options)
            if (result) results.push(result)
        } catch (error) {
            logger.error(`${source.id}: domain resolution failed`, error)
        }
    }
    return results
}

/** Pin a host, or clear the pin by passing undefined. */
export async function pinDomain(sourceId: string, host: string | undefined): Promise<SourceState | null> {
    const source = sourceById(sourceId)
    if (!source) return null

    const state = await ensureState(source)
    const cleaned = host ? hostOf(host.includes("://") ? host : `https://${host}`) : ""

    if (cleaned) {
        state.pinnedDomain = cleaned
        state.preferredDomain = cleaned
        state.knownDomains = [...new Set([...state.knownDomains, cleaned])]
        await putSourceState(state)
        await rewriteUrls(sourceId, cleaned)
        logger.info(`${sourceId}: pinned to ${cleaned}`)
    } else {
        delete state.pinnedDomain
        await putSourceState(state)
        logger.info(`${sourceId}: pin cleared`)
    }

    return state
}

// ---------------------------------------------------------------- internals

async function ensureState(source: AnimeSource): Promise<SourceState> {
    const existing = await getSourceState(source.id)
    if (existing) return existing
    const state: SourceState = {
        sourceId: source.id,
        knownDomains: [...source.domains],
        lastDomainCheckAt: 0,
        enabled: true
    }
    await putSourceState(state)
    return state
}

export function currentHost(source: AnimeSource, state: SourceState): string {
    return state.pinnedDomain ?? state.preferredDomain ?? source.domains[0] ?? hostOf(source.home)
}

/**
 * Pull candidate hosts out of a site's announcement page.
 *
 * The default rule: any external link whose domain name shares a brand token
 * with a host we already know. anikoto.site lists anikototv.to, anikototv.se,
 * anikoto.me, anikoto.cz and anikoto.net alongside links to Telegram, Reddit and
 * Google Fonts — the token test keeps the first five and drops the rest.
 */
async function discover(source: AnimeSource): Promise<string[]> {
    const config = source.domainSource
    if (!config) return []

    const ctx = createFetchCtx({ baseUrl: new URL(config.url).origin })
    const html = await ctx.text(config.url, { noCache: true, timeoutMs: HEALTH_TIMEOUT_MS })

    if (config.extract) return config.extract(html).map(normalise).filter(Boolean)

    const tokens = brandTokens(source)
    const found = new Set<string>()

    for (const match of html.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
        const host = normalise(match[1] ?? "")
        if (!host) continue
        const name = registrableName(host)
        if (tokens.some(token => name.startsWith(token) || token.startsWith(name))) found.add(host)
    }

    const hosts = [...found]
    logger.debug(`${source.id}: announcement page lists ${hosts.join(", ") || "nothing recognisable"}`)
    return hosts
}

/** "anikototv.to" → "anikototv". Used for brand matching, not for requests. */
function registrableName(host: string): string {
    const parts = host.split(".")
    // Handle two-part TLDs like .co.uk without a public-suffix list.
    const index = parts.length > 2 && (parts.at(-2)?.length ?? 0) <= 3 ? parts.length - 3 : parts.length - 2
    return (parts[Math.max(0, index)] ?? host).toLowerCase()
}

function brandTokens(source: AnimeSource): string[] {
    const names = source.domains.map(registrableName).filter(name => name.length >= 4)
    // Shortest first: "anikoto" should match "anikototv", not the other way round.
    return [...new Set(names)].sort((a, b) => a.length - b.length)
}

function normalise(value: string): string {
    return hostOf(value.includes("://") ? value : `https://${value}`)
}

/**
 * Does this host serve our site?
 *
 * Liveness alone is not enough — a parked domain, a registrar hold page and a
 * Cloudflare error all return HTTP 200. So the body has to mention the brand too.
 */
async function isHealthy(host: string, source: AnimeSource): Promise<boolean> {
    const tokens = brandTokens(source)
    try {
        const ctx = createFetchCtx({ baseUrl: `https://${host}` })
        const html = await ctx.text(`https://${host}/`, { timeoutMs: HEALTH_TIMEOUT_MS, noCache: true })
        if (html.length < 500) return false
        const haystack = html.slice(0, 200_000).toLowerCase()
        return tokens.length === 0 || tokens.some(token => haystack.includes(token))
    } catch {
        return false
    }
}

/** Point every stored URL for a source at the host that answers. */
async function rewriteUrls(sourceId: string, host: string): Promise<number> {
    const entries = await getAnimeBySource(sourceId)
    const origin = `https://${host}`
    let changed = 0

    for (const anime of entries) {
        const url = swapOrigin(anime.url, origin)
        const episodes = anime.episodes.map(episode => ({ ...episode, url: swapOrigin(episode.url, origin) }))
        const episodesChanged = episodes.some((episode, i) => episode.url !== anime.episodes[i]?.url)
        if (url === anime.url && !episodesChanged) continue

        anime.url = url
        anime.episodes = episodes
        anime.updatedAt = Date.now()
        await putAnime(anime)
        changed++
    }

    return changed
}
