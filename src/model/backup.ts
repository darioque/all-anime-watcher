import type { EpisodeProgress, SourceState, TrackedAnime, WatchMarker } from "./types"
import type { GlobalSettings, SourceSettings } from "~/settings/schema"

/**
 * The whole library as one file, and the rules for putting it back.
 *
 * This is not a convenience feature. Device sync was dropped on purpose — the
 * library lives on one machine — so export/import is the *only* way data ever
 * leaves or enters this extension. A lossy round-trip here is indistinguishable
 * from data loss, and there is no second copy to recover from.
 *
 * Pure on purpose: no storage, no messaging. "Does everything survive the round
 * trip" is a question you can only answer by actually running it over a
 * realistic library, which means it has to be runnable outside a browser.
 */

export const BACKUP_FORMAT = "all-anime-watcher-backup"
export const BACKUP_VERSION = 1

/** Everything that lives on disk, in the two places it lives. */
export interface BackupParts {
    /** IndexedDB `anime`. */
    anime: TrackedAnime[]
    /** IndexedDB `sourceState`. */
    sourceState: SourceState[]
    /** storage.local `settings`. */
    settings: GlobalSettings
    /** storage.local `sourceSettings`. */
    sourceSettings: Record<string, SourceSettings>
}

export interface Backup extends BackupParts {
    format: string
    version: number
    exportedAt: number
    /** For the human reading the file, and for diagnosing an odd import. */
    appVersion?: string
    /**
     * Redundant with the arrays, deliberately. A truncated file parses as valid
     * JSON far more often than you would like, and a count that disagrees with
     * what followed it is the cheapest way to catch that before writing.
     */
    counts: { anime: number; sourceState: number }
}

export function buildBackup(parts: BackupParts, meta: { exportedAt: number; appVersion?: string }): Backup {
    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: meta.exportedAt,
        ...(meta.appVersion ? { appVersion: meta.appVersion } : {}),
        counts: { anime: parts.anime.length, sourceState: parts.sourceState.length },
        // Spread, never rebuilt field by field. A record written by a *newer*
        // version of this extension carries fields this one has no name for, and
        // reconstructing would silently drop them — which is exactly the failure
        // an export is supposed to be insurance against.
        settings: parts.settings,
        sourceSettings: parts.sourceSettings,
        sourceState: parts.sourceState,
        anime: parts.anime
    }
}

/** Indented on purpose: a backup you can open, read and diff is worth the bytes. */
export function serializeBackup(backup: Backup): string {
    return `${JSON.stringify(backup, null, 2)}\n`
}

/**
 * Parse and check a backup file, without touching what is inside the records.
 *
 * Validation is deliberately shallow — enough to be sure this is one of our
 * files and that the entries have the fields the code below indexes on, and no
 * more. Anything stricter would reject a file written by a later version for
 * having fields we do not recognise, which is precisely when you most need the
 * import to work.
 */
export function readBackup(text: string): Backup {
    let raw: unknown
    try {
        raw = JSON.parse(text)
    } catch (error) {
        throw new Error(`that is not a JSON file — ${error instanceof Error ? error.message : String(error)}`)
    }

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("that file does not contain an object")
    }
    const backup = raw as Partial<Backup>

    if (backup.format !== BACKUP_FORMAT) {
        throw new Error(
            backup.format === undefined
                ? "that file is not an All Anime Watcher backup — it has no format marker"
                : `that file says it is "${String(backup.format)}", not an All Anime Watcher backup`
        )
    }
    if (typeof backup.version !== "number" || backup.version > BACKUP_VERSION) {
        throw new Error(
            `that backup is version ${String(backup.version)}; this build understands up to ${BACKUP_VERSION}. ` +
                `Update the extension rather than importing it.`
        )
    }

    const anime = requireArray(backup.anime, "anime")
    const sourceState = requireArray(backup.sourceState, "sourceState")

    // The counts are the truncation check. They are only advisory in a file
    // written by hand, so a missing one is fine; a wrong one is not.
    if (backup.counts && typeof backup.counts.anime === "number" && backup.counts.anime !== anime.length) {
        throw new Error(
            `that backup says it holds ${backup.counts.anime} series but ${anime.length} are in the file. ` +
                `It is probably truncated — importing it would lose the rest.`
        )
    }

    for (const [index, entry] of anime.entries()) {
        const problem = animeProblem(entry)
        if (problem) throw new Error(`series #${index + 1} in that backup ${problem}`)
    }
    for (const [index, entry] of sourceState.entries()) {
        if (typeof (entry as SourceState)?.sourceId !== "string") {
            throw new Error(`source state #${index + 1} in that backup has no sourceId`)
        }
    }

    return {
        ...backup,
        format: BACKUP_FORMAT,
        version: backup.version,
        exportedAt: typeof backup.exportedAt === "number" ? backup.exportedAt : 0,
        counts: { anime: anime.length, sourceState: sourceState.length },
        settings: (backup.settings ?? {}) as GlobalSettings,
        sourceSettings: backup.sourceSettings ?? {},
        sourceState: sourceState as SourceState[],
        anime: anime as TrackedAnime[]
    }
}

