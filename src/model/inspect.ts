/**
 * What the Database page knows about the stores it shows, and every judgement it
 * makes about a value — which column to put it in, how to squeeze it into a
 * cell, whether it is an epoch, whether an edit is a legal row.
 *
 * None of it touches IndexedDB or messaging, which is the point: architecture
 * rule 9. A generic table over untyped rows is exactly the kind of code that
 * looks obviously correct and is quietly wrong about `null`, about an empty
 * array, about a field that is a number in one row and a string in the next.
 */
import type { AnimeOverrides, SeriesMeta, SourceState, TrackedAnime } from "./types"
import type { GlobalSettings, SourceSettings } from "~/settings/schema"

/** One row of any store, before anything knows what shape it is. */
export type Row = Record<string, unknown>

export type StoreId = "anime" | "sourceState" | "storage"

export interface StoreSpec {
    id: StoreId
    label: string
    /**
     * The field that identifies a row. Changing it in the editor writes a new
     * row rather than moving the old one — the same thing `put` does everywhere
     * else, and worth knowing before you edit a key.
     */
    keyPath: string
    /** Columns worth a table, best first. Everything else lives in the detail. */
    columns: string[]
    /** Shown under the tab. Says what the store is for, not what it contains. */
    note: string
}

export const STORES: StoreSpec[] = [
    {
        id: "anime",
        label: "Library",
        keyPath: "key",
        columns: ["key", "title", "sourceId", "episodes", "lastWatched", "nextCheckAt", "failCount", "follow"],
        note: "One row per followed series, keyed `sourceId/seriesId`. IndexedDB store `anime`."
    },
    {
        id: "sourceState",
        label: "Source state",
        keyPath: "sourceId",
        columns: [
            "sourceId",
            "enabled",
            "preferredDomain",
            "pinnedDomain",
            "knownDomains",
            "lastDomainCheckAt",
            "lastDomainCheckResult"
        ],
        note: "Which host each site is currently believed to live at. IndexedDB store `sourceState`."
    },
    {
        id: "storage",
        label: "storage.local",
        keyPath: "key",
        columns: ["key", "bytes", "value"],
        note:
            "Settings, per-source settings and the download queue. One row per top-level storage key, " +
            "wrapped as `{ key, value }` — edit the `value` side; the `key` side says where it goes."
    }
]

export function storeSpec(id: StoreId): StoreSpec {
    const spec = STORES.find(store => store.id === id)
    if (!spec) throw new Error(`no such store: ${id}`)
    return spec
}

// ---------------------------------------------------------------- values

