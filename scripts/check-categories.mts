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
    automaticCategoriesOf,
    newCategory,
    offeredCategories,
    shelveOverrides,
    pruneFilter,
    unseededCategories,
    type Category,
    type CategoryFilter
} from "~/library/categories"
import type { Categorisable } from "~/library/categories"
import { defaultSettings } from "~/settings/schema"

let failures = 0

function eq(label: string, actual: unknown, expected: unknown) {
    const a = JSON.stringify(actual) ?? "undefined"
    const b = JSON.stringify(expected) ?? "undefined"
    if (a !== b) failures++
    console.log(`  ${a === b ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${a === b ? "" : ` — got ${a}`}`)
}

type Entry = Categorisable

const entry = (overrides: Partial<Entry> = {}): Entry => ({
    sourceId: "myanime",
    categories: [],
    follow: true,
    poll: true,
    failCount: 0,
    episodes: [],
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
eq("two ticks mean both", matchesCategories(mine, { [id("Donghua")]: "include", [id("Airing")]: "include" }), true)
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

console.log("\n\x1b[1mstate shelves\x1b[0m\n")

/*
 * These are the shelves worth a visible count. "Failing" at zero reads as
 * reassurance; the moment it does not, one click says which series stopped
 * working — which beats scrolling a library hunting for a small red line.
 */
eq("a series whose checks are failing lands on Failing", categoriesOf(entry({ failCount: 2 }), cats), [id("Failing")])
eq("a healthy one does not", categoriesOf(entry({ failCount: 0 }), cats).includes(id("Failing")), false)
eq("an unfollowed series is on Not following", categoriesOf(entry({ follow: false }), cats), [id("Not following")])
eq("an unpolled one is on Not checking", categoriesOf(entry({ poll: false }), cats), [id("Not checking")])
eq("and a series can be on both at once", categoriesOf(entry({ follow: false, poll: false }), cats).length, 2)
// Crossing these is the filter the whole thing is for: "show me the library
// minus the ones I have paused".
eq(
    "crossing them hides exactly those",
    matchesCategories(categoriesOf(entry({ poll: false }), cats), { [id("Not checking")]: "exclude" }),
    false
)
eq("and leaves the rest", matchesCategories(categoriesOf(entry(), cats), { [id("Not checking")]: "exclude" }), true)

console.log("\n\x1b[1mcorrecting a shelf by hand\x1b[0m\n")

/*
 * The reason this exists: "Donghua" is AniList's countryOfOrigin, which is
 * simply absent for every series added before tracker matching existed, and for
 * every one AniList lists under a name no search of ours finds. A shelf that
 * cannot be corrected by hand is a shelf that is quietly wrong, so the rule is
 * evidence and the user is the decision — on automatic shelves too, not just on
 * the manual ones.
 */
const unmatched = entry({ sourceId: "lmanime" })
eq("an unmatched series is on no automatic shelf", categoriesOf(unmatched, cats).length, 0)

const put = shelveOverrides(unmatched, id("Donghua"), true, false)
eq("putting it on Donghua records the override", put.categories, [id("Donghua")])
eq("and it is then on the shelf", categoriesOf({ ...unmatched, ...put }, cats).includes(id("Donghua")), true)
eq("counts follow the correction", categoryCounts([{ ...unmatched, ...put }], cats)[id("Donghua")], 1)

/*
 * The symmetric case. Taking a series off a shelf a rule puts it on has to
 * record an exclusion — deleting from the "on" list would achieve nothing, since
 * the rule would file it there again on the next render.
 */
const wrong = entry({ meta: { countryOfOrigin: "CN" } })
const off = shelveOverrides(wrong, id("Donghua"), false, true)
eq("taking it off an automatic shelf records an exclusion", off.categoriesOff, [id("Donghua")])
eq("and the rule no longer wins", categoriesOf({ ...wrong, ...off }, cats).includes(id("Donghua")), false)
eq(
    "while the rule itself is untouched",
    automaticCategoriesOf({ ...wrong, ...off }, cats).includes(id("Donghua")),
    true
)

/* Only the disagreement is stored, so neither list becomes a stale copy of the rules. */
eq("ticking a shelf that already matches records nothing", shelveOverrides(wrong, id("Donghua"), true, true), {
    categories: [],
    categoriesOff: []
})
eq("unticking one that never matched records nothing", shelveOverrides(unmatched, id("Donghua"), false, false), {
    categories: [],
    categoriesOff: []
})
eq(
    "and a correction is undone by the opposite one",
    shelveOverrides({ ...unmatched, ...put }, id("Donghua"), false, false).categories,
    []
)

/* A manual shelf still behaves exactly as it did: it has no rule to overrule. */
const shelfOnly = [...cats, shelf]
eq(
    "a manual shelf is automatic for nothing",
    automaticCategoriesOf(entry({ categories: [shelf.id] }), shelfOnly).includes(shelf.id),
    false
)
eq(
    "but still holds what was put on it",
    categoriesOf(entry({ categories: [shelf.id] }), shelfOnly).includes(shelf.id),
    true
)

console.log("\n\x1b[1mseeding built-ins into an existing profile\x1b[0m\n")

/*
 * Settings are stored whole and merged over the defaults, so a `categories`
 * array written by an earlier version wins outright and a newly added built-in
 * would never appear. Seeding by id fixes that — but "add the defaults that are
 * missing" and "undo a deletion" are the same statement unless what has been
 * *offered* is tracked separately.
 */
const oldProfile = cats.filter(category => category.rule.kind !== "state")
eq(
    "a profile from before state shelves gets them",
    unseededCategories(
        oldProfile,
        oldProfile.map(c => c.id)
    ).length,
    3
)
eq(
    "a current profile gets nothing",
    unseededCategories(
        cats,
        cats.map(c => c.id)
    ).length,
    0
)
eq(
    "and a shelf deleted on purpose stays deleted",
    unseededCategories(
        cats.filter(category => category.id !== "cat-movies"),
        cats.map(c => c.id)
    ).length,
    0
)
eq("a brand-new profile is seeded once", unseededCategories([], []).length, defaultCategories().length)

/*
 * Where this actually went wrong, and why the rules above all passed while the
 * shelves never appeared: `seededCategories` *defaulted* to every built-in id.
 * Settings are stored whole and merged over the defaults, so a profile written
 * before the state shelves existed inherited "all of them have been offered"
 * about shelves it had never been shown. The fault is in a default value rather
 * than in a rule, which is invisible from inside this module — so it is checked
 * against the schema itself.
 */
const settings = defaultSettings()
eq("nothing is claimed as offered by default", settings.seededCategories.length, 0)
eq(
    "so a profile that predates a built-in is still offered it",
    unseededCategories(oldProfile, settings.seededCategories).length,
    3
)
eq(
    "and a fresh profile, which already has them all, is offered nothing",
    unseededCategories(settings.categories, settings.seededCategories).length,
    0
)

/*
 * Deletion has to stay stuck without that default doing the work. Saving the
 * shelf list is what records them as offered, using the list from *before* the
 * save — which is the only moment a shelf about to be deleted is still visible.
 */
const afterDelete = cats.filter(category => category.id !== "cat-movies")
eq("saving records what was on screen as offered", offeredCategories([], cats).includes("cat-movies"), true)
eq(
    "so a deleted shelf does not come back on the next start",
    unseededCategories(afterDelete, offeredCategories([], cats)).length,
    0
)
eq("and offering is cumulative, never a replacement", offeredCategories(["cat-gone"], afterDelete).length, cats.length)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
