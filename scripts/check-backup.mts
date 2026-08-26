/**
 * Prove the backup round-trips losslessly.
 *
 *   npm run check:backup
 *
 * Sync was dropped on purpose, so this file is the only way data ever leaves or
 * enters the extension. There is no second copy: a field that quietly fails to
 * survive export → import is data loss with no recovery, and it would not show
 * up until the day someone needed the backup.
 */
import {
    BACKUP_FORMAT,
    BACKUP_VERSION,
    buildBackup,
    mergeAnime,
    planImport,
    readBackup,
    serializeBackup,
    type BackupParts
} from "~/model/backup"
import { defaultSettings } from "~/settings/schema"
import type { TrackedAnime } from "~/model/types"

let failures = 0

function check(label: string, condition: boolean, detail = "") {
    if (!condition) failures++
    console.log(`  ${condition ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${detail ? ` — ${detail}` : ""}`)
}

function eq<T>(label: string, actual: T, expected: T) {
    const ok = Object.is(actual, expected)
    check(label, ok, ok ? "" : `got ${String(actual)}, wanted ${String(expected)}`)
}

function deepEq(label: string, actual: unknown, expected: unknown) {
    // Not `?? "undefined"` for show: JSON.stringify(undefined) *is* undefined,
    // and a dropped field is exactly the failure this file exists to catch.
    const a = JSON.stringify(actual) ?? "undefined"
    const b = JSON.stringify(expected) ?? "undefined"
    check(label, a === b, a === b ? "" : firstDifference(a, b))
}

/** Where two JSON strings diverge, so a failure names the field. */
function firstDifference(a: string, b: string): string {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return `diverges at ${i}: …${a.slice(Math.max(0, i - 40), i + 40)} | …${b.slice(Math.max(0, i - 40), i + 40)}`
}

function throws(label: string, fn: () => unknown, contains: string) {
    try {
        fn()
        check(label, false, "did not throw")
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        check(label, text.includes(contains), text.includes(contains) ? "" : `said "${text}"`)
    }
}

// ---------------------------------------------------------------- a library

function anime(overrides: Partial<TrackedAnime> & { key: string }): TrackedAnime {
    const [sourceId = "src", seriesId = "x"] = overrides.key.split("/")
    return {
        sourceId,
        seriesId,
        url: `https://${sourceId}/series/${seriesId}`,
        title: seriesId.replace(/-/g, " "),
        episodes: [
            { number: 1, url: "https://x/1", variant: "sub", airedAt: 1_700_000_000_000 },
            { number: 2, url: "https://x/2", variant: "sub" }
        ],
        progress: {},
        follow: true,
        poll: true,
        categories: [],
        overrides: {},
        addedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_100_000,
        lastCheckedAt: 1_700_000_200_000,
        nextCheckAt: 1_700_020_000_000,
        lastEpisodeFoundAt: 1_700_000_050_000,
        failCount: 0,
        ...overrides
    }
}

/*
 * Deliberately awkward: a rename with an em dash, a fractional episode number, a
 * per-anime schedule override, a tracker link, an unfollowed entry, an entry
 * mid-failure with an error string, and progress carrying both a completed and
 * an in-flight episode. Every one of these is a field that a hand-written
 * "rebuild the object" import would be easy to drop.
 */
const library: BackupParts = {
    anime: [
        anime({
            key: "myanime/wan-jie-du-zun-ten-thousand-worlds",
            title: "Wan Jie Du Zun – Ten Thousand Worlds",
            displayTitle: "WJDZ",
            poster: "https://x/p.jpg",
            anilistId: 12345,
            trackerConfirmed: true,
            trackerCheckedAt: 1_700_000_300_000,
            airing: { episode: 477, at: 1_700_600_000_000, fetchedAt: 1_700_000_300_000 },
            episodes: [
                { number: 476, url: "https://x/476", variant: "sub" },
                { number: 475.5, url: "https://x/475-5", variant: "sub", title: "Recap" }
            ],
            progress: {
                "476:sub": { positionSec: 1320, durationSec: 1400, completed: true, updatedAt: 1_700_000_400_000 },
                "475.5:sub": { positionSec: 90, completed: false, updatedAt: 1_700_000_390_000 }
            },
            lastWatched: { number: 476, variant: "sub", at: 1_700_000_400_000 },
            categories: ["donghua", "airing"],
            overrides: { schedule: { mode: "weekly", weekday: 2, time: "18:00" }, skipIntro: "auto" }
        }),
        anime({
            key: "lmanime/xian-ni",
            follow: false,
            poll: false,
            failCount: 3,
            lastError: "timed out after 60s checking lmanime/xian-ni",
            malId: 999
        })
    ],
    sourceState: [
        {
            sourceId: "anikoto",
            preferredDomain: "anikototv.to",
            knownDomains: ["anikototv.to", "anikoto.me"],
            pinnedDomain: "anikototv.to",
            lastDomainCheckAt: 1_700_000_000_000,
            lastDomainCheckResult: "ok",
            enabled: true
        },
        { sourceId: "myanime", knownDomains: ["myanime.live"], lastDomainCheckAt: 0, enabled: true }
    ],
    settings: { ...defaultSettings(), completionThreshold: 0.9, preferredServers: ["Vidstream-2"] },
    sourceSettings: { myanime: { releaseDelayMin: 240, notifyNewEpisode: false } }
}

