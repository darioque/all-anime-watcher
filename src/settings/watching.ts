/**
 * When opening an episode page is itself the record that it was watched.
 *
 * Pure on purpose: the three inputs are resolved settings, and the interesting
 * part is the second clause, which is easy to get wrong and impossible to see
 * going wrong. Tested by `npm run check:episodes`.
 */
export function marksOnOpen(settings: {
    /** "Opening an episode moves my position to it." */
    markWatchedOnOpen: boolean
    /** "Replace the site's player with ours." */
    takeOverPage: boolean
    /** "Opening an episode counts when the site's own player is embedded." */
    markWatchedOnEmbed: boolean
}): boolean {
    if (settings.markWatchedOnOpen) return true

    /*
     * The page was left to the site's own player. Nothing of ours is attached to
     * the video, so no completion threshold can be crossed and no progress tick
     * will ever arrive — opening the page is the only signal that will ever
     * exist for this episode, which is exactly what markWatchedOnEmbed decides.
     *
     * The player applies the same rule for a stream it can only iframe. This is
     * the case the player never sees, because it was never mounted.
     */
    return !settings.takeOverPage && settings.markWatchedOnEmbed
}

/**
 * Where an on-open mark is recorded, and whether it is recorded at all.
 *
 * Opening an episode page is a tracking signal that arrives *before* anyone
 * knows whether the page has a video behind it, and on a site that posts
 * episodes ahead of the release that gap is the whole bug: the position moves to
 * an episode that does not exist yet, and because the pointer never moves
 * backwards, the real episode is already "watched" by the time it airs.
 *
 * So the signal is kept and its timing is moved. Three answers:
 *
 *  - `never`      there is demonstrably nothing to watch here.
 *  - `whenPlaying` our player is taking the page over and will say when it has a
 *                 stream or an embed on screen. This is the normal answer.
 *  - `now`        no better moment is coming — the site's own player is being
 *                 left alone, so nothing of ours will ever report back.
 *
 * `pending` and `hasServers` are the two things that can be known for free, from
 * markup already in hand, and they are the only ones that can answer `never`
 * without a player: a page with no servers listed, and a page the source
 * recognises as a countdown. Everything else waits for evidence rather than
 * guessing at it.
 *
 * Pure on purpose — `npm run check:episodes` covers the table.
 */
export function onOpenMark(settings: {
    /** `marksOnOpen` above: does opening count for this viewer at all? */
    marks: boolean
    /** "Replace the site's player with ours." */
    takeOverPage: boolean
    /** "Only count it if something actually played." */
    markOnlyWhenPlayable: boolean
    /** The source recognised the page as a countdown or a placeholder. */
    pending: boolean
    /** The page listed at least one video server. */
    hasServers: boolean
}): "never" | "now" | "whenPlaying" {
    if (!settings.marks) return "never"

    /*
     * A recognised placeholder is refused whatever the timing rules say, and
     * before `markOnlyWhenPlayable` is consulted. Turning that setting off means
     * "go back to marking on open", not "mark episodes the source has told me
     * are not out yet" — nobody asking for the first is asking for the second.
     */
    if (settings.pending) return "never"

    if (!settings.markOnlyWhenPlayable) return "now"

    // Nothing listed means nothing to fall through to: the player will walk an
    // empty list and show an error. No evidence is coming, and the answer is no.
    if (!settings.hasServers) return "never"

    return settings.takeOverPage ? "whenPlaying" : "now"
}
