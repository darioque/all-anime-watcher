/**
 * Exercise the schedule maths. Date arithmetic is where this kind of code goes
 * wrong quietly — a weekly slot that lands in the past reschedules forever, an
 * everyNDays anchor that drifts turns "every Tuesday" into "eventually".
 *
 *   npm run check:schedule
 */
import { checkable, dueNow, nextCheckAt } from "~/background/schedule"
import { clock } from "~/shared/time"
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
check(
    "weekly Tue 18:00 → tomorrow",
    tuesdayDate.getDay() === 2 && tuesdayDate.getHours() === 18,
    tuesdayDate.toString()
)
check("weekly slot is in the future", tuesday > now)

// Same weekday, but the time has already passed today → must jump a full week,
// not land in the past.
const mondayEarly = at({ mode: "weekly", weekday: 1, time: "09:00" })
check(
    "weekly same-day-but-past → +7d",
    mondayEarly > now && mondayEarly - now > 6 * DAY,
    new Date(mondayEarly).toString()
)

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

// --- release delay: the gap between a broadcast and this site having it subbed
const withDelay = { ...airingPolicy, delayMin: 180 } as const
const airsInAnHour = now + HOUR

const delayed = at(withDelay, { airing: { episode: 12, at: airsInAnHour, fetchedAt: now } })
check(
    "the release delay pushes the slot back",
    delayed === airsInAnHour + 180 * 60_000 - 15 * 60_000,
    `air +3h, minus the 15m pad`
)

// An episode that aired three hours ago is past its two-hour pad and falls back
// to the interval. The same episode on a site that runs three hours behind is
// due *right now* — which is the whole point of the delay.
const airedThreeHoursAgo = now - 3 * HOUR
const stillDue = at(withDelay, { airing: { episode: 12, at: airedThreeHoursAgo, fetchedAt: now } })
const noDelay = at(airingPolicy, { airing: { episode: 12, at: airedThreeHoursAgo, fetchedAt: now } })
check("a delayed episode is due as the site catches up", stillDue === now)
check("the same episode without a delay has fallen back", noDelay === now + 12 * HOUR)

// The delay must not resurrect data that is simply old.
const veryStale = at(withDelay, { airing: { episode: 12, at: now - 30 * DAY, fetchedAt: now - 30 * DAY } })
check("a delay does not rescue stale airing data", veryStale === now + 12 * HOUR)

console.log("\n\x1b[1mwhat a check run is allowed to touch\x1b[0m\n")

/*
 * "Check for new episodes" being off has to mean off on every path into the
 * update loop, including the button labelled "check every series now". The
 * failure mode is invisible from the outside — a series you asked not to be
 * checked simply gets checked — so it is worth stating rather than assuming.
 */
const queue = [
    { key: "a", poll: true, nextCheckAt: 100 },
    { key: "b", poll: false, nextCheckAt: 1 },
    { key: "c", poll: true, nextCheckAt: 50 },
    { key: "d", poll: true, nextCheckAt: 5_000 }
]

check("a series with polling off is never due", !checkable(queue[1]!))
check("one with it on is", checkable(queue[0]!))
check("and `poll` missing entirely is treated as off", !checkable({ poll: undefined as unknown as boolean }))

const picked = dueNow(queue, 1_000, 10).map(entry => entry.key)
check("polling off is excluded even though it is the most overdue", !picked.includes("b"), picked.join(","))
check("a slot in the future is not yet due", !picked.includes("d"))
check("and the rest come back soonest first", picked.join(",") === "c,a", picked.join(","))
check("the limit caps the run", dueNow(queue, 1_000, 1).length === 1)
check("a limit of zero takes nothing", dueNow(queue, 1_000, 0).length === 0)

// The same rule again from the other end: a series with polling off is given no
// slot at all, so it cannot re-enter the queue by the clock either.
const off: TrackedAnime = anime({ poll: false })
check("an unpolled series is scheduled to never", nextCheckAt(off, { mode: "interval", everyHours: 1 }, now) === NEVER)

console.log("\n\x1b[1mplayback clock\x1b[0m\n")

/*
 * The player's OSD reads this while seeking, which is the one moment nobody is
 * looking anywhere else — an off-by-one in the padding is glaring there and
 * invisible in a screenshot taken at 0:00.
 */
check("under a minute", clock(7) === "0:07", clock(7))
check("minutes are unpadded below an hour", clock(5 * 60 + 7) === "5:07", clock(5 * 60 + 7))
check("and padded above one", clock(3600 + 5 * 60 + 7) === "1:05:07", clock(3600 + 5 * 60 + 7))
check("the hour boundary itself", clock(3600) === "1:00:00", clock(3600))
check("seconds round down, never up", clock(59.99) === "0:59", clock(59.99))
check("zero is a real position", clock(0) === "0:00", clock(0))
check("an unknown duration says so", clock(Number.NaN) === "--:--", clock(Number.NaN))
check("and so does a live stream's Infinity", clock(Number.POSITIVE_INFINITY) === "--:--")

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
