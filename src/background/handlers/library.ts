import browser from "webextension-polyfill"
import { on } from "../router"
import { refreshBadge } from "../badge"
import { getAllAnime, getAnime } from "~/model/db"
import { addSeries, refreshSeries, remove, rename, setFlags } from "~/library/library"

export function registerLibraryHandlers() {
    on("library:list", async () => {
        const all = await getAllAnime()
        return all.sort((a, b) => b.lastEpisodeFoundAt - a.lastEpisodeFoundAt || b.addedAt - a.addedAt)
    })

    on("library:get", async ({ key }) => (await getAnime(key)) ?? null)

    on("library:add", async ({ sourceId, seriesUrl }) => {
        const anime = await addSeries({ sourceId, seriesUrl })
        await refreshBadge()
        return anime
    })

    on("library:remove", async ({ key }) => {
        const removed = await remove(key)
        await refreshBadge()
        return removed
    })

    on("library:setFlags", async ({ key, follow, poll }) => {
        const anime = await setFlags(key, {
            ...(follow !== undefined ? { follow } : {}),
            ...(poll !== undefined ? { poll } : {})
        })
        await refreshBadge()
        return anime
    })

    on("library:rename", async ({ key, displayTitle }) => rename(key, displayTitle))

    on("library:refresh", async ({ key }) => {
        const { anime } = await refreshSeries(key)
        await refreshBadge()
        return anime
    })

    on("tab:open", async ({ url, active }) => {
        await browser.tabs.create({ url, active: active ?? true })
        return true
    })
}
