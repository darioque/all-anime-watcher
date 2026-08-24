import { openDB, type DBSchema, type IDBPDatabase } from "idb"
import type { SourceState, TrackedAnime } from "./types"
import { log } from "~/shared/logger"

const logger = log("db")

const DB_NAME = "all-anime-watcher"
const DB_VERSION = 1

interface AawDB extends DBSchema {
    anime: {
        key: string
        value: TrackedAnime
        indexes: { bySource: string; byNextCheck: number }
    }
    sourceState: {
        key: string
        value: SourceState
    }
}

let dbPromise: Promise<IDBPDatabase<AawDB>> | null = null

function db() {
    if (!dbPromise) {
        dbPromise = openDB<AawDB>(DB_NAME, DB_VERSION, {
            upgrade(database, oldVersion) {
                logger.info(`upgrading schema from v${oldVersion} to v${DB_VERSION}`)
                if (!database.objectStoreNames.contains("anime")) {
                    const store = database.createObjectStore("anime", { keyPath: "key" })
                    store.createIndex("bySource", "sourceId")
                    store.createIndex("byNextCheck", "nextCheckAt")
                }
                if (!database.objectStoreNames.contains("sourceState")) {
                    database.createObjectStore("sourceState", { keyPath: "sourceId" })
                }
            },
            blocked() {
                logger.warn("another tab is holding an older version of the database open")
            }
        })
    }
    return dbPromise
}

// ---------------------------------------------------------------- anime

export async function getAnime(key: string): Promise<TrackedAnime | undefined> {
    return (await db()).get("anime", key)
}

export async function getAllAnime(): Promise<TrackedAnime[]> {
    return (await db()).getAll("anime")
}

export async function getAnimeBySource(sourceId: string): Promise<TrackedAnime[]> {
    return (await db()).getAllFromIndex("anime", "bySource", sourceId)
}

export async function putAnime(anime: TrackedAnime): Promise<void> {
    await (await db()).put("anime", anime)
}

export async function putManyAnime(list: TrackedAnime[]): Promise<void> {
    const tx = (await db()).transaction("anime", "readwrite")
    await Promise.all([...list.map(a => tx.store.put(a)), tx.done])
}

export async function deleteAnime(key: string): Promise<void> {
    await (await db()).delete("anime", key)
}

export async function countAnime(): Promise<number> {
    return (await db()).count("anime")
}

/**
 * Entries the scheduler should look at, soonest first. `limit` keeps a single
 * wake-up from trying to check a thousand series at once.
 */
export async function getDueAnime(now: number, limit: number): Promise<TrackedAnime[]> {
    const database = await db()
    const due: TrackedAnime[] = []
    let cursor = await database.transaction("anime").store.index("byNextCheck").openCursor()
    while (cursor && due.length < limit) {
        if (cursor.value.nextCheckAt > now) break
        if (cursor.value.poll) due.push(cursor.value)
        cursor = await cursor.continue()
    }
    return due
}

// ---------------------------------------------------------------- source state

export async function getSourceState(sourceId: string): Promise<SourceState | undefined> {
    return (await db()).get("sourceState", sourceId)
}

export async function getAllSourceState(): Promise<SourceState[]> {
    return (await db()).getAll("sourceState")
}

export async function putSourceState(state: SourceState): Promise<void> {
    await (await db()).put("sourceState", state)
}

/** Wipe everything. Used by import-replace and by the debug page. */
export async function clearAll(): Promise<void> {
    const database = await db()
    const tx = database.transaction(["anime", "sourceState"], "readwrite")
    await Promise.all([tx.objectStore("anime").clear(), tx.objectStore("sourceState").clear(), tx.done])
}
