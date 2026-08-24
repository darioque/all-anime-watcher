import { normalise, seasonOf, similarity } from "~/trackers/matching"

/**
 * One show, however many sources carry it.
 *
 * The library keys entries by `${sourceId}/${seriesId}`, which is right — a
 * series on two sites is two things to fetch, two episode lists and two sets of
 * URLs. But it is one show to the person watching it, and a library that lists
 * it twice makes them do the reconciling.
 *
 * Pure on purpose: no storage, no settings, no messaging. Deciding that two
 * strings name the same show is exactly the kind of rule that is impossible to
 * get right without being able to run it over a pile of real titles.
 */

/** The parts of a library entry grouping actually reads. */
export interface Groupable {
    key: string
    sourceId: string
    title: string
    displayTitle?: string
    poster?: string
    anilistId?: number
    episodes: { number: number }[]
    lastWatched?: { number: number }
}

export interface SeriesGroup<T extends Groupable> {
    /** Stable across reorderings, so the UI can key on it. */
    id: string
    title: string
    poster?: string
    anilistId?: number
    /** Always at least one, ordered as they were handed in. */
    entries: T[]
}

/**
 * How alike two titles have to be before they are called the same show.
 *
 * High, because the failure is silent and asymmetric: two shows wrongly merged
 * look like one show whose episode count jumped, and the watch position of the
 * quieter one disappears behind the louder one's. Two shows wrongly kept apart
 * look like exactly what the library did before this existed.
 */
const SAME_TITLE = 0.87

export interface GroupOptions {
    /** Off returns one group per entry, which is the ungrouped library. */
    enabled?: boolean
    threshold?: number
}

export function groupSeries<T extends Groupable>(entries: T[], options: GroupOptions = {}): SeriesGroup<T>[] {
    const { enabled = true, threshold = SAME_TITLE } = options

    if (!enabled) return entries.map(entry => singleton(entry))

    const groups: SeriesGroup<T>[] = []

    for (const entry of entries) {
        const home = groups.find(group => belongs(entry, group, threshold))
        if (home) {
            home.entries.push(entry)
            reconcile(home)
        } else {
            groups.push(singleton(entry))
        }
    }

    return groups
}

/** Does this entry belong in an existing group? */
function belongs<T extends Groupable>(entry: T, group: SeriesGroup<T>, threshold: number): boolean {
    /*
     * A tracker id is an identity, not a hint. Two entries carrying the same one
     * are the same show whatever their titles say, and two carrying different
     * ones are not the same show however alike they read — which is what keeps
     * "Xian Ni" and "Xian Ni 2" apart once both are matched.
     */
    if (entry.anilistId !== undefined && group.anilistId !== undefined) {
        return entry.anilistId === group.anilistId
    }

    /*
     * Everything below compares *source* titles rather than display ones. A
     * rename says what the user wants to read, not what the show is, and
     * matching on it meant renaming one entry silently split it out of its own
     * group.
     */

    // A season number is a hard separator: normalise() strips season words, so
    // without this "Tales of Demons and Gods" and its 10th season are identical.
    const representative = group.entries[0]
    if (!representative) return false
    if (seasonOf(entry.title) !== seasonOf(representative.title)) return false

    return group.entries.some(other => similarity(normalise(entry.title), normalise(other.title)) >= threshold)
}

function singleton<T extends Groupable>(entry: T): SeriesGroup<T> {
    const group: SeriesGroup<T> = {
        id: groupId(entry),
        title: titleOf(entry),
        ...(entry.poster ? { poster: entry.poster } : {}),
        ...(entry.anilistId !== undefined ? { anilistId: entry.anilistId } : {}),
        entries: [entry]
    }
    return group
}

/**
 * Pick the group's title and poster once it has more than one entry.
 *
 * A name the user typed wins outright. Otherwise the longest — sites truncate
 * ("Wan Jie Du Zun" against "Wan Jie Du Zun – Ten Thousand Worlds"), they do not
 * embellish — preferring a tracker-matched entry where that is a choice at all,
 * since its title is canonical rather than whatever a site called it.
 */
