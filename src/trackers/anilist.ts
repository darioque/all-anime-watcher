import { log } from "~/shared/logger"

const logger = log("anilist")

const ENDPOINT = "https://graphql.anilist.co"

/**
 * AniList, read-only.
 *
 * No key and no sign-in needed for search and metadata, which is why this is
 * useful before any OAuth work: posters, canonical titles, episode counts and —
 * the interesting part — `countryOfOrigin`, the one fact no site reports and the
 * only thing that tells a donghua from an anime.
 *
 * Writing progress back needs OAuth and is deliberately not here.
 */

export interface AniListMedia {
    id: number
    idMal?: number
    titleRomaji?: string
    titleEnglish?: string
    titleNative?: string
    synonyms: string[]
    episodes?: number
    status?: string
    format?: string
    seasonYear?: number
    /**
     * "CN" for a donghua, "JP" for anime, "KR" for aeni. The single most useful
     * fact AniList carries for a library that is mostly Chinese: no site says
     * so, and the genres do not distinguish them.
     */
    countryOfOrigin?: string
    genres: string[]
    coverImage?: string
}

const MEDIA_FIELDS = `
    id
    idMal
    title { romaji english native }
    synonyms
    episodes
    status
    format
    seasonYear
    countryOfOrigin
    genres
    coverImage { large }
`

/**
 * AniList allows 90 requests a minute unauthenticated and answers a burst with
 * 429s. Serialising with a small gap keeps a library-wide refresh from tripping
 * it, and costs nothing at the one-series-at-a-time rate everything else uses.
 */
const MIN_GAP_MS = 700
let chain: Promise<unknown> = Promise.resolve()

function queued<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(async () => {
        const result = await work()
        await new Promise(resolve => setTimeout(resolve, MIN_GAP_MS))
        return result
    })
    chain = next.catch(() => undefined)
    return next
}

async function query<T>(document: string, variables: Record<string, unknown>): Promise<T | null> {
    return queued(async () => {
        const response = await fetch(ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ query: document, variables }),
            signal: AbortSignal.timeout(20_000)
        })

        if (response.status === 429) {
            logger.warn("rate limited; skipping this lookup")
            return null
        }
        if (!response.ok) {
            logger.warn(`HTTP ${response.status}`)
            return null
        }

        const body = (await response.json()) as { data?: T; errors?: { message: string }[] }
        if (body.errors?.length) {
            logger.warn(`API error: ${body.errors.map(e => e.message).join("; ")}`)
            return null
        }
        return body.data ?? null
    })
}

function toMedia(raw: RawMedia): AniListMedia {
    return {
        id: raw.id,
        ...(raw.idMal ? { idMal: raw.idMal } : {}),
        ...(raw.title?.romaji ? { titleRomaji: raw.title.romaji } : {}),
        ...(raw.title?.english ? { titleEnglish: raw.title.english } : {}),
        ...(raw.title?.native ? { titleNative: raw.title.native } : {}),
        synonyms: raw.synonyms ?? [],
        ...(raw.episodes ? { episodes: raw.episodes } : {}),
        ...(raw.status ? { status: raw.status } : {}),
        ...(raw.format ? { format: raw.format } : {}),
        ...(raw.seasonYear ? { seasonYear: raw.seasonYear } : {}),
        ...(raw.countryOfOrigin ? { countryOfOrigin: raw.countryOfOrigin } : {}),
        genres: raw.genres ?? [],
        ...(raw.coverImage?.large ? { coverImage: raw.coverImage.large } : {})
    }
}

export async function searchAniList(title: string, limit = 8): Promise<AniListMedia[]> {
    const data = await query<{ Page?: { media?: RawMedia[] } }>(
        `query ($search: String, $perPage: Int) {
            Page(perPage: $perPage) {
                media(search: $search, type: ANIME, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} }
            }
        }`,
        { search: title, perPage: limit }
    )
    return (data?.Page?.media ?? []).map(toMedia)
}

export async function getAniListMedia(id: number): Promise<AniListMedia | null> {
    const data = await query<{ Media?: RawMedia }>(
        `query ($id: Int) { Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} } }`,
        { id }
    )
    return data?.Media ? toMedia(data.Media) : null
}

/** Every title AniList knows a series by, for matching. */
export function titlesOf(media: AniListMedia): string[] {
    return [media.titleRomaji, media.titleEnglish, media.titleNative, ...media.synonyms].filter(
        (value): value is string => Boolean(value)
    )
}

interface RawMedia {
    id: number
    idMal?: number
    title?: { romaji?: string; english?: string; native?: string }
    synonyms?: string[]
    episodes?: number
    status?: string
    format?: string
    seasonYear?: number
    countryOfOrigin?: string
    genres?: string[]
    coverImage?: { large?: string }
}
