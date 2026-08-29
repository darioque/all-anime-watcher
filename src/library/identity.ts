import type { TrackedAnime } from "~/model/types"
import type { SeriesIdentity } from "~/sources/types"
import { pathOf, queryOf } from "~/shared/url"

/**
 * Reconciling the identity a page derives with the one already in the library.
 *
 * `${sourceId}/${seriesId}` is the identity and an exact match is the normal
 * case. It is not the only case: a source that reconstructs its ids — from a
 * post slug, a tag, a breadcrumb — can hand out two different ids for the same
 * series depending on which page you happened to open.
 *
 * myanime.live is the worked example. Its ids come from a post's slug when the
 * slug names an episode, and from the post's tag when it does not:
 *
 *   /2026/08/26/yi-nian-yong-heng-a-will-eternal-episode-173-…  →  slug stem
 *   an untitled post carrying the same tag                      →  "yi-nian-yong-heng"
 *
 * Add the series from the second and open the first and the exact-key lookup
 * reports a followed series as unknown. What follows announces itself as three
 * unrelated complaints: an offer to follow something already followed, a watch
 * position that never moves, and — if adding is on — a duplicate entry. The
 * update loop meanwhile keeps working, because it searches from the stored
 * entry and never asks a page who it is, which is what makes this look like a
 * notification for a series the extension then fails to recognise.
 *
 * The first version of this reconciled the two by prefix, which was the shape of
 * the first case seen and not the shape of the problem. The same site tags a
 * post with the romanised Chinese name and titles it in English:
 *
 *   /2026/08/29/a-record-of-a-mortals-journey-to-immortality-episode-189-…
 *   tagged  /tag/fan-ren-xiu-xian-chuan/
 *
 * Those two strings share nothing, and no rule over the strings alone could ever
 * have joined them. It does not need one — the page states both. So the ids a
 * page names are now all consulted, exactly, and the source's inexact opinion
 * stays where it was: last.
 *
 * Pure on purpose: the rules are the part worth testing, and everything here
 * would otherwise sit next to a database read. See rule 9 in CLAUDE.md.
 */

/** The fields identity is reconciled from. */
export type Followed = Pick<TrackedAnime, "key" | "seriesId" | "url">

/** What a page said about itself. */
export interface DerivedIdentity {
    seriesId: string
    seriesUrl: string
    /** Other ids the same page names for the same series. See `PageInfo.aliases`. */
    aliases?: readonly SeriesIdentity[]
}

/**
 * The already-followed entry a page belongs to, if any.
 *
 * Three opinions, strongest first, each asked about every identity the page
 * names rather than only the one the source picked. Each is allowed to be wrong
 * in the safe direction — finding nothing — and none may guess: attaching a page
 * to the wrong series writes a watch position into someone else's history, which
 * is both invisible and unrecoverable.
 */
export function findFollowed<T extends Followed>(
    entries: readonly T[],
    page: DerivedIdentity,
    sameSeries?: (a: string, b: string) => boolean
): T | undefined {
    /*
     * Every id this page states, the picked one first. Aliases are read off the
     * page, not inferred from it, so they are matched exactly — the whole point
     * of listing them is that an alias can look nothing like the picked id.
     */
    const identities: SeriesIdentity[] = [
        { seriesId: page.seriesId, seriesUrl: page.seriesUrl },
        ...(page.aliases ?? [])
    ]

    for (const identity of identities) {
        if (identity.seriesId === "") continue
        const byId = entries.find(entry => entry.seriesId === identity.seriesId)
        if (byId) return byId
    }

    /*
     * The series URL as a second opinion. Compared by path *and* query, because
     * a source whose grouping page is a search ("/?s=Wan+Jie+Du+Zun") has the
     * same path for every series it carries — comparing paths alone silently
     * matched all of them against each other, and then bailed out on the empty
     * string, which is why this never fired for the source that needed it most.
     *
     * The host is deliberately not compared: a source that has moved domains has
     * entries pointing at the old one, and both URLs still name the same series.
     */
    for (const identity of identities) {
        const wanted = identity.seriesUrl ? seriesLocation(identity.seriesUrl) : ""
        if (wanted === "") continue
        const byUrl = entries.find(entry => seriesLocation(entry.url) === wanted)
        if (byUrl) return byUrl
    }

    /*
     * The source's own opinion, last, because it is the only inexact one. Only a
     * source knows that its ids can be spelled two ways, and only it knows which
     * differences are a rename and which are a different season — a distinction
     * nothing here could make, and getting it wrong merges ten seasons of history
     * into one entry.
     */
    if (!sameSeries) return undefined
    for (const identity of identities) {
        if (identity.seriesId === "") continue
        const found = entries.find(entry => entry.seriesId !== "" && sameSeries(entry.seriesId, identity.seriesId))
        if (found) return found
    }
    return undefined
}

/** Path and query, which together identify a series page whatever the host. */
function seriesLocation(url: string): string {
    const path = pathOf(url).replace(/\/+$/, "").toLowerCase()
    const query = queryOf(url)
    return query === "" ? path : `${path}?${query.toLowerCase()}`
}
