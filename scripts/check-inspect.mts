/**
 * Exercise the Database page's judgement about untyped rows.
 *
 *   npm run check:inspect
 *
 * A generic table over `Record<string, unknown>` is the kind of code that looks
 * obviously right and is quietly wrong at every edge: `null` versus missing, an
 * empty array versus no array, a field that is a number in one row and a string
 * in the next, an epoch of 0 that is not 1970 but "never". None of those are
 * visible by reading the page, and all of them are one line here.
 */
import {
    STORES,
    cellText,
    extraFields,
    filterRows,
    formatEpoch,
    isEpochField,
    parseRow,
    scaffold,
    sortRows,
    storeSpec,
    summarise,
    type Row
} from "~/model/inspect"
import type { TrackedAnime } from "~/model/types"

let failures = 0

function eq(label: string, actual: unknown, expected: unknown) {
    const a = JSON.stringify(actual) ?? "undefined"
    const b = JSON.stringify(expected) ?? "undefined"
    if (a !== b) failures++
    console.log(`  ${a === b ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${a === b ? "" : ` — got ${a}`}`)
}

// ---------------------------------------------------------------- stores

console.log("\n\x1b[1mstore specs\x1b[0m\n")

eq(
    "every store names a key field",
    STORES.every(store => store.keyPath !== ""),
    true
)
eq(
    "and lists it first, so a row is identifiable at a glance",
    STORES.every(s => s.columns[0] === s.keyPath),
    true
)
eq("the library is keyed the way the library is keyed", storeSpec("anime").keyPath, "key")
eq("storage rows are wrapped, so the key is a field like any other", storeSpec("storage").keyPath, "key")

// ---------------------------------------------------------------- epochs

console.log("\n\x1b[1mepochs\x1b[0m\n")

/*
 * Named, not measured. There is no telling an epoch from an episode count by
 * looking at the number, and a magnitude test gets `notificationTimeoutMs`
 * wrong the moment someone sets a large one.
 */
eq("`nextCheckAt` is an epoch", isEpochField("nextCheckAt", 1_700_000_000_000), true)
eq("so is a watch marker's bare `at`", isEpochField("at", 1_700_000_000_000), true)
eq("`format` is not, despite the letters", isEpochField("format", 5), false)
eq("nor is `seasonYear`", isEpochField("seasonYear", 2024), false)
eq("a non-number named like one is still not one", isEpochField("lastCheckedAt", "yesterday"), false)

/*
 * The one that matters. Zero is this codebase's "never" — `lastCheckedAt: 0`
 * means never checked and `nextCheckAt: 0` means as soon as convenient — and
 * rendering it as 1 January 1970 turns two normal states into alarming ones.
 */
eq("zero is never, not 1970", formatEpoch(0), "—")
eq("a real epoch formats as a date", formatEpoch(1_700_000_000_000).length > 0, true)

// ---------------------------------------------------------------- cells

console.log("\n\x1b[1mcells\x1b[0m\n")

eq("missing is blank, not the string 'undefined'", cellText(undefined), "")
eq("null says so — it is a stored value and blank would hide it", cellText(null), "null")
eq("an empty array is visibly empty, not blank", cellText([]), "[]")
eq("an empty object likewise", cellText({}), "{}")
eq("booleans read as words", [cellText(true), cellText(false)], ["yes", "no"])
eq("a short list keeps its contents", cellText(["en", "es"]), "en, es")
eq("a long list of scalars becomes a count", cellText(Array.from({ length: 40 }, (_, i) => `lang-${i}`)), "40 items")
eq("a list of objects is always a count", cellText([{ number: 1 }, { number: 2 }]), "2 items")
eq("an object shows what fits", cellText({ number: 52, variant: "sub" }), '{"number":52,"variant":"sub"}')
eq("and is cut, not dropped, when it does not", cellText({ url: "x".repeat(200) }, 20).length, 20)
eq("a long string is cut to the budget", cellText("y".repeat(200), 20).length, 20)
eq("zero is a value, not a blank", cellText(0), "0")

// ---------------------------------------------------------------- fields no column shows

console.log("\n\x1b[1munclaimed fields\x1b[0m\n")

const spec = storeSpec("sourceState")
const stateRows: Row[] = [
    { sourceId: "lmanime", enabled: true, knownDomains: [], lastDomainCheckAt: 0 },
    { sourceId: "mundodonghua", enabled: true, knownDomains: [], somethingNew: 1, andAnother: 2 }
]
eq("a field no column claims is reported", extraFields(spec, stateRows), ["andAnother", "somethingNew"])
eq("a store whose rows are all covered reports none", extraFields(spec, [stateRows[0]!]), [])

// ---------------------------------------------------------------- searching

console.log("\n\x1b[1msearching\x1b[0m\n")

const library: Row[] = [
    { key: "lmanime/soul-land", title: "Soul Land", sourceId: "lmanime", episodes: [{ url: "https://a.test/1" }] },
    { key: "mundodonghua/i-will-eternal", title: "I Will Eternal", sourceId: "mundodonghua", episodes: [] }
]

