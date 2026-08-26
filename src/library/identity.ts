import type { TrackedAnime } from "~/model/types"
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
 * Pure on purpose: the rules are the part worth testing, and everything here
 * would otherwise sit next to a database read. See rule 9 in CLAUDE.md.
 */

/** The fields identity is reconciled from. */
export type Followed = Pick<TrackedAnime, "key" | "seriesId" | "url">

/** What a page said about itself. */
export interface DerivedIdentity {
    seriesId: string
    seriesUrl: string
}

/**
 * The already-followed entry a page belongs to, if any.
 *
 * Three opinions, strongest first. Each is allowed to be wrong in the safe
 * direction — finding nothing — and none may guess: attaching a page to the
 * wrong series writes a watch position into someone else's history, which is
 * both invisible and unrecoverable.
 */
export function findFollowed<T extends Followed>(
    entries: readonly T[],
    page: DerivedIdentity,
    sameSeries?: (a: string, b: string) => boolean
): T | undefined {
    const byId = entries.find(entry => entry.seriesId === page.seriesId)
    if (byId) return byId

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
    const wanted = seriesLocation(page.seriesUrl)
    if (wanted !== "") {
        const byUrl = entries.find(entry => seriesLocation(entry.url) === wanted)
        if (byUrl) return byUrl
    }

    /*
     * The source's own opinion, last. Only a source knows that its ids can be
     * spelled two ways, and only it knows which differences are a rename and
     * which are a different season — a distinction nothing here could make, and
     * getting it wrong merges ten seasons of history into one entry.
     */
    if (!sameSeries) return undefined
    return entries.find(entry => entry.seriesId !== "" && sameSeries(entry.seriesId, page.seriesId))
}

/** Path and query, which together identify a series page whatever the host. */
function seriesLocation(url: string): string {
    const path = pathOf(url).replace(/\/+$/, "").toLowerCase()
    const query = queryOf(url)
    return query === "" ? path : `${path}?${query.toLowerCase()}`
}
