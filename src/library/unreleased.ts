import type { Episode } from "~/model/types"
import type { AnimeSource, FetchCtx } from "~/sources/types"
import { log } from "~/shared/logger"

const logger = log("library")

/**
 * Which of these episodes has the site posted without a video behind it yet?
 *
 * Some sites put an episode's page up days before the episode — a countdown
 * where the player goes — and their series list cannot tell it from a release.
 * Only the episode page can, so this opens it. That costs a request, which is
 * why it is asked about as few episodes as possible:
 *
 *  - **Only a source that can answer.** `episodeAvailability` exists only on a
 *    source that declared how its pages say "not yet"; everything else returns
 *    at once with no request made.
 *  - **Only the candidates the caller passes** — the episodes a refresh is
 *    about to announce, not the whole list.
 *  - **Highest number first, stopping at the first one that is out.** A
 *    placeholder is posted *ahead* of the release, so it is always at the top;
 *    once an episode is out, everything below it is too. This is also what
 *    keeps a first look at a series — where every episode counts as new — to a
 *    request or two rather than one per episode.
 *
 * Uncertainty keeps the episode: a page that fails to load ends the walk with
 * it, and everything below it, still listed. Listing a countdown costs a
 * notification the viewer dismisses; dropping a real episode is one they never
 * learn they missed.
 *
 * Pure apart from the fetch it is handed, so `npm run check:pending` drives it
 * with a fake context.
 */
export async function unreleasedEpisodes(
    source: AnimeSource,
    candidates: Episode[],
    ctx: FetchCtx
): Promise<Episode[]> {
    if (!source.episodeAvailability) return []

    const unreleased: Episode[] = []
    for (const episode of [...candidates].sort((a, b) => b.number - a.number)) {
        let html: string
        try {
            html = await ctx.text(episode.url, { noCache: true })
        } catch (error) {
            logger.debug(`${source.id}: could not open E${episode.number} to check it is out — keeping it`, error)
            break
        }

        const availability = source.episodeAvailability(html, episode.url)
        if (!availability.pending) break

        logger.info(`${source.id}: E${episode.number} is posted but not out — ${availability.reason ?? "no player"}`)
        unreleased.push(episode)
    }
    return unreleased
}
