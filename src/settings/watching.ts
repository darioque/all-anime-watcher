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
 * Where an on-open mark is recorded: at page-read time, or by the player once it
 * has something on screen.
 *
 * Not a setting, and deliberately not one. Opening an episode page is a tracking
 * signal that arrives *before* anyone knows whether the page has a video behind
 * it — no server has been resolved yet, so "opened an episode" and "opened
 * something watchable" are still the same event. Waiting for a picture is not a
 * preference about that, it is the difference between recording a fact and
 * recording a guess, and nobody wants the guess.
 *
 * So the signal is kept and only its timing moves:
 *
 *  - `never`       opening does not count for this viewer at all.
 *  - `whenPlaying` our player is taking the page over and will say when it has a
 *                  stream or an embed up. Everything that could go wrong follows
 *                  from this on its own — a page with no servers, a page that is
 *                  a countdown, five servers that all resolve to nothing — none
 *                  of them ever attaches anything, so none of them ever marks.
 *                  That is why there are no special cases here.
 *  - `now`         the site's own player is being left alone. Nothing of ours
 *                  attaches to that video, so no later moment is coming and no
 *                  completion threshold can ever be reached; the page read is
 *                  the only signal there will ever be, which is exactly what
 *                  `markWatchedOnEmbed` already decides above.
 *
 * Pure — `npm run check:episodes` covers the table.
 */
export function onOpenMark(settings: {
    /** `marksOnOpen` above: does opening count for this viewer at all? */
    marks: boolean
    /** "Replace the site's player with ours." */
    takeOverPage: boolean
}): "never" | "now" | "whenPlaying" {
    if (!settings.marks) return "never"
    return settings.takeOverPage ? "whenPlaying" : "now"
}
