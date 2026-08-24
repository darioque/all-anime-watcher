import { on } from "../router"
import { libraryChanged } from "../broadcast"
import { getAllAnime, getAnime } from "~/model/db"
import { titleOf } from "~/model/keys"
import { enrich, findMatches, linkTo, unlink } from "~/trackers/match"
import { resolve } from "~/settings/resolver"
import { log } from "~/shared/logger"

const logger = log("handler:tracker")

export function registerTrackerHandlers() {
    /** Ranked AniList candidates, so the user can confirm or correct a match. */
    on("tracker:matches", async ({ key }) => {
        const anime = await getAnime(key)
        if (!anime) return []

        const candidates = await findMatches(titleOf(anime))
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
            const wanted =
                resolve("anilistMetadata", { anime, sourceId: anime.sourceId }) ||
                resolve("anilistSchedule", { anime, sourceId: anime.sourceId })
            if (!wanted) continue
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
