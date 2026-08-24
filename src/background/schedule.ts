import type { SchedulePolicy, TrackedAnime } from "~/model/types"
import { log } from "~/shared/logger"
import { NEVER } from "~/shared/time"

const logger = log("schedule")

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * When should this series next be checked?
 *
 * Returning a timestamp rather than a boolean is what lets the scheduler keep a
 * priority queue in an IndexedDB index and ask for "everything due" — instead of
 * AMR's sweep, which walks the whole library on a fixed interval and asks each
 * entry whether it feels like updating.
 *
 * Takes the resolved policy rather than reaching for settings itself: that keeps
 * this a pure function of its arguments, so the date maths can be tested without
 * an extension around it. Callers pass `resolveSchedule(anime)`.
 */
export function nextCheckAt(anime: TrackedAnime, policy: SchedulePolicy, now = Date.now()): number {
    if (!anime.poll) return NEVER

    const value = computeNext(policy, anime, now)

    // A series whose last check failed backs off, so a dead source is retried
    // with decreasing enthusiasm rather than hammered every cycle.
    if (anime.failCount > 0) {
        const backoff = Math.min(2 ** Math.min(anime.failCount, 6) * 15 * MINUTE, 12 * HOUR)
        return Math.max(value, now + backoff)
    }

    return value
}

function computeNext(policy: SchedulePolicy, anime: TrackedAnime, now: number): number {
    switch (policy.mode) {
        case "never":
            return NEVER

        case "interval":
            return (anime.lastCheckedAt || now) + Math.max(0.25, policy.everyHours) * HOUR

        case "weekly":
            return nextWeekly(policy.weekday, policy.time, now)

        case "everyNDays": {
            const period = Math.max(1, policy.days) * DAY
            const from = policy.from || anime.addedAt || now
            // Step forward from the anchor rather than from "now", so the slot
            // stays put instead of drifting later with every check.
            const elapsed = Math.max(0, now - from)
            return from + (Math.floor(elapsed / period) + 1) * period
        }

        case "airing":
            // Airing data arrives with the AniList work. Until then this degrades
            // to plain polling rather than silently never checking.
            logger.debug(`${anime.key}: no airing data yet, falling back to ${policy.fallbackHours}h`)
            return (anime.lastCheckedAt || now) + Math.max(0.25, policy.fallbackHours) * HOUR

        case "inherit":
            // resolveSchedule already collapsed inherit; a stray one means the
            // global default is itself "inherit", which is a misconfiguration.
            logger.warn("schedule resolved to 'inherit'; treating as 6h")
            return (anime.lastCheckedAt || now) + 6 * HOUR
    }
}

/** Next occurrence of a weekday and HH:MM, strictly in the future, local time. */
function nextWeekly(weekday: number, time: string, now: number): number {
    const [hoursText, minutesText] = time.split(":")
    const hours = Number.parseInt(hoursText ?? "0", 10)
    const minutes = Number.parseInt(minutesText ?? "0", 10)
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
        logger.warn(`unparseable weekly time "${time}", falling back to 24h`)
        return now + DAY
    }

    const candidate = new Date(now)
    candidate.setHours(hours, minutes, 0, 0)

    let delta = (weekday - candidate.getDay() + 7) % 7
    if (delta === 0 && candidate.getTime() <= now) delta = 7
    candidate.setDate(candidate.getDate() + delta)

    return candidate.getTime()
}