function reconcile<T extends Groupable>(group: SeriesGroup<T>): void {
    const longest = (candidates: T[]) => [...candidates].sort((a, b) => titleOf(b).length - titleOf(a).length)[0]

    const matched = group.entries.filter(entry => entry.anilistId !== undefined)
    const best =
        group.entries.find(entry => entry.displayTitle?.trim()) ??
        (matched.length > 0 ? longest(matched) : undefined) ??
        longest(group.entries)

    if (best) {
        group.title = titleOf(best)
        group.id = groupId(best)
    }

    const withPoster = group.entries.find(entry => entry.poster)
    if (withPoster?.poster) group.poster = withPoster.poster
    else delete group.poster

    const id = matched[0]?.anilistId
    if (id !== undefined) group.anilistId = id
}

/**
 * Stable identity for a group.
 *
 * Keyed on the tracker id where there is one so the group survives a source
 * being added or removed; on the normalised title otherwise, which is the same
 * thing grouping was decided on.
 */
function groupId(entry: Groupable): string {
    if (entry.anilistId !== undefined) return `anilist:${entry.anilistId}`
    // The source's title, not the user's rename: renaming a series is a display
    // preference and should not move it to a different group.
    const key = normalise(entry.title)
    return key === "" ? `entry:${entry.key}` : `title:${key}`
}

export function titleOf(entry: Pick<Groupable, "title" | "displayTitle">): string {
    const own = entry.displayTitle?.trim()
    return own && own !== "" ? own : entry.title
}

// ------------------------------------------------------------------ aggregates

/** The newest episode any source in the group carries. */
export function groupLatest<T extends Groupable>(group: SeriesGroup<T>): number | null {
    let highest: number | null = null
    for (const entry of group.entries) {
        for (const episode of entry.episodes) {
            if (highest === null || episode.number > highest) highest = episode.number
        }
    }
    return highest
}

/**
 * How far through the show the viewer is, across every source.
 *
 * The furthest point, not each source's own: watching episode 40 on one site and
 * then 41 on another is being at 41, and reporting 40 because that is where the
 * first source's pointer stopped would be wrong in the direction that shows
 * episodes as unwatched when they are not.
 */
export function groupPosition<T extends Groupable>(group: SeriesGroup<T>): number | null {
    let furthest: number | null = null
    for (const entry of group.entries) {
        const at = entry.lastWatched?.number
        if (at !== undefined && (furthest === null || at > furthest)) furthest = at
    }
    return furthest
}

/**
 * Episodes available above the viewer's position, counted once however many
 * sources carry them.
 */
export function groupUnwatched<T extends Groupable>(group: SeriesGroup<T>): number {
    const from = groupPosition(group)
    const above = new Set<number>()

    for (const entry of group.entries) {
        for (const episode of entry.episodes) {
            if (from === null || episode.number > from) above.add(episode.number)
        }
    }
    return above.size
}

/**
 * Which source to watch on: the one carrying the episode you would watch next.
 *
 * Ties go to the entry listed first, which is the library's own order, so the
 * choice is stable rather than flipping between sources on every render.
 */
export function preferredEntry<T extends Groupable>(group: SeriesGroup<T>): T | undefined {
    const from = groupPosition(group)

    let best: T | undefined
    let bestNext: number | null = null

    for (const entry of group.entries) {
        const next = entry.episodes.reduce<number | null>(
            (lowest, episode) =>
                (from === null || episode.number > from) && (lowest === null || episode.number < lowest)
                    ? episode.number
                    : lowest,
            null
        )
        if (next === null) continue
        if (bestNext === null || next < bestNext) {
            best = entry
            bestNext = next
        }
    }

    // Nothing unwatched anywhere: fall back to whichever source has the most, so
    // the row still points somewhere useful.
    return best ?? [...group.entries].sort((a, b) => b.episodes.length - a.episodes.length)[0]
}