eq("an empty query is not a filter", filterRows(library, "   ").length, 2)
eq("case does not matter", filterRows(library, "SOUL").length, 1)
eq("one field can be searched alone", filterRows(library, "lmanime", "sourceId").length, 1)
/*
 * Searching every field means searching *into* the nested values, or the most
 * common question this page is opened to answer — which series still has URLs
 * on the old domain — cannot be asked at all.
 */
eq("searching everything reaches inside nested values", filterRows(library, "a.test").length, 1)
eq("but a field search stays on its field", filterRows(library, "a.test", "title").length, 0)
eq("a missing field matches nothing rather than throwing", filterRows(library, "x", "nope").length, 0)

// ---------------------------------------------------------------- sorting

console.log("\n\x1b[1msorting\x1b[0m\n")

const due: Row[] = [
    { key: "c", nextCheckAt: 300, failCount: 0 },
    { key: "a", nextCheckAt: 100, failCount: 2 },
    { key: "b", failCount: 1 },
    { key: "d", nextCheckAt: 200, failCount: 0 }
]

eq(
    "numbers sort as numbers",
    sortRows(due, "nextCheckAt").map(row => row.key),
    ["a", "d", "c", "b"]
)
eq(
    "descending reverses the present ones",
    sortRows(due, "nextCheckAt", true).map(row => row.key),
    ["c", "d", "a", "b"]
)
/*
 * Missing last in *both* directions, which is the whole reason this is not a
 * one-line comparator. A row with no `nextCheckAt` is not the soonest thing to
 * check, and floating it to the top of an ascending sort is the one behaviour
 * that would make the column useless.
 */
eq("missing sorts last ascending", sortRows(due, "nextCheckAt").at(-1)?.key, "b")
eq("and last descending too", sortRows(due, "nextCheckAt", true).at(-1)?.key, "b")
eq(
    "sorting does not mutate the source",
    due.map(row => row.key),
    ["c", "a", "b", "d"]
)
eq(
    "strings sort naturally",
    sortRows(library, "title").map(row => row.title),
    ["I Will Eternal", "Soul Land"]
)
eq(
    "arrays sort by length",
    sortRows(library, "episodes").map(row => row.key),
    ["mundodonghua/i-will-eternal", "lmanime/soul-land"]
)
eq(
    "mixed types still produce a total order rather than a shuffle",
    sortRows([{ k: 1 }, { k: "b" }, { k: true }], "k").length,
    3
)

// ---------------------------------------------------------------- editing

console.log("\n\x1b[1mediting\x1b[0m\n")

eq("valid JSON with a key goes through", parseRow('{"key":"a/b","title":"x"}', "key").ok, true)
eq("broken JSON reports why", parseRow("{key:", "key").ok, false)
eq("an array is not a row", parseRow("[1,2]", "key"), { ok: false, error: "a row has to be a JSON object" })
eq("nor is a bare string", parseRow('"hello"', "key").ok, false)
eq("null is not a row either", parseRow("null", "key").ok, false)
/*
 * The check that earns its place: `put` on a keyless row throws a DataError
 * naming neither the store nor the field, and on storage.local it silently
 * writes under the literal string "undefined".
 */
eq("a row with no key is refused", parseRow('{"title":"x"}', "key").ok, false)
eq("so is a blank one", parseRow('{"key":"   "}', "key").ok, false)
eq("and a key of the wrong type", parseRow('{"key":42}', "key").ok, false)
eq("a fresh scaffold is not yet saveable", parseRow(scaffold(storeSpec("anime")), "key").ok, false)
eq("...blank on purpose, so it cannot be saved by accident", scaffold(storeSpec("anime")).includes('"key"'), true)

// ---------------------------------------------------------------- the summary

console.log("\n\x1b[1mseries summary\x1b[0m\n")

const anime = (overrides: Partial<TrackedAnime> = {}): TrackedAnime => ({
    key: "lmanime/soul-land",
    sourceId: "lmanime",
    seriesId: "soul-land",
    url: "https://lmanime.com/soul-land",
    title: "Soul Land",
    episodes: [],
    progress: {},
    follow: true,
    poll: true,
    categories: [],
    overrides: {},
    addedAt: 0,
    updatedAt: 0,
    lastCheckedAt: 0,
    nextCheckAt: 0,
    lastEpisodeFoundAt: 0,
    failCount: 0,
    ...overrides
})

const fresh = summarise(anime())
eq(
    "a never-watched series says so rather than showing a blank",
    fresh.some(l => l === "never watched"),
    true
)
eq(
    "a never-checked one does not claim 1970",
    fresh.some(l => l.includes("1970")),
    false
)
eq(
    "a failing series leads with the message, not the count alone",
    summarise(anime({ failCount: 3, lastError: "404" })).some(l => l.includes("404")),
    true
)
eq(
    "a rename is what gets shown, since it is what the user sees everywhere else",
    summarise(anime({ displayTitle: "Douluo Dalu" }))[0]?.startsWith("Douluo Dalu"),
    true
)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
