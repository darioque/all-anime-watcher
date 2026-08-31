import type { Episode } from "~/model/types"

/**
 * Posts a site made before it had the episode, dropped from a parsed list.
 *
 * A site can publish an episode's page ahead of the video — a countdown where
 * the player goes, a premium early-access window, a placeholder created on a
 * schedule. On the series list such a post is usually indistinguishable from a
 * release, so it is announced as new, the watch position moves onto it, and the
 * real episode never shows as unwatched when it lands.
 *
 * Lives here, apart from any source, because it is arithmetic over numbers and
 * dates and nothing else — no HTML, no transport — so `check:pending` can run it
 * directly. Sources call it from their own list parsing, which is the only place
 * it belongs: a post with no episode behind it is not an episode, and a list
 * method that returns one is wrong for every caller, not just the update loop.
 */

/**
 * The list without the backdated placeholder, if it has one.
 *
 * luciferdonghua.in backdates a post it cannot play yet, far enough that it
 * sorts below episode 1 of its own series. Caught twice on Ancient God
 * Sovereign — E13 dated July 1 against E01-04's July 30, then, once E13 went
 * live and moved to the top with a real date, E14 dated July 1 in its place.
 *
 * Two conditions, and the conjunction is the whole safety of it:
 *
 *  1. **Highest-numbered in the list.** A site posts *ahead* of itself, never
 *     behind, so a placeholder is always at the top of the numbering. This is
 *     what keeps a late re-upload or a corrected date on an older episode — the
 *     ordinary reasons a list goes out of order — from ever being dropped,
 *     whatever date it carries.
 *  2. **Strictly the oldest date in the list.** Not merely out of order: the
 *     oldest, uniquely. The newest episode being the oldest post is not
 *     something a real release does; being somewhat out of order is.
 *
 * At most one entry can satisfy both, which is the conservative direction and
 * matches what the site does — it runs one countdown at a time. A run of two
 * would leave the second listed, which costs a dismissed notification rather
 * than an episode nobody hears about.
 *
 * Everything vague fails open, into keeping the episode: fewer than two dated
 * entries, a list where only some posts carry dates, a tie for oldest. The two
 * mistakes are not symmetrical — announcing a countdown is a notification the
 * viewer dismisses, dropping a real episode is one they never learn they missed.
 */
export function withoutBackdatedPlaceholder(episodes: Episode[]): Episode[] {
    const dated = episodes.filter(episode => episode.airedAt !== undefined)
    // One date is no ordering, and a site that dates only some of its posts says
    // nothing about any of them by putting one last.
    if (dated.length < 2 || dated.length !== episodes.length) return episodes

    const newest = episodes.reduce((a, b) => (b.number > a.number ? b : a))
    const oldestAt = Math.min(...dated.map(episode => episode.airedAt!))

    if (newest.airedAt !== oldestAt) return episodes
    // A tie is two posts sharing the oldest date, which is a site dating in bulk
    // rather than a site parking one post out of the way.
    if (dated.filter(episode => episode.airedAt === oldestAt).length > 1) return episodes

    return episodes.filter(episode => episode !== newest)
}