function isRecord(value: unknown): value is Row {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Epoch-milliseconds fields, by the convention this codebase actually follows:
 * `addedAt`, `nextCheckAt`, `airedAt`, `lastDomainCheckAt`, and the bare `at` on
 * a watch marker.
 *
 * Matched on the name rather than the value because there is no telling an epoch
 * from an episode count by looking at the number, and guessing by magnitude gets
 * `progressTickSec` wrong the moment someone stores a large one.
 */
export function isEpochField(field: string, value: unknown): boolean {
    if (typeof value !== "number") return false
    return field === "at" || /At$/.test(field)
}

/**
 * `0` is not the epoch here. It is the codebase's "never" — `lastCheckedAt: 0`
 * means never checked, `nextCheckAt: 0` means as soon as convenient — and
 * rendering it as 1 January 1970 turns a normal state into an alarming one.
 */
export function formatEpoch(value: number): string {
    if (value === 0) return "—"
    return new Date(value).toLocaleString()
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * One line for a table cell.
 *
 * A list of objects becomes a count, because five hundred episodes in a cell is
 * the same as no information; a list of scalars keeps its contents while they
 * fit, because `["en", "es"]` is the answer you came for.
 */
export function cellText(value: unknown, max = 64): string {
    if (value === undefined) return ""
    if (value === null) return "null"
    if (typeof value === "boolean") return value ? "yes" : "no"
    if (typeof value === "number" || typeof value === "string") return truncate(String(value), max)
    if (Array.isArray(value)) {
        if (value.length === 0) return "[]"
        const scalars = value.every(item => typeof item === "string" || typeof item === "number")
        if (!scalars) return `${value.length} items`
        const joined = value.join(", ")
        return joined.length <= max ? joined : `${value.length} items`
    }
    if (isRecord(value)) {
        return Object.keys(value).length === 0 ? "{}" : truncate(JSON.stringify(value), max)
    }
    return truncate(String(value), max)
}

/** Everything a row carries that no column claims — the reason to open it. */
export function extraFields(spec: StoreSpec, rows: Row[]): string[] {
    const seen = new Set<string>()
    for (const row of rows) {
        for (const field of Object.keys(row)) {
            if (!spec.columns.includes(field)) seen.add(field)
        }
    }
    return [...seen].sort()
}

// ---------------------------------------------------------------- searching

/** `"*"` searches every field. Anything else searches that one. */
export function filterRows<T extends Row>(rows: T[], query: string, field = "*"): T[] {
    const needle = query.trim().toLowerCase()
    if (needle === "") return rows
    return rows.filter(row => {
        if (field === "*") return Object.values(row).some(value => hit(value, needle))
        return hit(row[field], needle)
    })
}

function hit(value: unknown, needle: string): boolean {
    if (value === undefined || value === null) return false
    // Stringified whole, so searching the library for a domain finds the series
    // whose episode URLs are on it, not only the ones whose title mentions it.
    const text = typeof value === "object" ? JSON.stringify(value) : String(value)
    return text.toLowerCase().includes(needle)
}

// ---------------------------------------------------------------- sorting

/**
 * Sort by one field, with a total order over mixed types so the list never
 * reshuffles depending on which rows happened to load.
 *
 * Missing sorts last in both directions. A row with no `nextCheckAt` is not the
 * soonest thing to check, and pushing it to the top of an ascending sort is the
 * one behaviour that would make the column useless.
 */
export function sortRows<T extends Row>(rows: T[], field: string, descending = false): T[] {
    const direction = descending ? -1 : 1
    return [...rows].sort((left, right) => {
        const a = left[field]
        const b = right[field]
        const aMissing = a === undefined || a === null
        const bMissing = b === undefined || b === null
        if (aMissing || bMissing) return aMissing && bMissing ? 0 : aMissing ? 1 : -1
        return direction * compare(a, b)
    })
}

function compare(a: unknown, b: unknown): number {
    if (typeof a === "number" && typeof b === "number") return a - b
    if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)
    if (Array.isArray(a) && Array.isArray(b)) return a.length - b.length
    return String(cellText(a, 200)).localeCompare(String(cellText(b, 200)), undefined, { numeric: true })
}

// ---------------------------------------------------------------- editing

export type ParsedRow = { ok: true; row: Row } | { ok: false; error: string }

/**
 * Read the JSON editor back.
 *
 * The key check is the one that earns its place: `put` on a row with no key
 * throws a DataError from IndexedDB whose message names neither the store nor
 * the field, and on `storage.local` it silently writes under `"undefined"`.
 */
export function parseRow(text: string, keyPath: string): ParsedRow {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (Array.isArray(parsed) || !isRecord(parsed)) {
        return { ok: false, error: "a row has to be a JSON object" }
    }
    const key = parsed[keyPath]
    if (typeof key !== "string" || key.trim() === "") {
        return { ok: false, error: `"${keyPath}" identifies the row, and has to be a non-empty string` }
    }
    return { ok: true, row: parsed }
}

/** A new row, with only the field that identifies it. */
export function scaffold(spec: StoreSpec): string {
    return JSON.stringify({ [spec.keyPath]: "" }, null, 2)
}

// ---------------------------------------------------------------- debug report

/**
 * What the ⋯ menu's "Copy debug report" puts on the clipboard, and what the
 * Database page offers beside a library row.
 *
 * The entry alone is not enough to explain a series' behaviour, because
 * behaviour is decided three levels up (rule 5): a series that never notifies
 * looks identical in the database whether the silence came from its own
 * override, the source's, or the global default. So the report carries the
 * resolved answer *and* the layers it came from.
 */
export interface DebugReport {
    /** Name and version, because "which build is this" is otherwise unanswerable. */
    app: string
    at: string
    anime: TrackedAnime
    source: { state: SourceState | null; settings: SourceSettings | null }
    /** Every chained setting as it resolves for this series. */
    effective: Partial<Record<ChainedSetting, unknown>>
}

/**
 * Settings that mean something different per series or per source — the ones
 * `resolve()` actually walks a chain for.
 *
 * Deliberately not "every global setting": `categories`, `perPage` and the list
 * sort are library-wide, and reporting them per series would say the chain
 * reaches further than it does.
 */
export type ChainedSetting = (keyof AnimeOverrides | keyof SourceSettings) & keyof GlobalSettings

export const CHAINED_SETTINGS = [
    "schedule",
    "preferredServers",
    "preferredQuality",
    "variantPref",
    "subtitleLanguages",
    "skipIntro",
    "skipOutro",
    "autoAdvance",
    "recoverStalledPlayback",
    "completionThreshold",
    "markWatchedOnOpen",
    "markWatchedOnEmbed",
    "verifyNewEpisodes",
    "releaseDelayMin",
    "takeOverPage",
    "notifyNewEpisode",
    "pushToTracker",
    "sourceRequestDelaySec"
] as const satisfies readonly ChainedSetting[]

/**
 * Compile-time proof that the list above is complete.
 *
 * Adding an override to `AnimeOverrides` or `SourceSettings` and forgetting it
 * here would drop it from every debug report silently — the report would still
 * look full. Instead this line stops compiling, and the error names the key that
 * is missing.
 */
export type MissingFromReport = Exclude<ChainedSetting, (typeof CHAINED_SETTINGS)[number]>
export const everyChainedSettingIsReported: [MissingFromReport] extends [never] ? true : MissingFromReport = true

/** Fields of a series worth a one-line summary above the raw JSON. */
export function summarise(anime: TrackedAnime): string[] {
    const lines = [
        `${anime.displayTitle ?? anime.title} — ${anime.key}`,
        `${anime.episodes.length} episode(s), ${Object.keys(anime.progress).length} with progress`
    ]
    lines.push(
        anime.lastWatched
            ? `last watched E${anime.lastWatched.number}${anime.lastWatched.variant ? ` (${anime.lastWatched.variant})` : ""} at ${formatEpoch(anime.lastWatched.at)}`
            : "never watched"
    )
    lines.push(`follow ${anime.follow ? "on" : "off"}, poll ${anime.poll ? "on" : "off"}`)
    lines.push(`next check ${formatEpoch(anime.nextCheckAt)}, last ${formatEpoch(anime.lastCheckedAt)}`)
    if (anime.failCount > 0) lines.push(`${anime.failCount} failed check(s): ${anime.lastError ?? "no message"}`)
    if (anime.anilistId) lines.push(`AniList ${anime.anilistId}${anime.trackerConfirmed ? " (confirmed)" : ""}`)
    const meta: SeriesMeta | undefined = anime.meta
    if (meta?.countryOfOrigin)
        lines.push(`origin ${meta.countryOfOrigin}, ${meta.format ?? "?"}, ${meta.status ?? "?"}`)
    return lines
}
