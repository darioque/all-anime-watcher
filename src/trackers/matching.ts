import { titlesOf, searchAniList, getAniListMedia, type AniListMedia } from "./anilist"

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
export function normalise(title: string): string {
    return title
        .toLowerCase()
        .replace(/\(\s*\d{4}\s*\)/g, " ")
        .replace(/\b(season|series|part|cour)\s*\d+\b/g, " ")
        .replace(/\b(sub|dub|subbed|dubbed|english|eng|latino|castellano)\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
}

/** Dice coefficient over bigrams — forgiving of word order and small edits. */
export function similarity(a: string, b: string): number {
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

    return dedupe(media)
        .map(item => ({ media: item, score: scoreMatch(title, item) }))
        .sort((a, b) => b.score - a.score)
}

/**
 * The AniList id in something the user pasted: a bare id, or any of its URLs.
 *
 * Pasting the page is the way out of the case manual search exists for — a
 * series AniList carries under a romanisation nobody would guess, where the user
 * can find it in their browser and no query here ever will.
 */
export function anilistIdFrom(query: string): number | null {
    const text = query.trim()
    if (/^\d+$/.test(text)) return Number.parseInt(text, 10)

    const url = /anilist\.co\/(?:anime|manga)\/(\d+)/i.exec(text)
    return url?.[1] ? Number.parseInt(url[1], 10) : null
}

/**
 * Candidates for a query the user typed themselves.
 *
 * Two things differ from `findMatches`, both deliberate:
 *
 *  - The query is sent as typed. Cleaning exists to get an *automatic* search
 *    past AniList's dislike of season markers; when someone types "Season 2"
 *    here they mean it, and stripping it would answer a question they did not
 *    ask.
 *  - The score still measures the result against the *series*, not against what
 *    was typed — otherwise every result reads "near-certain" merely for being
 *    what was searched for, which is exactly the confident-and-wrong link the
 *    threshold exists to prevent. AniList's own relevance order is kept for the
 *    same reason: when the right answer is a romanisation the local title does
 *    not resemble, every score is low and sorting by them is noise.
 */
export async function searchMatches(query: string, against: string): Promise<MatchCandidate[]> {
    const id = anilistIdFrom(query)
    if (id !== null) {
        const media = await getAniListMedia(id)
        return media ? [{ media, score: scoreMatch(against, media) }] : []
    }

    const media = await searchAniList(query.trim())
    return dedupe(media).map(item => ({ media: item, score: scoreMatch(against, item) }))
}

/** AniList can return the same media twice across two searches. */
function dedupe(media: AniListMedia[]): AniListMedia[] {
    const seen = new Set<number>()
    return media.filter(item => (seen.has(item.id) ? false : seen.add(item.id) && true))
}
