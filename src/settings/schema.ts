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
    /**
     * Opening an episode page moves your position to it — AMR's `addauto`, and
     * the only tracking signal available until the player lands. Once playback
     * exists, completionThreshold is the more accurate signal and this can go off.
     */
    markWatchedOnOpen: boolean
    /**
     * Opening an episode counts it as watched when the site's own player is
     * embedded rather than replaced.
     *
     * Nothing can see inside a cross-origin frame, so `completionThreshold` has
     * no signal to work from there — without this an embedded episode would
     * never be marked at all, however much of it you watched.
     */
    markWatchedOnEmbed: boolean

    // --- update scheduling
    schedule: SchedulePolicy
    /**
     * Minutes between an episode airing and a site having it subtitled and up.
     * Used by the `airing` schedule; a per-anime policy can state its own.
     */
    releaseDelayMin: number
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
    /** Library list controls, persisted so the list looks the same next time. */
    listSort: "recent" | "title" | "unwatched" | "next-check" | "added"
    listSortAscending: boolean
    listOnlyUnwatched: boolean
    /** Source id, or "" for all of them. */
    listSourceFilter: string
    groupBySeries: boolean
    perPage: number
    /** Clicking the toolbar icon opens the full library tab instead of the popup. */
    openInTab: boolean
}

/** Anything a source can override globally, for every anime on that source. */
export interface SourceSettings {
    enabled?: boolean
    takeOverPage?: boolean
    markWatchedOnEmbed?: boolean
    /** How far behind a broadcast this particular site tends to run. */
    releaseDelayMin?: number
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
        markWatchedOnOpen: true,
        markWatchedOnEmbed: true,

        // Plain interval polling by default: it is what you would expect and it
        // never surprises you. Schedule-aware polling is opt-in, per anime.
        schedule: { mode: "interval", everyHours: 6 },
        // An hour is a guess, but a better one than zero: no site has an episode
        // the minute it airs, and checking then just burns the airing window.
        releaseDelayMin: 60,
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

        listSort: "recent",
        listSortAscending: false,
        listOnlyUnwatched: false,
        listSourceFilter: "",
        groupBySeries: true,
        perPage: 25,
        openInTab: false
    }
}

export type SettingsKey = keyof GlobalSettings
