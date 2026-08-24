import { titlesOf, searchAniList, type AniListMedia } from "./anilist"

/**
 * Title matching, kept free of storage and settings so it can be exercised
 * without an extension around it.
 *
 * The same split as background/schedule.ts, and for the same reason: a scoring
 * function that reaches into IndexedDB can only be tested by running the whole
 * browser, which means in practice it never gets tested at all.
 */
export interface MatchCandidate {
    media: AniListMedia
    /** 0–1. Above CONFIDENT the match is applied without asking. */
    score: number
}

/**
 * How sure we have to be before linking a series without the user saying so.
 *
 * Deliberately strict. A wrong link puts the wrong poster and the wrong airing
 * schedule on a series, and the user has no reason to suspect it — far worse
 * than leaving it unlinked and visibly unmatched.
 */
export const CONFIDENT = 0.9

/** Strip everything that varies between how two sites write the same title. */
function normalise(title: string): string {
    return title
        .toLowerCase()
        .replace(/\(\s*\d{4}\s*\)/g, " ")
        .replace(/\b(season|series|part|cour)\s*\d+\b/g, " ")
        .replace(/\b(sub|dub|subbed|dubbed|english|eng|latino|castellano)\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
}

/** Dice coefficient over bigrams — forgiving of word order and small edits. */
function similarity(a: string, b: string): number {
    if (a === b) return 1
    if (a.length < 2 || b.length < 2) return 0

    const bigrams = (value: string) => {
        const out = new Map<string, number>()
        for (let i = 0; i < value.length - 1; i++) {
            const pair = value.slice(i, i + 2)
            out.set(pair, (out.get(pair) ?? 0) + 1)
        }
        return out
    }

    const first = bigrams(a)
    const second = bigrams(b)
    let shared = 0
    for (const [pair, count] of first) {
        const other = second.get(pair)
        if (other) shared += Math.min(count, other)
    }
    return (2 * shared) / (a.length - 1 + (b.length - 1))
}

/**
 * The season a title names, if it names one.
 *
 * "Season 5", "S5", "Part 2", or a bare trailing number as several donghua sites
 * write it ("Tales of Demons and Gods 10").
 */
export function seasonOf(title: string): number | null {
    const worded = /\b(?:season|s|part|cour)\s*0*(\d{1,2})\b/i.exec(title)
    if (worded?.[1]) return Number.parseInt(worded[1], 10)
    const trailing = /\s0*(\d{1,2})\s*$/.exec(title.trim())
    return trailing?.[1] ? Number.parseInt(trailing[1], 10) : null
}

/**
 * What to actually send to AniList.
 *
 * Its search is unforgiving: "A Record of A Mortal's Journey to Immortality
 * Season 05" returns nothing, while the same title without the season returns
 * the series. So the season marker comes out of the *query* — and goes back into
 * the *scoring* below, where it stops season 5 quietly linking to season 1.
 */
export function searchQuery(title: string): string {
    return title
        .replace(/\(\s*\d{4}\s*\)/g, " ")
        .replace(/\b(?:season|part|cour)\s*0*\d{1,2}\b/gi, " ")
        .replace(/\b(?:sub|dub|subbed|dubbed|subtitulado|latino|castellano)\b/gi, " ")
        .replace(/[’']/g, "'")
        .replace(/\s+/g, " ")
        .trim()
}

export function scoreMatch(localTitle: string, media: AniListMedia): number {
    const local = normalise(localTitle)
    const best = titlesOf(media).reduce((top, title) => Math.max(top, similarity(local, normalise(title))), 0)

    // A season mismatch is the dangerous near-miss: season 5 and season 1 have
    // nearly identical titles, and picking the wrong one silently attaches the
    // wrong air schedule. If we name a season and no title of theirs mentions it,
    // hold the score below the auto-link threshold and let the user decide.
    const wanted = seasonOf(localTitle)
    if (wanted !== null && wanted > 1) {
        const mentioned = titlesOf(media).some(title => seasonOf(title) === wanted)
        if (!mentioned) return Math.min(best, CONFIDENT - 0.05)
    }

    return best
}

/**
 * Ranked candidates for a title, best first.
 *
 * Searches the cleaned query first and falls back to the raw title, because each
 * finds things the other misses — the cleaned form gets past AniList's dislike of
 * season markers, the raw form keeps punctuation that occasionally matters.
 */
export async function findMatches(title: string): Promise<MatchCandidate[]> {
    const cleaned = searchQuery(title)
    let media = await searchAniList(cleaned)

    if (media.length === 0 && cleaned !== title) {
        media = await searchAniList(title)
    }

    const seen = new Set<number>()
    return media
        .filter(item => (seen.has(item.id) ? false : seen.add(item.id) && true))
        .map(item => ({ media: item, score: scoreMatch(title, item) }))
        .sort((a, b) => b.score - a.score)
}