console.log("\n\x1b[1mround trip\x1b[0m\n")

const file = serializeBackup(buildBackup(library, { exportedAt: 1_700_001_000_000, appVersion: "0.1.0" }))
const reread = readBackup(file)

deepEq("every series survives export and import", reread.anime, library.anime)
deepEq("so does source state", reread.sourceState, library.sourceState)
deepEq("so do settings", reread.settings, library.settings)
deepEq("so do per-source settings", reread.sourceSettings, library.sourceSettings)
eq("the format marker is written", reread.format, BACKUP_FORMAT)
eq("and the version", reread.version, BACKUP_VERSION)
eq("and the export time", reread.exportedAt, 1_700_001_000_000)

// Exporting what was just imported must produce the same bytes, or the format
// is not a fixed point and repeated moves between machines would drift.
const again = serializeBackup(buildBackup(reread, { exportedAt: 1_700_001_000_000, appVersion: "0.1.0" }))
check("re-exporting an imported backup is byte-identical", again === file)

/*
 * The reason nothing here is rebuilt field by field: a file written by a *later*
 * version carries keys this build has no name for. Dropping them would make the
 * older build silently destroy the newer one's data on any round trip.
 */
const fromTheFuture = JSON.parse(file) as Record<string, unknown>
const futureEntry = (fromTheFuture.anime as Record<string, unknown>[])[0]!
futureEntry.watchedWithFriends = ["kim"]
futureEntry.updatedAt = 1_800_000_000_000
futureEntry.progress = {
    "476:sub": { positionSec: 1320, completed: true, updatedAt: 1_800_000_000_000, playbackRate: 1.5 }
}
const future = readBackup(JSON.stringify(fromTheFuture))
deepEq(
    "a field this build has never heard of survives an import",
    (future.anime[0] as unknown as Record<string, unknown>).watchedWithFriends,
    ["kim"]
)
deepEq(
    "and survives a merge, which is why nothing is rebuilt field by field",
    (mergeAnime(library.anime[0]!, future.anime[0]!) as unknown as Record<string, unknown>).watchedWithFriends,
    ["kim"]
)
deepEq(
    "including one inside a progress entry",
    (mergeAnime(library.anime[0]!, future.anime[0]!).progress["476:sub"] as Record<string, unknown>).playbackRate,
    1.5
)

/*
 * The limit of that, stated rather than left to be discovered: a progress entry
 * is merged as a whole snapshot, so the *losing* side's extra fields go with it.
 * Mixing two snapshots field by field would produce a position from one moment
 * and a duration from another, which is worse than picking one.
 */
const losingSide = mergeAnime(
    anime({
        key: "s/snap",
        updatedAt: 9,
        progress: { "1:": { positionSec: 10, completed: false, updatedAt: 9 } }
    }),
    anime({
        key: "s/snap",
        updatedAt: 1,
        progress: { "1:": { positionSec: 5, completed: false, updatedAt: 1, playbackRate: 2 } as never }
    })
)
eq("a superseded progress entry is replaced whole", losingSide.progress["1:"]?.positionSec, 10)
deepEq(
    "extras on the superseded side go with it",
    (losingSide.progress["1:"] as Record<string, unknown>).playbackRate,
    undefined
)

console.log("\n\x1b[1mrefusing bad files\x1b[0m\n")

throws(
    "a truncated file is caught by the count",
    () => {
        const cut = JSON.parse(file) as Record<string, unknown>
        ;(cut.anime as unknown[]).pop()
        return readBackup(JSON.stringify(cut))
    },
    "truncated"
)
throws("an unrelated JSON file is refused by name", () => readBackup('{"hello":true}'), "no format marker")
throws("someone else's backup is refused by name", () => readBackup('{"format":"tachiyomi"}'), '"tachiyomi"')
throws(
    "a future format version is refused rather than half-read",
    () => {
        const ahead = JSON.parse(file) as Record<string, unknown>
        ahead.version = BACKUP_VERSION + 1
        return readBackup(JSON.stringify(ahead))
    },
    "Update the extension"
)
throws(
    "a series with no key is named",
    () => {
        const broken = JSON.parse(file) as Record<string, unknown>
        delete (broken.anime as Record<string, unknown>[])[1]!.key
        return readBackup(JSON.stringify(broken))
    },
    "series #2 in that backup has no key"
)
throws(
    "and so is one with no episode list",
    () => {
        const broken = JSON.parse(file) as Record<string, unknown>
        delete (broken.anime as Record<string, unknown>[])[0]!.episodes
        return readBackup(JSON.stringify(broken))
    },
    "has no episode list"
)
throws("plain text is not mistaken for a backup", () => readBackup("not json at all"), "not a JSON file")

