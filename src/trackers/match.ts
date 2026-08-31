import type { SeriesMeta, TrackedAnime } from "~/model/types"
import { titleOf } from "~/model/keys"
import { getAnime, putAnime } from "~/model/db"
import { resolve } from "~/settings/resolver"
import { getAniListMedia, type AniListMedia } from "./anilist"
import { CONFIDENT, findMatches } from "./matching"
import { log } from "~/shared/logger"

export { anilistIdFrom, findMatches, scoreMatch, searchMatches } from "./matching"

const logger = log("tracker")

/**
 * Attach AniList data to a series.
 *
 * Only auto-links on a confident match; anything less is left for the user to
 * confirm. Once `trackerConfirmed` is set, matching never runs again for that
 * series — a correction has to stick.
 */
export async function enrich(key: string, options: { force?: boolean } = {}): Promise<TrackedAnime | null> {
    const anime = await getAnime(key)
    if (!anime) return null

    const wantMetadata = resolve("anilistMetadata", { anime, sourceId: anime.sourceId })
    if (!wantMetadata && !options.force) return anime

    // Already linked: just refresh what changes (episode counts, status).
    if (anime.anilistId) {
        const media = await getAniListMedia(anime.anilistId)
        if (media) applyMedia(anime, media, wantMetadata)
        anime.trackerCheckedAt = Date.now()
        await putAnime(anime)
        return anime
    }

    if (anime.trackerConfirmed && !options.force) return anime

    const candidates = await findMatches(titleOf(anime))
    const best = candidates[0]

    if (!best || best.score < CONFIDENT) {
        // Record the attempt so we don't re-search every cycle for a series that
        // simply isn't on AniList.
        anime.trackerCheckedAt = Date.now()
        await putAnime(anime)
        logger.info(
            `${key}: no confident match (best ${best ? `${best.media.titleRomaji} @ ${best.score.toFixed(2)}` : "none"})`
        )
        return anime
    }

    anime.anilistId = best.media.id
    if (best.media.idMal) anime.malId = best.media.idMal
    applyMedia(anime, best.media, wantMetadata)
    anime.trackerCheckedAt = Date.now()
    await putAnime(anime)

    logger.info(`${key}: linked to AniList ${best.media.id} (${best.score.toFixed(2)})`)
    return anime
}

/** Link explicitly, from the UI. Marks the series as confirmed. */
export async function linkTo(key: string, anilistId: number): Promise<TrackedAnime | null> {
    const anime = await getAnime(key)
    if (!anime) return null

    const media = await getAniListMedia(anilistId)
    if (!media) throw new Error(`AniList has no media ${anilistId}`)

    anime.anilistId = media.id
    if (media.idMal) anime.malId = media.idMal
    anime.trackerConfirmed = true
    applyMedia(anime, media, resolve("anilistMetadata", { anime, sourceId: anime.sourceId }))
    anime.trackerCheckedAt = Date.now()
    await putAnime(anime)
    return anime
}

export async function unlink(key: string): Promise<TrackedAnime | null> {
    const anime = await getAnime(key)
    if (!anime) return null
    delete anime.anilistId
    delete anime.malId
    // Confirmed so auto-matching doesn't immediately re-link what was just undone.
    anime.trackerConfirmed = true
    anime.updatedAt = Date.now()
    await putAnime(anime)
    return anime
}

/**
 * Copy tracker data onto the entry.
 *
 * Metadata never overwrites what the user set or what the source already had —
 * an AniList poster fills a gap, it doesn't replace a working one, and the
 * displayed title stays whatever the site called it unless it's missing.
 */
function applyMedia(anime: TrackedAnime, media: AniListMedia, wantMetadata: boolean) {
    if (wantMetadata) {
        if (!anime.poster && media.coverImage) anime.poster = media.coverImage
        if (!anime.title && (media.titleEnglish || media.titleRomaji)) {
            anime.title = media.titleEnglish ?? media.titleRomaji ?? anime.title
        }
    }

    /*
     * Stored whatever `wantMetadata` says. It is not metadata in the sense that
     * switch controls — that one is about overwriting the *site's* title and
     * poster with AniList's. This is data no site provides at all, and turning
     * it off would silently empty every automatic category.
     */
    const meta: SeriesMeta = {
        ...(media.countryOfOrigin ? { countryOfOrigin: media.countryOfOrigin } : {}),
        ...(media.genres.length > 0 ? { genres: media.genres } : {}),
        ...(media.format ? { format: media.format } : {}),
        ...(media.status ? { status: media.status } : {}),
        ...(media.seasonYear ? { seasonYear: media.seasonYear } : {})
    }
    if (Object.keys(meta).length > 0) anime.meta = meta

    anime.updatedAt = Date.now()
}
