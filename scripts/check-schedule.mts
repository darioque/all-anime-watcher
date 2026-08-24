/**
 * Exercise the schedule maths. Date arithmetic is where this kind of code goes
 * wrong quietly — a weekly slot that lands in the past reschedules forever, an
 * everyNDays anchor that drifts turns "every Tuesday" into "eventually".
 *
 *   npm run check:schedule
 */
import { nextCheckAt } from "~/background/schedule"
import type { SchedulePolicy, TrackedAnime } from "~/model/types"
import { NEVER } from "~/shared/time"
import { setLogLevel } from "~/shared/logger"

setLogLevel("silent")

// schedule.ts is pure — it takes the resolved policy — so nothing here needs an
// extension environment. That is the point of the refactor this test forced.

let failures = 0
const HOUR = 3_600_000
const DAY = 24 * HOUR

function anime(overrides: Partial<TrackedAnime> = {}): TrackedAnime {
    const now = Date.now()
    return {
        key: "test/one",
        sourceId: "test",
        seriesId: "one",
        url: "https://example.test/one",
        title: "One",
        episodes: [],
        progress: {},
        follow: true,
        poll: true,
        categories: [],
        overrides: {},
        addedAt: now,
        updatedAt: now,
        lastCheckedAt: now,
        nextCheckAt: 0,
        lastEpisodeFoundAt: 0,
        failCount: 0,
        ...overrides
    }
}

function check(label: string, condition: boolean, detail = "") {
    if (condition) {
        console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`)
    } else {
        failures++
        console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`)
    }
}

const now = Date.parse("2026-08-24T12:00:00")
const at = (schedule: SchedulePolicy, rest: Partial<TrackedAnime> = {}) =>
    nextCheckAt(anime({ lastCheckedAt: now, ...rest }), schedule, now)

console.log("\n\x1b[1mschedule policies\x1b[0m\n")

// --- never
check("never → NEVER", at({ mode: "never" }) === NEVER)
check("poll off → NEVER", at({ mode: "interval", everyHours: 1 }, { poll: false }) === NEVER)

// --- interval
const interval = at({ mode: "interval", everyHours: 6 })
check("interval 6h → +6h", interval === now + 6 * HOUR, new Date(interval).toISOString())

// --- weekly: 2026-08-24 is a Monday
const monday = new Date(now).getDay()
check("test anchor is a Monday", monday === 1, `getDay()=${monday}`)

const tuesday = at({ mode: "weekly", weekday: 2, time: "18:00" })
const tuesdayDate = new Date(tuesday)
check("weekly Tue 18:00 → tomorrow", tuesdayDate.getDay() === 2 && tuesdayDate.getHours() === 18, tuesdayDate.toString())
check("weekly slot is in the future", tuesday > now)

// Same weekday, but the time has already passed today → must jump a full week,
// not land in the past.
const mondayEarly = at({ mode: "weekly", weekday: 1, time: "09:00" })
check("weekly same-day-but-past → +7d", mondayEarly > now && mondayEarly - now > 6 * DAY, new Date(mondayEarly).toString())

// Same weekday, time still ahead → today.
const mondayLater = at({ mode: "weekly", weekday: 1, time: "20:00" })
check("weekly same-day-still-ahead → today", mondayLater - now < DAY, new Date(mondayLater).toString())

// --- everyNDays anchors, so the slot doesn't drift later on every check
const anchor = now - 10 * DAY
const everyThree = at({ mode: "everyNDays", days: 3, from: anchor })
check("everyNDays is in the future", everyThree > now)
check("everyNDays stays on the anchor grid", (everyThree - anchor) % (3 * DAY) === 0, `+${(everyThree - now) / HOUR}h`)

// --- airing degrades rather than disappearing
const airingPolicy = { mode: "airing", padBeforeMin: 15, padAfterMin: 120, fallbackHours: 12 } as const
const airing = at(airingPolicy)
check("airing with no data falls back to its interval", airing === now + 12 * HOUR)

// With a real air time, check shortly *before* it — sites publish early as often
// as late.
const soon = now + 5 * HOUR
const beforeAir = at(airingPolicy, { airing: { episode: 12, at: soon, fetchedAt: now } })
check("airing checks before the air time", beforeAir === soon - 15 * 60_000, new Date(beforeAir).toISOString())

// An air time already past but still inside the pad window means "now", not the
// past — a slot in the past would make the scheduler spin.
const justAired = now - 30 * 60_000
const duringPad = at(airingPolicy, { airing: { episode: 12, at: justAired, fetchedAt: now } })
check("airing inside the pad is due now", duringPad === now, `+${(duringPad - now) / 1000}s`)
check("airing slot is never in the past", duringPad >= now)

// Stale data — aired long ago and never refreshed — must not pin the series to a
// date that will never come round again.
const longPast = now - 30 * DAY
const stale = at(airingPolicy, { airing: { episode: 12, at: longPast, fetchedAt: longPast } })
check("stale airing data falls back to the interval", stale === now + 12 * HOUR)

// --- failure backoff
const failedOnce = at({ mode: "interval", everyHours: 6 }, { failCount: 1 })
const failedLots = at({ mode: "interval", everyHours: 6 }, { failCount: 6 })
check("one failure keeps the normal slot", failedOnce === now + 6 * HOUR, "backoff is shorter than the interval")
check("repeated failures back off further", failedLots > now + 6 * HOUR, `+${Math.round((failedLots - now) / HOUR)}h`)
check("backoff is capped", failedLots <= now + 12 * HOUR)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
