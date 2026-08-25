import { on } from "../router"
import { allSources, sourceById } from "~/sources/registry"
import { getAllSourceState } from "~/model/db"
import { fetchCtxFor } from "~/library/library"
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
                enabled: state?.enabled ?? true,
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
        const ctx = await fetchCtxFor(source)
        const results = await source.search(query, ctx)
        return results.map(r => ({
            title: r.title,
            url: r.url,
            seriesId: r.seriesId,
            ...(r.poster ? { poster: r.poster } : {})
        }))
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
}
