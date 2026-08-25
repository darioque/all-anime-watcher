import browser from "webextension-polyfill"
import { on } from "../router"
import { refreshBadge } from "../badge"
import { libraryChanged } from "../broadcast"
import { getAllAnime, getAnime } from "~/model/db"
import {
    addSeries,
    markWatched,
    refreshSeries,
    remove,
    rename,
    setCategories,
    bulkCategory,
    resetWatchStatus,
    setFlags,
    setSchedule,
    updateProgress
} from "~/library/library"
import { runDueChecks, schedulerStatus } from "../scheduler"
import { testNotification } from "../notifications"

export function registerLibraryHandlers() {
    on("library:list", async () => {
        const all = await getAllAnime()
        return all.sort((a, b) => b.lastEpisodeFoundAt - a.lastEpisodeFoundAt || b.addedAt - a.addedAt)
    })

    on("library:get", async ({ key }) => (await getAnime(key)) ?? null)

    on("library:add", async ({ sourceId, seriesUrl, seriesId, title, poster }) => {
        const anime = await addSeries({
            sourceId,
            seriesUrl,
            ...(seriesId ? { seriesId } : {}),
            ...(title ? { title } : {}),
            ...(poster ? { poster } : {})
        })
        await refreshBadge()
        libraryChanged("added", anime.key)
        return anime
    })

    on("library:remove", async ({ key }) => {
        const removed = await remove(key)
        await refreshBadge()
        libraryChanged("removed", key)
        return removed
    })

    on("library:setFlags", async ({ key, follow, poll }) => {
        const anime = await setFlags(key, {
            ...(follow !== undefined ? { follow } : {}),
            ...(poll !== undefined ? { poll } : {})
        })
        await refreshBadge()
        libraryChanged("flags", key)
        return anime
    })

    on("library:setCategories", async ({ key, categories }) => {
        const anime = await setCategories(key, categories)
        libraryChanged("categories", key)
        return anime
    })

    on("library:bulkCategory", async ({ keys, categoryId, action }) => {
        const changed = await bulkCategory(keys, categoryId, action)
        if (changed > 0) libraryChanged("categories")
        return changed
    })

    on("library:rename", async ({ key, displayTitle }) => {
        const anime = await rename(key, displayTitle)
        libraryChanged("renamed", key)
        return anime
    })

    on("library:checkAll", async ({ force }) => runDueChecks({ force: force ?? true }))

    on("scheduler:status", async () => schedulerStatus())

    on("library:resetWatch", async ({ key }) => {
        const anime = await resetWatchStatus(key)
        await refreshBadge()
        libraryChanged("watch-reset", key)
        return anime
    })

    on("debug:testNotification", async () => testNotification())

    on("library:setSchedule", async ({ key, schedule }) => {
        const anime = await setSchedule(key, schedule)
        libraryChanged("schedule", key)
        return anime
    })

    on("library:markWatched", async ({ key, number, variant, force }) => {
        const anime = await markWatched(key, number, variant, { force: force ?? false })
        await refreshBadge()
        libraryChanged("position", key)
        return anime
    })

    on("library:refresh", async ({ key }) => {
        const { anime } = await refreshSeries(key)
        await refreshBadge()
        libraryChanged("refreshed", key)
        return anime
    })

    on("progress:update", async payload => {
        const result = await updateProgress(payload)
        // Crossing the completion threshold changes the unwatched count. The
        // broadcast is gated on that too: this fires every few seconds while
        // something is playing, and an open library has no use for the position
        // inside an episode.
        if (result?.advanced) {
            await refreshBadge()
            libraryChanged("position", payload.key)
        }
        return result !== null
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
