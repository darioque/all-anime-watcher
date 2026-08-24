import type { AnimeOverrides, SchedulePolicy, TrackedAnime } from "~/model/types"
import type { GlobalSettings, SourceSettings } from "./schema"
import { cachedSettings, cachedSourceSettings } from "./storage"

/**
 * The three-level chain: per-anime → per-source → global.
 *
 * Every consumer must read settings through `resolve` rather than reaching for
 * the global object, or the chain quietly rots into scattered `if` statements
 * and the per-anime overrides stop being honoured in half the codebase.
 */
export interface ResolveContext {
    anime?: Pick<TrackedAnime, "overrides"> | null
    sourceId?: string | null
}

/** Keys that exist at all three levels. */
type SharedKey = Extract<keyof AnimeOverrides & keyof SourceSettings & keyof GlobalSettings, string>

export function resolve<K extends keyof GlobalSettings>(key: K, ctx: ResolveContext = {}): GlobalSettings[K] {
    const global = cachedSettings()

    const animeValue = ctx.anime?.overrides?.[key as keyof AnimeOverrides]
    if (animeValue !== undefined && !isInherit(animeValue)) {
        return animeValue as GlobalSettings[K]
    }

    if (ctx.sourceId) {
        const sourceValue = cachedSourceSettings()[ctx.sourceId]?.[key as keyof SourceSettings]
        if (sourceValue !== undefined && !isInherit(sourceValue)) {
            return sourceValue as GlobalSettings[K]
        }
    }

    return global[key]
}

/** A SchedulePolicy of `{ mode: "inherit" }` means "fall through to the next level". */
function isInherit(value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as { mode?: string }).mode === "inherit"
}

/**
 * Schedule needs its own accessor because `inherit` is expressed inside the
 * value rather than by the key being absent.
 *
 * It also fills in `delayMin` for the airing policy from the same three-level
 * chain as everything else. Doing it here rather than inside `nextCheckAt` is
 * what keeps that function a pure function of its arguments — it never reaches
 * for settings, so its date arithmetic stays testable outside an extension.
 */
export function resolveSchedule(
    anime: (Pick<TrackedAnime, "overrides"> & Partial<Pick<TrackedAnime, "sourceId">>) | null | undefined
): SchedulePolicy {
    const own = anime?.overrides?.schedule
    const policy = own && own.mode !== "inherit" ? own : cachedSettings().schedule

    if (policy.mode !== "airing" || policy.delayMin !== undefined) return policy
    return { ...policy, delayMin: resolve("releaseDelayMin", { anime, sourceId: anime?.sourceId }) }
}

/** Where a resolved value came from — shown in the UI so overrides are visible. */
export function resolveOrigin<K extends keyof GlobalSettings>(
    key: K,
    ctx: ResolveContext = {}
): "anime" | "source" | "global" {
    const animeValue = ctx.anime?.overrides?.[key as keyof AnimeOverrides]
    if (animeValue !== undefined && !isInherit(animeValue)) return "anime"
    if (ctx.sourceId) {
        const sourceValue = cachedSourceSettings()[ctx.sourceId]?.[key as keyof SourceSettings]
        if (sourceValue !== undefined && !isInherit(sourceValue)) return "source"
    }
    return "global"
}

export type { SharedKey }
