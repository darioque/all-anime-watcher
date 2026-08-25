/**
 * Exercise category membership and filtering.
 *
 *   npm run check:categories
 *
 * The filter's asymmetry is the part worth pinning down: ticking two categories
 * narrows (both must match) while crossing two removes (either is enough). Both
 * readings are defensible in the abstract and only one is right for each
 * gesture, so the rule is easy to "fix" in the wrong direction later.
 */
import {
    categoriesOf,
    categoryCounts,
    cycleFilter,
    defaultCategories,
    genresInLibrary,
    matchesCategories,
    newCategory,
    pruneFilter,
    type Category,
    type CategoryFilter
} from "~/library/categories"
import type { TrackedAnime } from "~/model/types"

let failures = 0

function eq(label: string, actual: unknown, expected: unknown) {
    const a = JSON.stringify(actual) ?? "undefined"
    const b = JSON.stringify(expected) ?? "undefined"
    if (a !== b) failures++
    console.log(`  ${a === b ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${a === b ? "" : ` — got ${a}`}`)
}

type Entry = Pick<TrackedAnime, "categories" | "meta" | "sourceId">

const entry = (overrides: Partial<Entry> = {}): Entry => ({
    sourceId: "myanime",
    categories: [],
    ...overrides
})

const cats = defaultCategories()
const id = (name: string) => cats.find(category => category.name === name)!.id

console.log("\n\x1b[1mautomatic membership\x1b[0m\n")

/*
 * The one that matters most for this library. No site says whether it is showing
 * anime or donghua — several carry both and label neither — and the genres do
 * not distinguish them. AniList's countryOfOrigin does.
 */
const donghua = entry({ meta: { countryOfOrigin: "CN", status: "RELEASING", genres: ["Action", "Fantasy"] } })
eq("a Chinese series is a donghua", categoriesOf(donghua, cats).includes(id("Donghua")), true)
eq("and not anime", categoriesOf(donghua, cats).includes(id("Anime")), false)
eq("a running series is airing", categoriesOf(donghua, cats).includes(id("Airing")), true)
eq(
    "a Japanese finished film lands in three",
    categoriesOf(entry({ meta: { countryOfOrigin: "JP", status: "FINISHED", format: "MOVIE" } }), cats).length,
    3
)
eq("an unmatched series is in none of them", categoriesOf(entry(), cats).length, 0)

console.log("\n\x1b[1mmanual membership\x1b[0m\n")

const shelf = newCategory("Rewatching")
const withManual = [...cats, shelf]
eq("a manual shelf holds what was put on it", categoriesOf(entry({ categories: [shelf.id] }), withManual), [shelf.id])
eq("and nothing else lands there by accident", categoriesOf(donghua, withManual).includes(shelf.id), false)
// Ids are generated rather than derived from the name, so renaming is free.
eq("two shelves with the same name are still two shelves", newCategory("A").id === newCategory("A").id, false)

console.log("\n\x1b[1mwhat a source knows\x1b[0m\n")

/*
 * A site that only ever carries donghua is telling us what a tracker match would
 * also tell us — but sooner, without a network round trip, and for the many
 * series AniList has never heard of it is the only thing that ever will.
 */
const claims = { mundodonghua: ["Donghua"] }
const untracked = entry({ sourceId: "mundodonghua" })
eq("a donghua-only source seeds the shelf with no tracker at all", categoriesOf(untracked, cats, claims), [
    id("Donghua")
])
eq("a source that claims nothing seeds nothing", categoriesOf(entry({ sourceId: "myanime" }), cats, claims).length, 0)
eq("the claim is matched by name, case aside", categoriesOf(untracked, cats, { mundodonghua: ["donghua"] }).length, 1)

console.log("\n\x1b[1mfiltering\x1b[0m\n")

const mine = [id("Donghua"), id("Airing")]

eq("an empty filter passes everything", matchesCategories(mine, {}), true)
eq("a ticked category it has passes", matchesCategories(mine, { [id("Donghua")]: "include" }), true)
eq("a ticked category it lacks does not", matchesCategories(mine, { [id("Anime")]: "include" }), false)

// Ticking narrows: "show me what is both", which is what narrowing a list means.
eq(
    "two ticks mean both",
    matchesCategories(mine, { [id("Donghua")]: "include", [id("Airing")]: "include" }),
    true
)
eq(
    "and one of them missing is enough to drop it",
    matchesCategories(mine, { [id("Donghua")]: "include", [id("Movies")]: "include" }),
    false
)

// Crossing removes: "neither of these", which only reads correctly as OR.
eq("a crossed category it has removes it", matchesCategories(mine, { [id("Airing")]: "exclude" }), false)
eq("a crossed category it lacks leaves it", matchesCategories(mine, { [id("Movies")]: "exclude" }), true)
eq(
    "either crossed category is enough",
    matchesCategories(mine, { [id("Movies")]: "exclude", [id("Airing")]: "exclude" }),
    false
)
eq(
    "and a cross beats a tick on the same entry",
    matchesCategories(mine, { [id("Donghua")]: "include", [id("Airing")]: "exclude" }),
    false
)
eq("an entry in nothing survives an empty filter", matchesCategories([], {}), true)
eq("but not a tick", matchesCategories([], { [id("Donghua")]: "include" }), false)

console.log("\n\x1b[1mthe chip's three states\x1b[0m\n")

let filter: CategoryFilter = {}
filter = cycleFilter(filter, "x")
eq("first click includes", filter.x, "include")
filter = cycleFilter(filter, "x")
eq("second excludes", filter.x, "exclude")
filter = cycleFilter(filter, "x")
// Neutral is absence, not a third stored value: "no filter" and "every filter
// cleared" must not be two objects that behave the same.
eq("third clears it back to neutral", "x" in filter, false)

const stale: CategoryFilter = { [id("Donghua")]: "include", "cat-deleted": "exclude" }
eq("a filter on a deleted category is pruned", pruneFilter(stale, cats), { [id("Donghua")]: "include" })

console.log("\n\x1b[1mcounts and pickers\x1b[0m\n")

const library: Entry[] = [
    donghua,
    entry({ meta: { countryOfOrigin: "CN", status: "FINISHED", genres: ["Action"] } }),
    entry({ meta: { countryOfOrigin: "JP", status: "RELEASING", genres: ["Comedy"] } })
]

const counts = categoryCounts(library, cats)
eq("counts add up per category", counts[id("Donghua")], 2)
eq("and skip categories nothing is in", counts[id("Movies")], undefined)

// Which genres deserve a shelf depends on what someone watches, and the answer
// is in their own library rather than in AniList's full list of twenty.
eq("genres are offered most-used first", genresInLibrary(library)[0], { genre: "Action", count: 2 })
eq("and each appears once", genresInLibrary(library).length, 3)

const withGenre: Category[] = [...cats, newCategory("Action", { kind: "genre", value: "Action" })]
eq(
    "a genre shelf matches case-insensitively",
    categoriesOf(entry({ meta: { genres: ["action"] } }), withGenre).length,
    1
)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
