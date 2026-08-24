import type { SchedulePolicy, Variant } from "~/model/types"

/**
 * Global defaults. Every key here that also appears in AnimeOverrides or
 * SourceSettings can be overridden per source and per anime — see resolver.ts.
 *
 * There is no sync section: the library lives on one machine, and moving it is
 * an export/import.
 */
export interface GlobalSettings {
    /** Console verbosity in the background and the injected player. */
    logLevel: "silent" | "error" | "warn" | "info" | "debug"

    // --- library behaviour
    /** Add a series to the library the first time an episode page is opened. */
    autoAddOnWatch: boolean
    /** Follow (and count toward the badge) newly added series. */
    followOnAdd: boolean
    /** Poll newly added series for new episodes. */
    pollOnAdd: boolean

    // --- update scheduling
    schedule: SchedulePolicy
    /** Seconds between requests to the same source during a check run. */
    sourceRequestDelaySec: number
    /** How many sources may be checked concurrently. */
    maxParallelSources: number
    /** Cap on how many series one wake-up will check. */
    maxChecksPerRun: number
    /** Give up on a single series' check after this long. */
    checkTimeoutSec: number

    // --- playback
    takeOverPage: boolean
    preferredQuality: string
    preferredServers: string[]
    variantPref: Variant
    subtitleLanguages: string[]
    /** Fraction of the episode that counts as watched. */
    completionThreshold: number
    autoAdvance: boolean
    skipIntro: "off" | "button" | "auto"
    skipOutro: "off" | "button" | "auto"
    /** How often the player reports position back to the background. */
    progressTickSec: number

    // --- notifications
    notifyNewEpisode: boolean
    /** Auto-clear a notification after this many ms. 0 keeps it until dismissed. */
    notificationTimeoutMs: number

    // --- metadata / trackers
    /** Read-only AniList lookups for posters, titles, episode counts. */
    anilistMetadata: boolean
    /** Read-only AniList airing schedule, used by the `airing` policy. */
    anilistSchedule: boolean
    /** Write watch progress back to AniList. Requires sign-in. */
    pushToTracker: boolean

    // --- domains
    /** Re-check each source's announced domain list on this cadence. */
    domainCheckIntervalHours: number
    /** Promote a healthy alternate automatically when the current host fails. */
    autoPromoteDomain: boolean

    // --- downloads
    downloadQuality: "same-as-playback" | "highest" | "lowest"
    downloadFilenameTemplate: string
    maxParallelDownloads: number

    // --- ui
    listSort: "recent-episode" | "title" | "added" | "unwatched" | "last-watched"
    listSortAscending: boolean
    groupBySeries: boolean
    perPage: number
}

/** Anything a source can override globally, for every anime on that source. */
export interface SourceSettings {
    enabled?: boolean
    takeOverPage?: boolean
    preferredQuality?: string
    preferredServers?: string[]
    variantPref?: Variant
    subtitleLanguages?: string[]
    notifyNewEpisode?: boolean
    /** Per-source politeness, overriding sourceRequestDelaySec. */
    sourceRequestDelaySec?: number
    /** Pin the fetch strategy when this source's CDNs are fussy. */
    fetchVia?: "page" | "dnr" | "background"
}

export function defaultSettings(): GlobalSettings {
    return {
        logLevel: "debug",

        autoAddOnWatch: true,
        followOnAdd: true,
        pollOnAdd: true,

        // Plain interval polling by default: it is what you would expect and it
        // never surprises you. Schedule-aware polling is opt-in, per anime.
        schedule: { mode: "interval", everyHours: 6 },
        sourceRequestDelaySec: 2,
        maxParallelSources: 3,
        maxChecksPerRun: 60,
        checkTimeoutSec: 60,

        takeOverPage: true,
        preferredQuality: "1080p",
        preferredServers: [],
        variantPref: "sub",
        subtitleLanguages: ["en"],
        completionThreshold: 0.85,
        autoAdvance: true,
        skipIntro: "button",
        skipOutro: "button",
        progressTickSec: 5,

        notifyNewEpisode: true,
        notificationTimeoutMs: 0,

        anilistMetadata: true,
        anilistSchedule: false,
        pushToTracker: false,

        domainCheckIntervalHours: 24,
        autoPromoteDomain: true,

        downloadQuality: "same-as-playback",
        downloadFilenameTemplate: "{title}/{title} - E{ep}.{ext}",
        maxParallelDownloads: 2,

        listSort: "recent-episode",
        listSortAscending: false,
        groupBySeries: true,
        perPage: 25
    }
}

export type SettingsKey = keyof GlobalSettings
