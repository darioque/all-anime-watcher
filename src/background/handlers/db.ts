import browser from "webextension-polyfill"
import { on } from "../router"
import { libraryChanged } from "../broadcast"
import {
    countAnime,
    countSourceState,
    deleteAnime,
    deleteSourceState,
    getAllAnime,
    getAllSourceState,
    getAnime,
    getSourceState,
    putAnime,
    putSourceState
} from "~/model/db"
import { CHAINED_SETTINGS, type DebugReport, type Row, type StoreId } from "~/model/inspect"
import type { SourceState, TrackedAnime } from "~/model/types"
import { resolve } from "~/settings/resolver"
import { cachedSourceSettings } from "~/settings/storage"
import { log } from "~/shared/logger"

const logger = log("db-page")

/**
 * The Database page's back end: read, write and delete rows of whichever store,
 * without the page needing to know that two of them are IndexedDB and one is
 * `storage.local`.
 *
 * It goes through the router rather than opening IndexedDB in the page — which
 * is what AMR's equivalent does — for one reason that matters: a write from the
 * page has to reach the rest of the extension. Editing a row directly would
 * leave an open library tab showing the old value until it was reloaded by hand,
 * and the point of the page is to see what is really there.
 */
export function registerDbHandlers() {
    on("db:stores", async () => [
        { id: "anime" as const, count: await countAnime() },
        { id: "sourceState" as const, count: await countSourceState() },
        { id: "storage" as const, count: Object.keys(await browser.storage.local.get(null)).length }
    ])

    on("db:rows", async ({ store }) => rowsOf(store))

    on("db:put", async ({ store, row }) => {
        switch (store) {
            case "anime": {
                const anime = row as unknown as TrackedAnime
                await putAnime(anime)
                libraryChanged("database page edit", anime.key)
                break
            }
            case "sourceState":
                await putSourceState(row as unknown as SourceState)
                break
            case "storage": {
                const key = String(row.key)
                // `{ "key": "settings" }` with the value field deleted is an easy
                // thing to write by accident and stores the literal `undefined`,
                // which then reads back as "this setting has never been set".
                if (!("value" in row)) throw new Error(`the row for "${key}" has no "value" field`)
                await browser.storage.local.set({ [key]: row.value })
                // Settings and sourceSettings are cached in this worker; the
                // storage.onChanged listener installed at startup replaces the
                // cache from `newValue`, so nothing here has to reload them.
                if (key === "settings" || key === "sourceSettings") libraryChanged("settings edited by hand")
                break
            }
        }
        logger.info(`wrote one row to ${store}`)
        return true
    })

    on("db:delete", async ({ store, keys }) => {
        for (const key of keys) {
            if (store === "anime") await deleteAnime(key)
            else if (store === "sourceState") await deleteSourceState(key)
            else await browser.storage.local.remove(key)
        }
        logger.warn(`deleted ${keys.length} row(s) from ${store}`)
        if (store === "anime") libraryChanged("database page delete")
        return keys.length
    })

    /**
     * Everything that decides how one series behaves, in one payload.
     *
     * The entry on its own does not explain its behaviour: a series that never
     * announces an episode looks identical in the database whether the silence
     * is its own override, its source's, or the global default. So the resolved
     * value goes in beside the layers, resolved by the same `resolve()` the real
     * code paths use rather than by a second implementation that could disagree.
     */
    on("debug:report", async ({ key }) => {
        const anime = await getAnime(key)
        if (!anime) throw new Error(`no library entry for "${key}"`)

        const effective: DebugReport["effective"] = {}
        for (const name of CHAINED_SETTINGS) {
            effective[name] = resolve(name, { anime, sourceId: anime.sourceId })
        }

        const manifest = browser.runtime.getManifest()
        return {
            app: `${manifest.name} ${manifest.version}`,
            at: new Date().toISOString(),
            anime,
            source: {
                state: (await getSourceState(anime.sourceId)) ?? null,
                settings: cachedSourceSettings()[anime.sourceId] ?? null
            },
            effective
        } satisfies DebugReport
    })
}

async function rowsOf(store: StoreId): Promise<Row[]> {
    if (store === "anime") return (await getAllAnime()) as unknown as Row[]
    if (store === "sourceState") return (await getAllSourceState()) as unknown as Row[]

    const all = await browser.storage.local.get(null)
    return Object.entries(all)
        .map(([key, value]) => ({ key, bytes: JSON.stringify(value ?? null).length, value }))
        .sort((left, right) => left.key.localeCompare(right.key))
}