function requireArray(value: unknown, name: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`that backup has no "${name}" list`)
    return value
}

/** What is wrong with one entry, or null. Phrased to finish "series #3 …". */
function animeProblem(entry: unknown): string | null {
    if (typeof entry !== "object" || entry === null) return "is not an object"
    const anime = entry as Partial<TrackedAnime>
    if (typeof anime.key !== "string" || anime.key === "") return "has no key"
    if (typeof anime.sourceId !== "string" || anime.sourceId === "") return `(${anime.key}) has no sourceId`
    if (!Array.isArray(anime.episodes)) return `(${anime.key}) has no episode list`
    if (typeof anime.progress !== "object" || anime.progress === null) return `(${anime.key}) has no progress map`
    return null
}

// ------------------------------------------------------------------- importing

export type ImportMode = "replace" | "merge"

export interface ImportOptions {
    mode: ImportMode
    /** Restore settings and per-source settings too, or leave the local ones. */
    settings: boolean
}

export interface ImportPlan {
    mode: ImportMode
    anime: TrackedAnime[]
    sourceState: SourceState[]
    /** null means "leave what is there". */
    settings: GlobalSettings | null
    sourceSettings: Record<string, SourceSettings> | null
    summary: ImportSummary
}

export interface ImportSummary {
    /** In the backup, not in the library. */
    added: number
    /** In both, and the merge produced something different from what was there. */
    updated: number
    /** In both, and nothing changed. */
    unchanged: number
    /** In the library, not in the backup. Kept by merge, dropped by replace. */
    localOnly: number
}

/**
 * Work out exactly what an import would write, before writing any of it.
 *
 * Separated from the writing so the UI can say "this will remove 12 series" and
 * mean it, and so the interesting half is testable. `replace` is the honest
 * restore — afterwards the library *is* the file. `merge` is the one with
 * judgement in it, and the rule it follows is stated in `mergeAnime`.
 */
export function planImport(local: BackupParts, backup: Backup, options: ImportOptions): ImportPlan {
    const settings = options.settings ? (backup.settings ?? null) : null
    const sourceSettings = options.settings ? (backup.sourceSettings ?? null) : null

    const byKey = new Map(local.anime.map(entry => [entry.key, entry]))

    if (options.mode === "replace") {
        return {
            mode: "replace",
            anime: backup.anime,
            sourceState: backup.sourceState,
            settings,
            sourceSettings,
            summary: {
                added: backup.anime.filter(entry => !byKey.has(entry.key)).length,
                updated: backup.anime.filter(entry => byKey.has(entry.key)).length,
                unchanged: 0,
                localOnly: local.anime.filter(entry => !backup.anime.some(other => other.key === entry.key)).length
            }
        }
    }

    let added = 0
    let updated = 0
    let unchanged = 0

    const merged = new Map(byKey)
    for (const incoming of backup.anime) {
        const existing = merged.get(incoming.key)
        if (!existing) {
            merged.set(incoming.key, incoming)
            added++
            continue
        }
        const result = mergeAnime(existing, incoming)
        merged.set(incoming.key, result)
        if (same(result, existing)) unchanged++
        else updated++
    }

    const stateByKey = new Map(local.sourceState.map(state => [state.sourceId, state]))
    for (const incoming of backup.sourceState) {
        const existing = stateByKey.get(incoming.sourceId)
        stateByKey.set(incoming.sourceId, existing ? mergeSourceState(existing, incoming) : incoming)
    }

    return {
        mode: "merge",
        anime: [...merged.values()],
        sourceState: [...stateByKey.values()],
        settings,
        sourceSettings,
        summary: {
            added,
            updated,
            unchanged,
            localOnly: local.anime.filter(entry => !backup.anime.some(other => other.key === entry.key)).length
        }
    }
}

