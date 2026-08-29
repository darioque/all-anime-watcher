import type { SchedulePolicy, Variant } from "~/model/types"
import { defaultCategories, type Category, type CategoryFilter } from "~/library/categories"

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
    /**
     * Open a newly-seen episode's page to confirm it has a video before calling
     * it a release.
     *
     * **Off by default, and it has to be.** It is a request per candidate
     * episode on top of the series page, and a library of several hundred
     * followed series pays that on every check run — real weight, for a habit
     * only some sites have. Most never post an episode before they have it, and
     * on those the check is pure cost with nothing to find.
     *
     * So it is opt-in, per source and per series, for the sites that actually do
     * it. Only sources implementing `episodeAvailability` can answer at all, and
     * turning it on for a source that cannot is a no-op rather than a waste.
     */
    verifyNewEpisodes: boolean
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
    /**
     * Treat a fatal mid-playback error as a hiccup to recover from rather than a
     * dead server.
     *
     * On by default, and the default is the fix: hls.js reports a stalled buffer
     * or an exhausted segment retry as "fatal", and taking that at face value is
     * what made a working server jump to the next one three minutes into an
     * episode. Off restores the old behaviour, which is the right answer for
     * someone whose sites are more reliable than their connection and who would
     * rather change server than wait.
     */
    recoverStalledPlayback: boolean
    skipIntro: "off" | "button" | "auto"
    skipOutro: "off" | "button" | "auto"
    /** How often the player reports position back to the background. */
    progressTickSec: number
    /** Seconds the left/right arrows move. */
    seekStepSec: number

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
    /**
     * The shelves themselves. In settings rather than the database because they
     * are configuration, and because settings already round-trip through a
     * backup — a library restored without its categories would have every entry
     * pointing at shelves that no longer exist.
     */
    categories: Category[]
    /**
     * Built-in shelves that have already been offered.
     *
     * Kept apart from `categories` so a deletion sticks. Without it, "add the
     * built-ins that are missing" and "undo the user deleting one" are the same
     * statement, and a shelf thrown away would come back on the next start.
     */
    seededCategories: string[]
    /**
     * One-off repairs already applied to this profile, by name.
     *
     * Needed because a *default* is also what every stored profile is told about
     * itself: `seededCategories` once defaulted to every built-in id, and any
     * settings write persisted that claim into storage. No later default can
     * undo a lie already written down, so the repair has to run once and record
     * that it has.
     */
    migrations: string[]
    /** Ticked and crossed chips, persisted like every other list control. */
    listCategoryFilter: CategoryFilter
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
    /**
     * Worth turning off for a source that never posts an episode early — the
     * check is a wasted request there — and the level at which it belongs, since
     * whether a site pre-posts is a fact about the site, not about the series.
     */
    verifyNewEpisodes?: boolean
    /** How far behind a broadcast this particular site tends to run. */
    releaseDelayMin?: number
    preferredQuality?: string
    preferredServers?: string[]
    variantPref?: Variant
    subtitleLanguages?: string[]
    /** Some sites' CDNs stall routinely; whether to ride it out is per-site. */
    recoverStalledPlayback?: boolean
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
        verifyNewEpisodes: false,

        takeOverPage: true,
        preferredQuality: "1080p",
        preferredServers: [],
        variantPref: "sub",
        subtitleLanguages: ["en"],
        completionThreshold: 0.85,
        autoAdvance: true,
        recoverStalledPlayback: true,
        skipIntro: "button",
        skipOutro: "button",
        progressTickSec: 5,
        seekStepSec: 5,

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
        categories: defaultCategories(),
        /*
         * Empty, not "every built-in id" — the two look equivalent and are not.
         * Settings are stored whole and merged *over* these defaults, so a
         * profile written before this field existed inherits whatever sits here.
         * Filling it in said "every built-in has already been offered" about a
         * profile that had never been offered any of them, and the shelves added
         * after that profile was created could never appear. A fresh profile is
         * still covered: `categories` above already holds all of them, and
         * `unseededCategories` treats an existing shelf as offered.
         */
        seededCategories: [],
        migrations: [],
        listCategoryFilter: {},
        groupBySeries: true,
        perPage: 25,
        openInTab: false
    }
}

export type SettingsKey = keyof GlobalSettings
