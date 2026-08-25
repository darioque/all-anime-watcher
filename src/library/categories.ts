import type { SeriesMeta, TrackedAnime } from "~/model/types"

/**
 * Shelves for a library that has outgrown one list.
 *
 * Two kinds, because neither alone is enough. A *manual* category is a shelf the
 * user made — "rewatching", "with my brother", "waiting for a batch" — and
 * nothing outside their head can populate it. An *automatic* one is a question
 * already answered by data we hold: whether a show is a donghua, whether it is
 * still airing, whether it is a film. Asking someone to tag four hundred series
 * by hand with facts a tracker already knows is how a feature like this goes
 * unused.
 *
 * The interesting one is `countryOfOrigin`. No site says whether it is showing
 * anime or donghua — several carry both and label neither — and the genres do
 * not distinguish them either. AniList does, and it is the single most useful
 * split for this library.
 *
 * Pure on purpose: no storage, no settings. Membership and filtering are rules,
 * and rules are the part worth being able to run over a real library.
 */

export type CategoryRule =
    /** The user assigns it; `anime.categories` is the record. */
    | { kind: "manual" }
    /** AniList `countryOfOrigin`: CN, JP, KR. */
    | { kind: "country"; value: string }
    | { kind: "genre"; value: string }
    /** TV, MOVIE, ONA, OVA, SPECIAL. */
    | { kind: "format"; value: string }
    /** RELEASING, FINISHED, HIATUS, CANCELLED. */
    | { kind: "status"; value: string }
    /** Everything from one site. */
    | { kind: "source"; value: string }

export interface Category {
    /** Stable; `anime.categories` holds these, so renaming an id orphans membership. */
    id: string
    name: string
    rule: CategoryRule
}

/**
 * Three states, expressed as two: a category not in the map is neutral.
 *
 * Storing neutral explicitly would make "no filter" and "every filter cleared"
 * two different objects that behave identically, which is the kind of
 * distinction that eventually leaks into a comparison somewhere.
 */
export type CategoryFilter = Record<string, "include" | "exclude">

/** What a source claims about everything it carries — see `AnimeSource.categories`. */
export type SourceCategories = Record<string, string[] | undefined>

/**
 * Which categories an entry is in.
 *
 * Manual membership is read from the entry; automatic membership is computed
 * every time rather than stored, so a category whose rule changes takes effect
 * at once and a series never carries a stale tag from a rule that no longer
 * exists.
 */
export function categoriesOf(
    anime: Pick<TrackedAnime, "categories" | "meta" | "sourceId">,
    categories: Category[],
    sources: SourceCategories = {}
): string[] {
    const manual = new Set(anime.categories ?? [])
    const claimed = (sources[anime.sourceId] ?? []).map(name => name.toLowerCase())

    return categories
        .filter(category => {
            if (category.rule.kind === "manual") return manual.has(category.id)

            /*
             * A site that only ever carries donghua is telling us something a
             * tracker match would also tell us, but sooner and without a
             * network round trip — and for the series AniList has never heard
             * of, it is the only thing that will ever say so.
             */
            if (claimed.includes(category.name.toLowerCase())) return true

            return matchesRule(category.rule, anime.meta, anime.sourceId)
        })
        .map(category => category.id)
}

function matchesRule(rule: CategoryRule, meta: SeriesMeta | undefined, sourceId: string): boolean {
    switch (rule.kind) {
        case "manual":
            return false
        case "source":
            return sourceId === rule.value
        case "country":
            return meta?.countryOfOrigin === rule.value
        case "format":
            return meta?.format === rule.value
        case "status":
            return meta?.status === rule.value
        case "genre":
            return (meta?.genres ?? []).some(genre => genre.toLowerCase() === rule.value.toLowerCase())
    }
}

/**
 * Does an entry survive the filter?
 *
 * Ticked categories narrow (every one must match) and crossed ones remove (any
 * one is enough). That asymmetry is deliberate: ticking two things means "show
 * me what is both", which is what narrowing a list is for, while crossing two
 * means "neither of these", which only reads correctly as OR.
 */
export function matchesCategories(memberships: string[], filter: CategoryFilter): boolean {
    const mine = new Set(memberships)

    for (const [id, state] of Object.entries(filter)) {
        if (state === "exclude" && mine.has(id)) return false
        if (state === "include" && !mine.has(id)) return false
    }
    return true
}

/** Turn a chip click into the next of its three states. */
export function cycleFilter(filter: CategoryFilter, id: string): CategoryFilter {
    const next = { ...filter }
    if (next[id] === "include") next[id] = "exclude"
    else if (next[id] === "exclude") delete next[id]
    else next[id] = "include"
    return next
}

/** Drop filter entries for categories that no longer exist, so a deletion sticks. */
export function pruneFilter(filter: CategoryFilter, categories: Category[]): CategoryFilter {
    const known = new Set(categories.map(category => category.id))
    return Object.fromEntries(Object.entries(filter).filter(([id]) => known.has(id)))
}

/**
 * The shelves worth having before anyone asks for one.
 *
 * Kept short. A category per AniList genre would be twenty rows of chips on
 * first run, which is not a feature, it is a wall — the genres are offered from
 * a picker instead, built from what the library actually contains.
 */
export function defaultCategories(): Category[] {
    return [
        { id: "cat-donghua", name: "Donghua", rule: { kind: "country", value: "CN" } },
        { id: "cat-anime", name: "Anime", rule: { kind: "country", value: "JP" } },
        { id: "cat-aeni", name: "Aeni", rule: { kind: "country", value: "KR" } },
        { id: "cat-airing", name: "Airing", rule: { kind: "status", value: "RELEASING" } },
        { id: "cat-finished", name: "Finished", rule: { kind: "status", value: "FINISHED" } },
        { id: "cat-movies", name: "Movies", rule: { kind: "format", value: "MOVIE" } }
    ]
}

/**
 * Genres present in the library, most common first.
 *
 * Offered rather than imposed: which genres are worth a shelf depends entirely
 * on what someone watches, and the answer is in their own library.
 */
export function genresInLibrary(library: Pick<TrackedAnime, "meta">[]): { genre: string; count: number }[] {
    const counts = new Map<string, number>()
    for (const anime of library) {
        for (const genre of anime.meta?.genres ?? []) {
            counts.set(genre, (counts.get(genre) ?? 0) + 1)
        }
    }
    return [...counts]
        .map(([genre, count]) => ({ genre, count }))
        .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre))
}

/** How many entries are in each category, for the chip labels. */
export function categoryCounts(
    library: Pick<TrackedAnime, "categories" | "meta" | "sourceId">[],
    categories: Category[],
    sources: SourceCategories = {}
): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const anime of library) {
        for (const id of categoriesOf(anime, categories, sources)) {
            counts[id] = (counts[id] ?? 0) + 1
        }
    }
    return counts
}

/** A new manual shelf. Ids are generated rather than derived from the name so a rename is free. */
export function newCategory(name: string, rule: CategoryRule = { kind: "manual" }): Category {
    return { id: `cat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name: name.trim(), rule }
}