console.log("\n\x1b[1mreplace\x1b[0m\n")

const halfGone: BackupParts = { ...library, anime: [library.anime[0]!, anime({ key: "lmanime/added-since" })] }
const replace = planImport(halfGone, reread, { mode: "replace", settings: true })
deepEq("replace writes exactly what the file held", replace.anime, reread.anime)
eq("and says how many series it would drop", replace.summary.localOnly, 1)
eq("counting the ones it overwrites", replace.summary.updated, 1)
eq("and the ones it brings back", replace.summary.added, 1)
eq("settings come back when asked for", replace.settings?.completionThreshold, 0.9)
eq("and are left alone when not", planImport(halfGone, reread, { mode: "replace", settings: false }).settings, null)

console.log("\n\x1b[1mmerge\x1b[0m\n")

const merge = planImport(halfGone, reread, { mode: "merge", settings: false })
eq("merge keeps series the backup never had", merge.anime.length, 3)
eq("adds the ones it did", merge.summary.added, 1)
eq("and never reports a local-only series as removed", merge.summary.localOnly, 1)

// --- the rule: newer wins the field, history is never lost
const older = anime({
    key: "s/show",
    updatedAt: 1000,
    addedAt: 500,
    displayTitle: "old name",
    lastWatched: { number: 40, at: 900 },
    progress: { "40:": { positionSec: 1200, completed: true, updatedAt: 900 } },
    categories: ["a"]
})
const newer = anime({
    key: "s/show",
    updatedAt: 2000,
    addedAt: 1500,
    displayTitle: "new name",
    lastWatched: { number: 12, at: 1900 },
    progress: { "12:": { positionSec: 60, completed: false, updatedAt: 1900 } },
    categories: ["b"]
})

const both = mergeAnime(older, newer)
eq("the more recently touched record wins ordinary fields", both.displayTitle, "new name")
eq("but the furthest watch position is kept", both.lastWatched?.number, 40)
eq("progress from both sides is kept", Object.keys(both.progress).length, 2)
eq("and addedAt keeps the earlier date", both.addedAt, 500)
deepEq("categories are unioned, not replaced", both.categories, ["a", "b"])
deepEq("merging is symmetric", JSON.parse(JSON.stringify(mergeAnime(newer, older))), JSON.parse(JSON.stringify(both)))

// `completed` is the one flag whose loss cannot be undone by re-checking.
const finished = anime({
    key: "s/x",
    updatedAt: 1,
    progress: { "5:": { positionSec: 1400, completed: true, updatedAt: 1 } }
})
const restarted = anime({
    key: "s/x",
    updatedAt: 9,
    progress: { "5:": { positionSec: 30, completed: false, updatedAt: 9 } }
})
const after = mergeAnime(finished, restarted)
eq("a completed episode stays completed", after.progress["5:"]?.completed, true)
eq("while its position follows the newer write", after.progress["5:"]?.positionSec, 30)

// An unstarted side must not erase a started one, in either direction.
const unstarted = anime({ key: "s/y", updatedAt: 9000 })
const started = anime({ key: "s/y", updatedAt: 1, lastWatched: { number: 7, at: 1 } })
eq("a newer unstarted record does not erase a position", mergeAnime(started, unstarted).lastWatched?.number, 7)
eq("and neither does the other order", mergeAnime(unstarted, started).lastWatched?.number, 7)

// A pinned domain is a hand-made choice; automatic resolution already may not
// overwrite it, and neither may an import.
const pinnedKept = planImport(
    { ...library, sourceState: [{ ...library.sourceState[0]!, pinnedDomain: "anikoto.me", lastDomainCheckAt: 0 }] },
    reread,
    { mode: "merge", settings: false }
)
eq(
    "a local pinned domain survives a merge",
    pinnedKept.sourceState.find(s => s.sourceId === "anikoto")?.pinnedDomain,
    "anikoto.me"
)

console.log("\n\x1b[1mempty and edge\x1b[0m\n")

const empty: BackupParts = { anime: [], sourceState: [], settings: defaultSettings(), sourceSettings: {} }
const emptyFile = serializeBackup(buildBackup(empty, { exportedAt: 0 }))
eq("an empty library exports and imports", readBackup(emptyFile).anime.length, 0)
eq(
    "importing an empty backup over a real one in merge mode changes nothing",
    planImport(library, readBackup(emptyFile), { mode: "merge", settings: false }).anime.length,
    2
)
eq(
    "and in replace mode empties it",
    planImport(library, readBackup(emptyFile), { mode: "replace", settings: false }).anime.length,
    0
)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
