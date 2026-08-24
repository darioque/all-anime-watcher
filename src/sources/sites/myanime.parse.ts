/**
 * Text parsing for myanime.live, kept free of transport so it can be tested.
 *
 * The site is a WordPress blog where each post is an episode, and it names those
 * posts four different ways depending on how nervous it was feeling about
 * copyright that week:
 *
 *   wan-jie-du-zun-ten-thousand-worlds-episode-476-english-sub   title + number
 *   zxjds4ep03eng                                                initials + number
 *   dzznf-tgr3dii-episode-85-english-sub                         initials, spelled out
 *   120873                                                       nothing at all
 *
 * So identity cannot come from any single field. See `myanime.ts` for the order
 * the source tries them in.
 */

/** A WordPress post, reduced to the fields identity is derived from. */
export interface PostLike {
    slug: string
    title: string
    /** Epoch ms. Surfaced as the episode's air date. */
    date: number
}

/** Whatever was handed in, plus the episode number read off it. */
export type Numbered<T> = T & { number: number }

/**
 * Episode number as stated by a post's own title or slug.
 *
 * `episode 12` is tried before `ep12` because "episode" contains "ep", and a
 * bare `ep` pattern run first would match nothing there and then wander off to
 * find a wrong number elsewhere in the string.
 *
 * Returns null rather than 0 for "not stated" — 0 is a legitimate episode number
 * for a prologue.
 */
export function statedNumber(text: string): number | null {
    if (!text) return null

    const spelled = /\bepisodes?[\s._-]*(\d{1,4}(?:\.\d+)?)/i.exec(text)
    if (spelled?.[1]) return Number.parseFloat(spelled[1])

    // "ZXJDS4ep03eng" — no separator anywhere, so `ep` has to bind tightly to
    // the digits or it starts matching the "ep" in unrelated words.
    const abbreviated = /(?:^|[^a-z])ep[\s._-]?(\d{1,4}(?:\.\d+)?)(?![\d.])/i.exec(text)
    if (abbreviated?.[1]) return Number.parseFloat(abbreviated[1])

    return null
}

/**
 * The part of a post's slug that names the series rather than the episode.
 *
 * Returns null when nothing was stripped — a slug with no episode marker in it
 * ("120873") tells us nothing about which series it belongs to, and pretending
 * otherwise would file every untitled post under its own series.
 */
export function seriesSlugOf(slug: string): string | null {
    if (!slug) return null

    /*
     * Everything from the episode marker onward goes, which also takes with it
     * WordPress' own "-2" duplicate-slug suffix — the reason
     * "…-episode-473-english-sub-2" and "…-episode-472-english-sub" still land
     * on the same series.
     *
     * The abbreviated form insists on a digit or separator before "ep" so it
     * cannot fire on the "ep" inside an ordinary word.
     */
    const cut = /^(.*?)[-_]episodes?[\s._-]*\d/i.exec(slug)?.[1] ?? /^(.*?[\d._-])ep[\s._-]?\d/i.exec(slug)?.[1] ?? null

    if (cut === null) return null
    const trimmed = cut.replace(/[-_]+$/, "").toLowerCase()
    // A purely numeric remainder is a post id, not a series name.
    if (trimmed === "" || /^\d+$/.test(trimmed)) return null
    return trimmed
}

/** The same cut applied to a display title, so the series keeps its real name. */
export function seriesTitleOf(title: string): string | null {
    if (!title) return null

    const cut =
        /^(.*?)\s*[-–—|]?\s*\bepisodes?\b/i.exec(title)?.[1] ?? /^(.*?[\d._\-\s])ep[\s._-]?\d/i.exec(title)?.[1] ?? null

    const trimmed = (cut ?? "").replace(/[\s\-–—|:]+$/, "").trim()
    if (trimmed === "" || /^\d+$/.test(trimmed)) return null
    return trimmed
}

/**
 * Words a WordPress `?s=` search would use to find a series' posts.
 *
 * Punctuation is dropped rather than escaped. WordPress runs the query as a
 * `LIKE` against post text, so a title's en dash ("Tunshi Xingkong – Swallowed
 * Star") has to appear verbatim in every post it should match — and it does not,
 * because the posts spell it with a hyphen. Searching the words alone matches
 * every spelling.
 */
export function searchQueryFor(seriesId: string, seriesTitle?: string): string {
    const source = (seriesTitle ?? "").trim() !== "" ? (seriesTitle as string) : seriesId
    return source
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
}

/** `?s=` out of a URL, which is how the site's own "All Episodes" button works. */
export function searchQueryFromUrl(url: string): string | null {
    try {
        const value = new URL(url).searchParams.get("s")
        return value && value.trim() !== "" ? value.trim() : null
    } catch {
        return null
    }
}

/** A WordPress-shaped slug, for turning a search query into a stable id. */
export function slugify(value: string): string {
    return value
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
}

/**
 * Number the posts that say which episode they are, and drop the rest.
 *
 * An earlier version inferred the missing ones from their position between posts
 * that *do* state a number. That only made sense while untitled posts could be
 * attributed to a series at all; they cannot — see `postsForSeries` — so nothing
 * unnumbered ever reaches this now, and inferring would only ever have been
 * guessing at which show it was guessing about.
 */
export function numberPosts<T extends PostLike>(posts: T[]): Numbered<T>[] {
    const numbered: Numbered<T>[] = []

    for (const post of posts) {
        const number = statedNumber(post.title) ?? statedNumber(post.slug)
        if (number === null) continue
        numbered.push({ ...post, number })
    }

    numbered.sort((a, b) => b.number - a.number)
    return numbered
}

/**
 * Do two derived series slugs name the same show?
 *
 * The site renames series mid-run — the same donghua was posted as
 * "wan-jie-du-zun-…" for two hundred episodes and
 * "wan-jie-du-zun-ten-thousand-worlds-…" after that — so an exact comparison
 * loses half the episode list.
 *
 * A prefix relation is the signal, with one exception that matters: the extra
 * words must not name a *season*. "tales-of-demons-and-gods" and
 * "tales-of-demons-and-gods-10th-season" are a prefix apart and are two
 * different series, and merging them would put ten seasons of watch history into
 * one entry.
 */
export function sameSeries(a: string, b: string): boolean {
    if (a === b) return true

    const [shorter, longer] = a.length < b.length ? [a, b] : [b, a]
    if (!longer.startsWith(`${shorter}-`)) return false

    const extra = longer.slice(shorter.length + 1)
    return !SEASON_MARKER.test(extra)
}

/** "10th-season", "season-2", "s3", "part-2", "cour-2", or a bare number. */
const SEASON_MARKER = /(^|-)(\d{1,2}(st|nd|rd|th)?|s\d{1,2}|season|part|cour|final|movie|ova|special)(-|$)/i
