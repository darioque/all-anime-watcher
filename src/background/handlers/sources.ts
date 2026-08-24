import { on } from "../router"
import { allSources, sourceById } from "~/sources/registry"
import { getAllSourceState } from "~/model/db"
import { fetchCtxFor } from "~/library/library"
import type { SourceDescriptor } from "~/shared/messages"

export function registerSourceHandlers() {
    on("sources:list", async () => {
        const states = new Map((await getAllSourceState()).map(s => [s.sourceId, s]))
        return allSources().map<SourceDescriptor>(source => {
            const state = states.get(source.id)
            return {
                id: source.id,
                name: source.name,
                languages: [...source.languages],
                domains: [...source.domains],
                home: source.home,
                enabled: state?.enabled ?? true,
                ...((state?.pinnedDomain ?? state?.preferredDomain)
                    ? { preferredDomain: state?.pinnedDomain ?? state?.preferredDomain }
                    : {})
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
}
