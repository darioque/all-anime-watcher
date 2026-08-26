/**
 * The library's shape.
 *
 * Two rules hold this together and both are deliberate departures from AMR:
 *
 *  1. Identity never comes from a URL. `key` is `${sourceId}/${seriesId}`, and an
 *     episode is identified by its `number`. A site can restructure its URLs or
 *     move domains and nothing in the library breaks — `url` is a navigation
 *     payload we are free to rewrite.
 *
 *  2. There is no device sync, so there are no merge clocks. `updatedAt` exists
 *     for display and for export ordering, not for conflict resolution. Moving to
 *     another machine is an export/import, not a merge.
 */

/** How an episode is spoken: subtitled, dubbed, raw, or a site-specific label. */
export type Variant = string

export interface Episode {
    /** THE identity. 13.5 for a half-episode, 0 for a prologue. */
    number: number
    /** Site-provided title, when it has one worth showing. */
    title?: string
    /** Where to go to watch it. Allowed to drift; never used as identity. */
    url: string
    /** "sub" | "dub" | "raw" | a language label. Absent when the site has one track. */
    variant?: Variant
    /** Sites that flag filler episodes; surfaced in the episode list. */
    filler?: boolean
    /** Epoch ms, when the site publishes a release date. */
    airedAt?: number
}

export interface EpisodeProgress {
    positionSec: number
    durationSec?: number
    /** Set once the completion threshold is crossed, or by an explicit mark. */
    completed: boolean
    updatedAt: number
}

export interface WatchMarker {
    number: number
    variant?: Variant
    at: number
}

/**
 * Per-anime settings overrides. Every field is optional; anything absent falls
 * through to the source level and then to the global default. See
 * settings/resolver.ts — the whole point is that nothing is hardcoded.
 */
export interface AnimeOverrides {
    schedule?: SchedulePolicy
    preferredServers?: string[]
    preferredQuality?: string
    variantPref?: Variant
    subtitleLanguages?: string[]
    skipIntro?: "off" | "button" | "auto"
    skipOutro?: "off" | "button" | "auto"
    autoAdvance?: boolean
    completionThreshold?: number
    markWatchedOnOpen?: boolean
    markWatchedOnEmbed?: boolean
    releaseDelayMin?: number
    takeOverPage?: boolean
    notifyNewEpisode?: boolean
    positionDriftTolerance?: number
    pushToTracker?: boolean
}

/**
 * When to look for new episodes. Resolved per anime, defaulting to the global
 * policy. `manual` exists because donghua release data is frequently missing or
 * wrong upstream, and the user needs to be able to just say "Tuesdays".
 */
export type SchedulePolicy =
    | { mode: "inherit" }
    /** Plain polling, AMR's behaviour. */
    | { mode: "interval"; everyHours: number }
    /**
     * Poll around the real air time; falls back to interval when unknown.
     *
     * `delayMin` is the gap between a broadcast and this *site* having it —
     * fansub and donghua sites are rarely instant, so checking at the broadcast
     * minute mostly finds nothing. Left undefined it falls through to the
     * source's `releaseDelayMin` and then to the global one.
     */
    | { mode: "airing"; delayMin?: number; padBeforeMin: number; padAfterMin: number; fallbackHours: number }
    /**
     * "Every Tuesday at 18:00", in the browser's local time.
     *
     * No timezone field on purpose: honouring one means a genuinely tz-aware
     * implementation, not an ignored string. Local time is right for a library
     * that lives on one machine.
     */
    | { mode: "weekly"; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; time: string }
    /** "Every N days, counting from this date." */
    | { mode: "everyNDays"; days: number; from: number }
    /** Followed, never polled. */
    | { mode: "never" }

export interface TrackedAnime {
    /** `${sourceId}/${seriesId}`. Stable for the life of the entry. */
    key: string
    sourceId: string
    seriesId: string

    /** Current best URL for the series page. Rewritten on domain moves. */
    url: string

    /** Title as the source reported it. */
    title: string
    /** User-set rename; wins over `title` everywhere in the UI. */
    displayTitle?: string
    poster?: string

    /** External identity: dedupes across sources and survives a site's death. */
    anilistId?: number
    malId?: number
    /** True once the user has confirmed the tracker match, so we stop guessing. */
    trackerConfirmed?: boolean
    /** Last tracker lookup, so an unmatchable series isn't re-searched every cycle. */
    trackerCheckedAt?: number
    /**
     * What the tracker knows about the series itself, as opposed to our copy of
     * it. Kept together in one field so it round-trips through a backup as one
     * thing, and so "we have no tracker data" is a single check.
     *
     * Read by categories: no site says whether a show is a donghua or an anime,
     * and the genres do not distinguish them — `countryOfOrigin` does.
     */
    meta?: SeriesMeta

    /**
     * Next episode's air time, from the tracker. Feeds the `airing` schedule
     * policy; absent for a finished series, which makes that policy fall back to
     * its interval rather than never checking.
     */
    airing?: { episode: number; at: number; fetchedAt: number }

    /** Descending by number, as the source returned it. */
    episodes: Episode[]
    /** Keyed by `progressKey(number, variant)`. */
    progress: Record<string, EpisodeProgress>
    lastWatched?: WatchMarker

    /** Show it in the list and count it toward the badge. */
    follow: boolean
    /** Include it in update checks. */
    poll: boolean
    /**
     * Shelves the user put this on by hand, whatever the shelf's rule says.
     *
     * Not only manual shelves: "Donghua" is decided by AniList's
     * `countryOfOrigin`, which is missing for anything unmatched and wrong often
     * enough besides — so the rule is a starting point the user is allowed to
     * overrule, not a verdict.
     */
    categories: string[]
    /** Shelves the user took it *off*, overruling a rule that puts it there. */
    categoriesOff?: string[]

    overrides: AnimeOverrides

    addedAt: number
    updatedAt: number
    /** Epoch ms of the last completed check, 0 if never. */
    lastCheckedAt: number
    /** Epoch ms the scheduler should next look. 0 means "as soon as convenient". */
    nextCheckAt: number
    /** Epoch ms a new episode was last seen. Drives "recently updated" sorting. */
    lastEpisodeFoundAt: number

    /** Consecutive failed checks. Surfaces a broken source instead of silence. */
    failCount: number
    lastError?: string
}

/** Facts about the series, from the tracker rather than from a site. */
export interface SeriesMeta {
    /** ISO 3166 alpha-2 as AniList reports it: CN, JP, KR. */
    countryOfOrigin?: string
    genres?: string[]
    /** TV, TV_SHORT, MOVIE, SPECIAL, OVA, ONA, MUSIC. */
    format?: string
    /** RELEASING, FINISHED, NOT_YET_RELEASED, CANCELLED, HIATUS. */
    status?: string
    seasonYear?: number
}

/** Per-source runtime state, kept out of TrackedAnime so it isn't duplicated. */
export interface SourceState {
    sourceId: string
    /** Host currently believed live. Overrides the source's own domains[0]. */
    preferredDomain?: string
    /** Every host ever seen for this source, so old URLs still resolve. */
    knownDomains: string[]
    /** Set by the user; never overwritten by automatic resolution. */
    pinnedDomain?: string
    lastDomainCheckAt: number
    lastDomainCheckResult?: "ok" | "moved" | "unreachable"
    enabled: boolean
}
