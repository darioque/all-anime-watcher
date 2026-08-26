/**
 * Exercise the "one show, several sources" grouping.
 *
 *   npm run check:grouping
 *
 * Two shows wrongly merged is the expensive failure here: it looks like one show
 * whose episode count jumped, and the quieter entry's watch position vanishes
 * behind the louder one's. Most of what follows is about *not* merging.
 */
import {
    groupLatest,
    groupPosition,
    groupSeries,
    groupUnwatched,
    preferredEntry,
    type Groupable
} from "~/library/grouping"

let failures = 0

function check(label: string, condition: boolean, detail = "") {
    if (condition) {
        console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`)
    } else {
        failures++
        console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`)
    }
}

function eq<T>(label: string, actual: T, expected: T) {
    check(label, Object.is(actual, expected), Object.is(actual, expected) ? "" : `got ${String(actual)}`)
}

let counter = 0
function entry(overrides: Partial<Groupable> & { title: string }): Groupable {
    const sourceId = overrides.sourceId ?? `source${counter++}`
    return {
        key: `${sourceId}/${overrides.title.toLowerCase().replace(/\W+/g, "-")}`,
        sourceId,
        episodes: [],
        ...overrides
    }
}

const eps = (...numbers: number[]) => numbers.map(number => ({ number }))

console.log("\n\x1b[1mlibrary grouping\x1b[0m\n")

// --- the basic case
const sameShow = groupSeries([
    entry({ title: "Xian Ni – Renegade Immortal", sourceId: "lmanime" }),
    entry({ title: "Xian Ni (Renegade Immortal)", sourceId: "myanime" })
])
eq("the same show on two sites is one group", sameShow.length, 1)
eq("and keeps both entries", sameShow[0]?.entries.length, 2)

// --- the expensive failure
const seasons = groupSeries([
    entry({ title: "Tales of Demons and Gods", sourceId: "a" }),
    entry({ title: "Tales of Demons and Gods 10th Season", sourceId: "b" })
])
eq("seasons are different shows", seasons.length, 2)

const numbered = groupSeries([entry({ title: "Xian Ni", sourceId: "a" }), entry({ title: "Xian Ni 2", sourceId: "b" })])
eq("a trailing number is a season, not a typo", numbered.length, 2)

const unrelated = groupSeries([
    entry({ title: "Wan Jie Du Zun", sourceId: "a" }),
    entry({ title: "Wan Jie Zhizun – The Emperor of Myriad Realms", sourceId: "b" })
])
eq("similar-looking different shows stay apart", unrelated.length, 2)

// --- tracker ids are identity, not a hint
const contradicting = groupSeries([
    entry({ title: "Xian Ni", sourceId: "a", anilistId: 1 }),
    entry({ title: "Xian Ni", sourceId: "b", anilistId: 2 })
])
eq("identical titles with different AniList ids do not merge", contradicting.length, 2)

const acrossTitles = groupSeries([
    entry({ title: "Renegade Immortal", sourceId: "a", anilistId: 7 }),
    entry({ title: "Xian Ni", sourceId: "b", anilistId: 7 })
])
eq("unalike titles with the same AniList id do merge", acrossTitles.length, 1)

// --- switching it off
eq(
    "disabled means one group per entry",
    groupSeries([entry({ title: "Xian Ni", sourceId: "a" }), entry({ title: "Xian Ni", sourceId: "b" })], {
        enabled: false
    }).length,
    2
)

/*
 * The limit of title matching, stated rather than papered over.
 *
 * "Wan Jie Du Zun" and "Wan Jie Du Zun – Ten Thousand Worlds" are the same
 * donghua — one site kept the short name — but as strings they share barely half
 * their bigrams, and the threshold that would merge them also merges things that
 * are not the same show. A prefix rule was considered and rejected for the same
 * reason: it cannot tell a subtitle from a different series.
 *
 * This is why the tracker id is the real mechanism and the title is the
 * fallback. Both entries get an AniList id automatically on add, and the group
 * forms then.
 */
const partial = groupSeries([
    entry({ title: "Wan Jie Du Zun", sourceId: "a" }),
    entry({ title: "Wan Jie Du Zun – Ten Thousand Worlds", sourceId: "b" })
])
eq("a half-written title does not merge on its own", partial.length, 2)

const matchedLater = groupSeries([
    entry({ title: "Wan Jie Du Zun", sourceId: "a", anilistId: 99 }),
    entry({ title: "Wan Jie Du Zun – Ten Thousand Worlds", sourceId: "b", anilistId: 99, poster: "b.jpg" })
])
eq("once both are matched it does", matchedLater.length, 1)

// --- title and poster selection
eq("the fuller title represents the group", matchedLater[0]?.title, "Wan Jie Du Zun – Ten Thousand Worlds")
eq("and a poster is taken from whichever entry has one", matchedLater[0]?.poster, "b.jpg")

const renamed = groupSeries([
    entry({ title: "Xian Ni – Renegade Immortal", sourceId: "a" }),
    entry({ title: "Xian Ni (Renegade Immortal)", sourceId: "b", displayTitle: "My own name for it" })
])
eq("a name the user typed wins outright", renamed[0]?.title, "My own name for it")

// --- aggregates across sources
const spread = groupSeries([
    entry({ title: "Show", sourceId: "a", episodes: eps(1, 2, 3), lastWatched: { number: 3 } }),
    entry({ title: "Show", sourceId: "b", episodes: eps(1, 2, 3, 4, 5, 6), lastWatched: { number: 2 } })
])
const group = spread[0]!
eq("one group", spread.length, 1)
eq("latest is the newest any source carries", groupLatest(group), 6)
eq("position is the furthest reached on any source", groupPosition(group), 3)
eq("unwatched counts each episode once", groupUnwatched(group), 3)
eq("and the watch button points at the source carrying the next one", preferredEntry(group)?.sourceId, "b")

// A source that is behind should not be chosen just because it is listed first.
const behind = groupSeries([
    entry({ title: "Show", sourceId: "slow", episodes: eps(1, 2), lastWatched: { number: 2 } }),
    entry({ title: "Show", sourceId: "fast", episodes: eps(1, 2, 3) })
])
eq("a stale source is not preferred", preferredEntry(behind[0]!)?.sourceId, "fast")

// Nothing unwatched anywhere still has to point somewhere.
const caughtUp = groupSeries([
    entry({ title: "Show", sourceId: "a", episodes: eps(1), lastWatched: { number: 9 } }),
    entry({ title: "Show", sourceId: "b", episodes: eps(1, 2, 3), lastWatched: { number: 9 } })
])
eq("caught up falls back to the fullest source", preferredEntry(caughtUp[0]!)?.sourceId, "b")
eq("and reports nothing unwatched", groupUnwatched(caughtUp[0]!), 0)

// A never-started group counts everything as unwatched.
const fresh = groupSeries([entry({ title: "Show", sourceId: "a", episodes: eps(1, 2, 3) })])
eq("an unstarted series counts every episode", groupUnwatched(fresh[0]!), 3)
eq("and has no position", groupPosition(fresh[0]!), null)

// --- stable ids
const byId = groupSeries([entry({ title: "Anything", sourceId: "a", anilistId: 42 })])
eq("a matched group is keyed on its tracker id", byId[0]?.id, "anilist:42")
check("an unmatched one is keyed on its title", groupSeries([entry({ title: "Xian Ni" })])[0]?.id === "title:xian ni")

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
