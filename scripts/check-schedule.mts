/**
 * Exercise the schedule maths. Date arithmetic is where this kind of code goes
 * wrong quietly — a weekly slot that lands in the past reschedules forever, an
 * everyNDays anchor that drifts turns "every Tuesday" into "eventually".
 *
 *   npm run check:schedule
 */
import { checkable, dueNow, nextCheckAt, normalizeSchedule } from "~/background/schedule"
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

const tuesday = at({ mode: "weekly", weekdays: [2], times: ["18:00"] })
const tuesdayDate = new Date(tuesday)
check(
    "weekly Tue 18:00 → tomorrow",
    tuesdayDate.getDay() === 2 && tuesdayDate.getHours() === 18,
    tuesdayDate.toString()
)
check("weekly slot is in the future", tuesday > now)

// Same weekday, but the time has already passed today → must jump a full week,
// not land in the past. This is what the eighth day of the walk is for.
const mondayEarly = at({ mode: "weekly", weekdays: [1], times: ["09:00"] })
check(
    "weekly same-day-but-past → +7d",
    mondayEarly > now && mondayEarly - now > 6 * DAY,
    new Date(mondayEarly).toString()
)

// Same weekday, time still ahead → today.
const mondayLater = at({ mode: "weekly", weekdays: [1], times: ["20:00"] })
check("weekly same-day-still-ahead → today", mondayLater - now < DAY, new Date(mondayLater).toString())

/*
 * Several days and several times. The reported case: "Wednesdays and Thursdays
 * at 21:00" from a Monday noon should be Wednesday, and every slot after it
 * should follow in order — a schedule that answers "the next Wednesday" every
 * time it is asked would only ever check one day of the two.
 */
const wedThu = { mode: "weekly", weekdays: [3, 4], times: ["21:00"] } as const
const firstSlot = at(wedThu)
const firstDate = new Date(firstSlot)
check("two days picks the nearer one", firstDate.getDay() === 3 && firstDate.getHours() === 21, firstDate.toString())

// Ask again from just after that slot: the answer must move on to Thursday
// rather than repeating Wednesday or jumping a week.
const secondSlot = nextCheckAt(anime({ lastCheckedAt: firstSlot }), wedThu, firstSlot + 60_000)
const secondDate = new Date(secondSlot)
check("and the next ask moves to the other day", secondDate.getDay() === 4, secondDate.toString())
check("without skipping a week", secondSlot - firstSlot < 2 * DAY, `+${Math.round((secondSlot - firstSlot) / HOUR)}h`)

// Two times on one day: from Monday noon, "Mondays at 09:00 and 20:00" is
// tonight, not next week — the earliest *future* slot wins, not the first listed.
const twice = at({ mode: "weekly", weekdays: [1], times: ["09:00", "20:00"] })
check("the earliest future time wins", new Date(twice).getHours() === 20, new Date(twice).toString())

// Every day at one time is a legitimate way to say "daily".
const daily = at({ mode: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], times: ["03:00"] })
check("every day at one time is the next such time", daily > now && daily - now < DAY, new Date(daily).toString())

// A weekly slot must never be `now`. The airing policy used to return exactly
// that inside its pad window, and with a one-minute tick and no failure to back
// off from, the series was re-checked every minute until the window closed.
for (const policy of [wedThu, { mode: "weekly", weekdays: [1], times: ["09:00", "20:00"] } as const]) {
    check(`weekly is strictly in the future (${policy.times.join("/")})`, at(policy) > now)
}

// Nonsense must not become NEVER (silently stops checking) or now (spins).
const noDays = at({ mode: "weekly", weekdays: [], times: ["21:00"] })
const noTimes = at({ mode: "weekly", weekdays: [3], times: ["nope"] })
check("no days falls back to a day", noDays === now + DAY)
check("no usable time falls back to a day", noTimes === now + DAY)

// --- everyNDays anchors, so the slot doesn't drift later on every check
const anchor = now - 10 * DAY
const everyThree = at({ mode: "everyNDays", days: 3, from: anchor })
check("everyNDays is in the future", everyThree > now)
check("everyNDays stays on the anchor grid", (everyThree - anchor) % (3 * DAY) === 0, `+${(everyThree - now) / HOUR}h`)

// --- failure backoff
const failedOnce = at({ mode: "interval", everyHours: 6 }, { failCount: 1 })
const failedLots = at({ mode: "interval", everyHours: 6 }, { failCount: 6 })
check("one failure keeps the normal slot", failedOnce === now + 6 * HOUR, "backoff is shorter than the interval")
check("repeated failures back off further", failedLots > now + 6 * HOUR, `+${Math.round((failedLots - now) / HOUR)}h`)
check("backoff is capped", failedLots <= now + 12 * HOUR)

// --- policies written by an older build
//
// Settings and per-anime overrides are stored as whole objects, so a profile
// keeps whatever shape wrote it. Both readers go through normalizeSchedule; if
// it stopped understanding one of these, the weekly `switch` would read
// undefined days and the series would quietly fall to a 24h fallback forever.

const legacyWeekly = normalizeSchedule({ mode: "weekly", weekday: 4, time: "21:00" } as never)
check(
    "an old single-day weekly becomes a one-item list",
    legacyWeekly.mode === "weekly" &&
        legacyWeekly.weekdays.length === 1 &&
        legacyWeekly.weekdays[0] === 4 &&
        legacyWeekly.times.join() === "21:00",
    JSON.stringify(legacyWeekly)
)
check(
    "and means the same instant it always did",
    nextCheckAt(anime({ lastCheckedAt: now }), legacyWeekly, now) ===
        at({ mode: "weekly", weekdays: [4], times: ["21:00"] })
)

// The airing policy is gone. Whenever the tracker had nothing usable it already
// behaved as its own fallback interval, so that is what it is read as — the
// alternative is a stored `{ mode: "airing" }` falling off every switch.
const retiredAiring = normalizeSchedule({
    mode: "airing",
    padBeforeMin: 15,
    padAfterMin: 120,
    fallbackHours: 12
} as never)
check(
    "a stored air-time policy reads as its fallback interval",
    retiredAiring.mode === "interval" && retiredAiring.everyHours === 12,
    JSON.stringify(retiredAiring)
)
check(
    "so it still gets a sane slot rather than falling off the switch",
    nextCheckAt(anime({ lastCheckedAt: now }), retiredAiring, now) === now + 12 * HOUR
)
check(
    "an air-time policy with no fallback recorded still lands somewhere",
    normalizeSchedule({ mode: "airing" } as never).mode === "interval"
)

// Junk in storage must still produce a usable policy.
const junk = normalizeSchedule({ mode: "weekly", weekdays: [9, -1, 3], times: ["25:00", "21:00"] } as never)
check(
    "impossible days and times are dropped, not kept",
    junk.mode === "weekly" && junk.weekdays.join() === "3" && junk.times.join() === "21:00",
    JSON.stringify(junk)
)
check("a policy that is nothing at all becomes the default interval", normalizeSchedule(null).mode === "interval")

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

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
