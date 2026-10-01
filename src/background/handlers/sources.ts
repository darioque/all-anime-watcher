import { on } from "../router"
import { allSources, sourceById } from "~/sources/registry"
import { getAllSourceState } from "~/model/db"
import { fetchCtxFor } from "~/library/library"
import { setSourceSettings } from "~/settings/storage"
import { resolve } from "~/settings/resolver"
import { latestEpisodeNumber } from "~/model/keys"
import { pinDomain, resolveAllDomains, resolveDomains } from "../domains"
import type { SourceDescriptor } from "~/shared/messages"

export function registerSourceHandlers() {
    on("sources:list", async () => {
        const states = new Map((await getAllSourceState()).map(s => [s.sourceId, s]))
        return allSources().map<SourceDescriptor>(source => {
            const state = states.get(source.id)
            const preferred = state?.pinnedDomain ?? state?.preferredDomain
            return {
                id: source.id,
                name: source.name,
                languages: [...source.languages],
                domains: [...source.domains],
                home: source.home,
                enabled: !source.retired && (state?.enabled ?? true),
                ...(source.retired ? { retired: source.retired } : {}),
                hasDomainSource: Boolean(source.domainSource),
                ...(source.categories?.length ? { categories: [...source.categories] } : {}),
                knownDomains: state?.knownDomains ?? [...source.domains],
                lastDomainCheckAt: state?.lastDomainCheckAt ?? 0,
                ...(preferred ? { preferredDomain: preferred } : {}),
                ...(state?.pinnedDomain ? { pinnedDomain: state.pinnedDomain } : {}),
                ...(state?.lastDomainCheckResult ? { lastDomainCheckResult: state.lastDomainCheckResult } : {})
            }
        })
    })

    on("sources:search", async ({ sourceId, query }) => {
        const source = sourceById(sourceId)
        if (!source) throw new Error(`unknown source "${sourceId}"`)
        if (source.retired) throw new Error(`${source.name} is retired`)
        const ctx = await fetchCtxFor(source)
        const results = await source.search(query, ctx)
        return results.map(r => ({
            title: r.title,
            url: r.url,
            seriesId: r.seriesId,
            ...(r.poster ? { poster: r.poster } : {})
        }))
    })

    on("sources:latestEpisode", async ({ sourceId, seriesUrl }) => {
        const source = sourceById(sourceId)
        if (!source) throw new Error(`unknown source "${sourceId}"`)
        if (source.retired) throw new Error(`${source.name} is retired`)
        return politely(sourceId, async () => {
            const episodes = await source.getEpisodes(seriesUrl, await fetchCtxFor(source))
            return { latest: latestEpisodeNumber({ episodes }), count: episodes.length }
        })
    })

    on("sources:resolveDomains", async ({ sourceId, force }) => {
        if (!sourceId) return resolveAllDomains({ force: force ?? true })

        const source = sourceById(sourceId)
        if (!source) throw new Error(`unknown source "${sourceId}"`)
        const result = await resolveDomains(source, { force: force ?? true })
        return result ? [result] : []
    })

    on("sources:pinDomain", async ({ sourceId, host }) => {
        const state = await pinDomain(sourceId, host)
        return state !== null
    })

    on("sources:setSettings", async ({ sourceId, patch }) => setSourceSettings(sourceId, patch))
}

/**
 * One request at a time per site, `sourceRequestDelaySec` apart.
 *
 * The search page asks for the latest episode of every hit it shows, which for
 * one query can be a dozen series on the same site. That is the update loop's
 * situation exactly — and its rule, parallel across sites and never within one,
 * applies here for the same reason. Kept in the background rather than the
 * page so a second open search, or a popup and a library tab at once, share
 * the one queue.
 */
const queues = new Map<string, Promise<unknown>>()
const lastRequestAt = new Map<string, number>()

function politely<T>(sourceId: string, work: () => Promise<T>): Promise<T> {
    const run = async () => {
        const gapMs = Math.max(0, resolve("sourceRequestDelaySec", { sourceId })) * 1000
        const wait = (lastRequestAt.get(sourceId) ?? 0) + gapMs - Date.now()
        if (wait > 0) await new Promise(done => setTimeout(done, wait))
        try {
            return await work()
        } finally {
            lastRequestAt.set(sourceId, Date.now())
        }
    }
    const next = (queues.get(sourceId) ?? Promise.resolve()).then(run, run)
    queues.set(
        sourceId,
        next.catch(() => undefined)
    )
    return next
}