/**
 * One series present on both sides.
 *
 * There is no sync clock to appeal to — that was dropped along with sync — so
 * the rule has to be one a person can predict:
 *
 *   whichever record was touched more recently wins the field,
 *   *except* for the things that are history rather than state.
 *
 * Watch history is never lost. A completed episode stays completed, the position
 * goes to whichever side got further, and `addedAt` keeps the earlier date
 * because that is a fact about the past, not a preference. Everything else —
 * title, poster, flags, categories, overrides, the episode list — follows
 * `updatedAt`, and anything wrong there heals on the next check.
 */
export function mergeAnime(local: TrackedAnime, incoming: TrackedAnime): TrackedAnime {
    const newer = incoming.updatedAt >= local.updatedAt ? incoming : local
    const older = newer === incoming ? local : incoming

    const merged: TrackedAnime = {
        // Spread rather than list the fields: a record from a newer version
        // carries keys this build cannot name, and they must survive a merge for
        // the same reason they must survive an export.
        ...older,
        ...newer,
        addedAt: Math.min(local.addedAt || Infinity, incoming.addedAt || Infinity) || newer.addedAt,
        progress: mergeProgress(local.progress, incoming.progress),
        lastEpisodeFoundAt: Math.max(local.lastEpisodeFoundAt ?? 0, incoming.lastEpisodeFoundAt ?? 0),
        // Sorted, because a union's order is otherwise just whichever side was
        // passed first — see mergeProgress for why that matters here.
        categories: [...new Set([...(local.categories ?? []), ...(incoming.categories ?? [])])].sort()
    }

    const position = furthest(local.lastWatched, incoming.lastWatched)
    if (position) merged.lastWatched = position
    else delete merged.lastWatched

    return merged
}

/** The one that got further; a tie goes to whichever was recorded later. */
function furthest(a?: WatchMarker, b?: WatchMarker): WatchMarker | undefined {
    if (!a) return b
    if (!b) return a
    if (a.number !== b.number) return a.number > b.number ? a : b
    return a.at >= b.at ? a : b
}

/**
 * Union of two progress maps.
 *
 * `completed` is sticky: it is the only field here whose loss is visible and
 * irreversible, since nothing re-derives "I have seen this". The position
 * follows the more recent write, which is right even when it is *smaller* —
 * restarting an episode is a real thing to have done. An entry that loses is
 * replaced whole rather than blended, so the position and the duration always
 * come from the same moment.
 *
 * The result is written back in episode order rather than in whichever order the
 * two maps happened to be walked in. That makes merging symmetric — importing A
 * over B gives the same object as B over A — which is what lets `planImport`
 * compare records structurally to tell "changed" from "already identical". It
 * also makes the exported file readable, which is half the point of exporting
 * something a person can open.
 */
function mergeProgress(
    local: Record<string, EpisodeProgress>,
    incoming: Record<string, EpisodeProgress>
): Record<string, EpisodeProgress> {
    const merged: Record<string, EpisodeProgress> = { ...local }

    for (const [key, entry] of Object.entries(incoming)) {
        const existing = merged[key]
        if (!existing) {
            merged[key] = entry
            continue
        }
        const newer = entry.updatedAt >= existing.updatedAt ? entry : existing
        merged[key] = { ...newer, completed: existing.completed || entry.completed }
    }

    return inEpisodeOrder(merged)
}

/** `progressKey` is "<number>:<variant>", so sort on the number then the rest. */
function inEpisodeOrder(map: Record<string, EpisodeProgress>): Record<string, EpisodeProgress> {
    const keys = Object.keys(map).sort((a, b) => {
        const byNumber = (Number.parseFloat(a) || 0) - (Number.parseFloat(b) || 0)
        return byNumber !== 0 ? byNumber : a.localeCompare(b)
    })

    const ordered: Record<string, EpisodeProgress> = {}
    for (const key of keys) ordered[key] = map[key]!
    return ordered
}

/**
 * Source state is machine-local runtime data, so the newer check wins — except
 * `pinnedDomain`, which the user chose by hand and automatic resolution is
 * already forbidden from overwriting.
 */
function mergeSourceState(local: SourceState, incoming: SourceState): SourceState {
    const newer = incoming.lastDomainCheckAt >= local.lastDomainCheckAt ? incoming : local
    const older = newer === incoming ? local : incoming

    const merged: SourceState = {
        ...older,
        ...newer,
        knownDomains: [...new Set([...(local.knownDomains ?? []), ...(incoming.knownDomains ?? [])])].sort()
    }

    const pinned = local.pinnedDomain ?? incoming.pinnedDomain
    if (pinned) merged.pinnedDomain = pinned
    else delete merged.pinnedDomain

    return merged
}

/** Structural equality, used only to count "nothing actually changed". */
function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
}
