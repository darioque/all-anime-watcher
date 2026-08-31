import { on } from "../router"
import { libraryChanged } from "../broadcast"
import { getAllAnime, getAnime } from "~/model/db"
import { titleOf } from "~/model/keys"
import { enrich, findMatches, linkTo, searchMatches, unlink } from "~/trackers/match"
import { resolve } from "~/settings/resolver"
import { log } from "~/shared/logger"

const logger = log("handler:tracker")

export function registerTrackerHandlers() {
    /**
     * Ranked AniList candidates, so the user can confirm or correct a match.
     *
     * With a `query`, it searches for what the user typed instead of for the
     * series' title. That is the whole point of the manual box: the automatic
     * search fails when AniList lists a donghua under a romanisation the site's
     * title does not resemble, and no amount of cleverness on our side finds it —
     * the user knows the name and we do not.
     */
    on("tracker:matches", async ({ key, query }) => {
        const anime = await getAnime(key)
        if (!anime) return []

        const typed = query?.trim() ?? ""
        const candidates = typed === "" ? await findMatches(titleOf(anime)) : await searchMatches(typed, titleOf(anime))
        return candidates.map(({ media, score }) => ({
            id: media.id,
            title: media.titleEnglish ?? media.titleRomaji ?? media.titleNative ?? String(media.id),
            score,
            ...(media.seasonYear ? { year: media.seasonYear } : {}),
            ...(media.format ? { format: media.format } : {}),
            ...(media.episodes ? { episodes: media.episodes } : {}),
            ...(media.coverImage ? { cover: media.coverImage } : {})
        }))
    })

    on("tracker:link", async ({ key, anilistId }) => {
        const anime = await linkTo(key, anilistId)
        libraryChanged("tracker-linked", key)
        return anime
    })

    on("tracker:unlink", async ({ key }) => {
        const anime = await unlink(key)
        libraryChanged("tracker-unlinked", key)
        return anime
    })

    /**
     * Refresh one series, or every series that wants tracker data.
     *
     * Sequential on purpose: AniList rate-limits, and the client already spaces
     * requests out. A library-wide refresh is a background chore, not something
     * anyone waits on.
     */
    on("tracker:refresh", async ({ key }) => {
        if (key) {
            await enrich(key, { force: true })
            libraryChanged("tracker-refreshed", key)
            return 1
        }

        const all = await getAllAnime()
        let done = 0
        for (const anime of all) {
            if (!resolve("anilistMetadata", { anime, sourceId: anime.sourceId })) continue
            try {
                await enrich(anime.key)
                done++
            } catch (error) {
                logger.warn(`${anime.key}: tracker refresh failed`, error)
            }
        }
        logger.info(`tracker refresh touched ${done} series`)
        if (done > 0) libraryChanged("tracker-refreshed")
        return done
    })
}
