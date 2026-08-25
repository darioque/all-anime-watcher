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
