import browser from "webextension-polyfill"
import { on } from "../router"
import { refreshBadge } from "../badge"
import { getAllAnime, getAnime } from "~/model/db"
import {
    addSeries,
    markWatched,
    refreshSeries,
    remove,
    rename,
    setFlags,
    setSchedule,
    updateProgress
} from "~/library/library"
import { runDueChecks, schedulerStatus } from "../scheduler"

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

    on("library:checkAll", async ({ force }) => runDueChecks({ force: force ?? true }))

    on("scheduler:status", async () => schedulerStatus())

    on("library:setSchedule", async ({ key, schedule }) => setSchedule(key, schedule))

    on("library:markWatched", async ({ key, number, variant }) => {
        const anime = await markWatched(key, number, variant)
        await refreshBadge()
        return anime
    })

    on("library:refresh", async ({ key }) => {
        const { anime } = await refreshSeries(key)
        await refreshBadge()
        return anime
    })

    on("progress:update", async payload => {
        const anime = await updateProgress(payload)
        // Crossing the completion threshold changes the unwatched count.
        if (anime) await refreshBadge()
        return anime !== null
    })

    on("tab:open", async ({ url, active }) => {
        await browser.tabs.create({ url, active: active ?? true })
        return true
    })

    on("tab:openLibrary", async () => {
        await openLibraryTab()
        return true
    })
}

/**
 * Focus an existing library tab rather than piling up duplicates — the library is
 * a place you keep open, not something you open repeatedly.
 */
export async function openLibraryTab() {
    const url = browser.runtime.getURL("src/ui/library/index.html")
    const existing = await browser.tabs.query({ url })
    const first = existing[0]
    if (first?.id !== undefined) {
        await browser.tabs.update(first.id, { active: true })
        if (first.windowId !== undefined) await browser.windows.update(first.windowId, { focused: true })
        return
    }
    await browser.tabs.create({ url, active: true })
}
