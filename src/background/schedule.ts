import type { SchedulePolicy, TrackedAnime, Weekday } from "~/model/types"
import { checkable } from "~/model/keys"
import { log } from "~/shared/logger"
import { NEVER } from "~/shared/time"

export { checkable }

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
/**
 * Which series a run should take, soonest first.
 *
 * The database answers the same question with an index scan, which is what keeps
 * a large library cheap; this is the same rule stated where it can be tested,
 * and what the forced "check everything" path uses.
 */
export function dueNow<T extends Pick<TrackedAnime, "poll" | "nextCheckAt">>(
    list: T[],
    now: number,
    limit: number
): T[] {
    return list
        .filter(anime => checkable(anime) && anime.nextCheckAt <= now)
        .sort((a, b) => a.nextCheckAt - b.nextCheckAt)
        .slice(0, Math.max(0, limit))
}

export function nextCheckAt(anime: TrackedAnime, policy: SchedulePolicy, now = Date.now()): number {
    if (!checkable(anime)) return NEVER

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
            return nextWeekly(policy.weekdays, policy.times, now)

        case "everyNDays": {
            const period = Math.max(1, policy.days) * DAY
            const from = policy.from || anime.addedAt || now
            // Step forward from the anchor rather than from "now", so the slot
            // stays put instead of drifting later with every check.
            const elapsed = Math.max(0, now - from)
            return from + (Math.floor(elapsed / period) + 1) * period
        }

        case "inherit":
            // resolveSchedule already collapsed inherit; a stray one means the
            // global default is itself "inherit", which is a misconfiguration.
            logger.warn("schedule resolved to 'inherit'; treating as 6h")
            return (anime.lastCheckedAt || now) + 6 * HOUR
    }
}

/**
 * Soonest slot strictly in the future, local time.
 *
 * Every combination of a listed weekday and a listed time is a slot, and the
 * nearest one wins. Walking eight days rather than seven is not an off-by-one:
 * when today is the only listed weekday and all of today's times have passed,
 * the answer is the same weekday next week, and day seven is that day.
 *
 * The arithmetic goes through a local `Date` on purpose. Adding 24h in
 * milliseconds is wrong across a DST boundary — "Thursdays at 21:00" would
 * become 20:00 or 22:00 for half the year — whereas `setDate` then `setHours`
 * asks for a wall-clock time and lets the platform find the instant.
 */
function nextWeekly(weekdays: readonly Weekday[], times: readonly string[], now: number): number {
    const minutes = times.map(parseTime).filter((value): value is number => value !== null)

    // Nothing to go on. Falling back to a day beats both NEVER (a series that
    // silently stops being checked) and `now` (a series checked every tick).
    if (weekdays.length === 0 || minutes.length === 0) {
        logger.warn(`weekly schedule has no ${weekdays.length === 0 ? "days" : "usable times"}; falling back to 24h`)
        return now + DAY
    }

    let best = Number.POSITIVE_INFINITY

    for (let ahead = 0; ahead <= 7; ahead++) {
        const day = new Date(now)
        day.setDate(day.getDate() + ahead)
        if (!weekdays.includes(day.getDay() as Weekday)) continue

        for (const minute of minutes) {
            const slot = new Date(day)
            slot.setHours(Math.floor(minute / 60), minute % 60, 0, 0)
            const at = slot.getTime()
            if (at > now && at < best) best = at
        }
    }

    return Number.isFinite(best) ? best : now + DAY
}

/** "21:00" → 1260 minutes past midnight. `null` for anything unparseable. */
function parseTime(time: string): number | null {
    const [hoursText, minutesText] = String(time).split(":")
    const hours = Number.parseInt(hoursText ?? "", 10)
    const minutes = Number.parseInt(minutesText ?? "", 10)
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
    return hours * 60 + minutes
}

/**
 * Bring a stored policy up to the current shape.
 *
 * Settings and per-anime overrides are persisted as whole objects, so a profile
 * written by an older build hands back exactly what that build wrote — there is
 * no schema migration step to lean on. Both readers (`resolveSchedule` for the
 * scheduler, the picker for the UI) go through here, so an old value is
 * understood everywhere rather than silently failing one `switch` at a time.
 *
 * Two shapes come forward:
 *
 * - `weekly` held a single `weekday` and `time`. It becomes a one-day, one-time
 *   list, which is the same schedule.
 * - `airing` polled around AniList's broadcast time. It is gone, and its honest
 *   translation is its own fallback interval: whenever the tracker had nothing
 *   usable — no match, a finished series, a date already past — that is what it
 *   did anyway.
 */
export function normalizeSchedule(policy: SchedulePolicy | undefined | null): SchedulePolicy {
    if (!policy || typeof policy !== "object") return { mode: "interval", everyHours: 6 }

    const legacy = policy as {
        mode: string
        weekday?: number
        time?: string
        weekdays?: unknown
        times?: unknown
        fallbackHours?: number
    }

    if (legacy.mode === "airing") {
        const everyHours = Number.isFinite(legacy.fallbackHours) ? Number(legacy.fallbackHours) : 12
        logger.info(`the "air time" schedule is gone; reading it as every ${everyHours}h`)
        return { mode: "interval", everyHours }
    }

    if (legacy.mode !== "weekly") return policy

    const weekdays = (Array.isArray(legacy.weekdays) ? legacy.weekdays : [legacy.weekday])
        .map(Number)
        .filter(day => Number.isInteger(day) && day >= 0 && day <= 6) as Weekday[]
    const times = (Array.isArray(legacy.times) ? legacy.times : [legacy.time]).filter(
        (value): value is string => typeof value === "string" && parseTime(value) !== null
    )

    return {
        mode: "weekly",
        weekdays: weekdays.length > 0 ? [...new Set(weekdays)].sort((a, b) => a - b) : [2],
        times: times.length > 0 ? [...new Set(times)].sort() : ["18:00"]
    }
}
