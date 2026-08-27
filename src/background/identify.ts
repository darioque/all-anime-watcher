import { refreshBadge } from "./badge"
import { libraryChanged } from "./broadcast"
import { getAnime, getAnimeBySource } from "~/model/db"
import { animeKey } from "~/model/keys"
import { addSeries, fetchCtxFor, markWatched } from "~/library/library"
import { matchEpisodeUrl, sourceForUrl } from "~/sources/registry"
import { findFollowed } from "~/library/identity"
import { orderServers } from "~/library/servers"
import type { AnimeSource, PageInfo, Server } from "~/sources/types"
import type { PageIdentity } from "~/shared/messages"
import { resolve } from "~/settings/resolver"
import { marksOnOpen, onOpenMark } from "~/settings/watching"
import { log } from "~/shared/logger"

const logger = log("identify")

/**
 * Read an episode page: which series, which episode, which servers.
 *
 * Two callers with one difference between them. The content script sits *on* the
 * page and is a tracking signal — opening an episode means you are watching it.
 * The prefetcher reads the *next* episode's page while you are still on this
 * one, and must leave the library entirely alone: marking episode 48 watched
 * because the player looked ahead at it would be worse than no prefetch at all.
 */
export async function identifyEpisode(options: {
    source: AnimeSource
    url: string
    html: string
    tabId?: number
    /** False for a look-ahead: parse the page, touch nothing. */
    track: boolean
}): Promise<PageIdentity> {
    const { source, url, html } = options

    if (!source.isEpisodePage(html, url)) {
        logger.debug(`${source.id}: URL matched but the page has no player markup — ${url}`)
        return { sourceId: source.id, isEpisode: false }
    }

    const ctx = await fetchCtxFor(source, options.tabId)

    try {
        const pageInfo = await source.getPageInfo(html, url, ctx)
        const key = animeKey(source.id, pageInfo.seriesId)

        let entry = (await getAnime(key)) ?? (await entryByOtherIdentity(source, pageInfo, key))

        /*
         * `autoAddOnWatch` decides whether an *unknown* series is added. It has
         * never decided whether an already-tracked one keeps its position updated
         * — turning it off means "stop collecting series", not "stop tracking the
         * ones I chose". AMR draws the line in the same place.
         */
        if (options.track && !entry && resolve("autoAddOnWatch", { sourceId: source.id })) {
            entry = await addSeries({
                sourceId: source.id,
                seriesUrl: pageInfo.seriesUrl,
                seriesId: pageInfo.seriesId,
                title: pageInfo.title,
                tabId: options.tabId
            })
            libraryChanged("added", entry.key)
        }

        const where = { anime: entry, sourceId: source.id }

        // Servers come from the HTML we already have, ordered by preference here
        // so the player never has to know about the settings chain.
        //
        // Read *before* the tracking decision below, which needs to know whether
        // this page offers anything at all. It used to run after, which is the
        // shape of the bug: the position moved to the episode and only then did
        // anyone look at what was on the page.
        let servers: Server[] = []
        try {
            const found = await source.getServers(html, url, ctx)
            const preferred = resolve("preferredServers", where)
            const variant = resolve("variantPref", where)
            servers = orderServers(found, preferred, variant)
        } catch (error) {
            logger.warn(`${source.id}: could not read the server list`, error)
        }

        /*
         * Some sites publish the post before the video — a countdown where the
         * player goes. The page is a real episode page with a real server list,
         * so nothing structural catches it; only the source knows the marker.
         * Free to ask: the HTML is already here.
         */
        const availability = source.episodeAvailability?.(html, url)
        const pending = availability?.pending === true
        if (pending) {
            logger.info(`${source.id}: E${pageInfo.number} is not out yet — ${availability?.reason ?? "no player"}`)
        }

        /*
         * Opening the page is a tracking signal in its own right: the player may
         * end up embedding a frame it cannot see inside, and on a freshly added
         * series "watch next" would otherwise point at episode 1.
         *
         * `marksOnOpen` answers whether it counts for this viewer; `onOpenMark`
         * answers when it may be recorded. The second question exists because
         * this point in the code is too early to answer the first honestly — no
         * server has been resolved yet, so "the viewer opened an episode" and
         * "the viewer opened something watchable" are still the same event here.
         * Where our player is taking the page over, the mark is handed to it and
         * lands when there is a picture; where it is not, this is the last
         * moment anything will happen at all and it lands here.
         */
        const marks = marksOnOpen({
            markWatchedOnOpen: resolve("markWatchedOnOpen", where),
            takeOverPage: resolve("takeOverPage", where),
            markWatchedOnEmbed: resolve("markWatchedOnEmbed", where)
        })
        const timing = onOpenMark({
            marks,
            takeOverPage: resolve("takeOverPage", where),
            markOnlyWhenPlayable: resolve("markOnlyWhenPlayable", where),
            pending,
            hasServers: servers.length > 0
        })

        const markedHere = options.track && entry !== undefined && timing === "now"
        if (markedHere && entry) {
            entry = (await markWatched(entry.key, pageInfo.number, pageInfo.variant)) ?? entry
            libraryChanged("position", entry.key)
        } else if (options.track && entry && marks) {
            logger.debug(
                `${source.id}: holding the position at E${pageInfo.number} — ` +
                    (timing === "never" ? "nothing to play here" : "waiting for the player to show something")
            )
        }

        if (options.track && entry) await refreshBadge()

        return {
            sourceId: source.id,
            isEpisode: true,
            pageInfo,
            servers,
            ...(entry ? { key: entry.key } : {}),
            /*
             * Both resolved here so the player never has to know the settings
             * chain, and both sent even when untracked — the viewer can add the
             * series from the player, and they apply from then on.
             *
             * `markOnOpen` matters for the in-place swap specifically: nothing
             * navigates, so nothing re-runs the tracking above, and the player
             * has to do it at the moment it actually switches.
             */
            markOnEmbed: resolve("markWatchedOnEmbed", where),
            markOnOpen: marks && timing !== "never",
            markedOnOpen: markedHere,
            pending,
            ...(availability?.reason ? { pendingReason: availability.reason } : {})
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(`could not read page info for ${url}`, error)
        return { sourceId: source.id, isEpisode: true, error: message }
    }
}

/**
 * The library entry for a series whose id this page derives differently.
 *
 * `${sourceId}/${seriesId}` is the identity, and normally the id a series page
 * yields and the id an episode page yields are the same string. Normally. A
 * source that reads its id out of a tag, a breadcrumb or a post slug can produce
 * one id when the series was added and another when the same series is opened
 * from a different page, and the exact-key lookup then reports a followed series
 * as unknown. What follows is a duplicate library entry, an offer to follow
 * something already followed, and a watch position recorded against the wrong
 * key — none of which announces itself as an identity problem, because the
 * update loop keeps working throughout: it searches from the stored entry and
 * never asks a page who it is.
 *
 * The rules live in `library/identity.ts`, pure; this only feeds them the
 * source's own entries and its opinion.
 */
async function entryByOtherIdentity(source: AnimeSource, pageInfo: PageInfo, expectedKey: string) {
    const entries = await getAnimeBySource(source.id)
    const found = findFollowed(entries, pageInfo, source.sameSeries?.bind(source))
    if (!found) return undefined

    logger.warn(
        `${source.id}: this page derives "${expectedKey}" but ${pageInfo.seriesUrl} is already followed as ` +
            `"${found.key}" — the source gives a series two identities. Using the followed one.`
    )
    return found
}

/** The source that owns a URL, if it is an episode page at all. */
export function episodeSourceFor(url: string): AnimeSource | null {
    const source = sourceForUrl(url)
    if (!source || !matchEpisodeUrl(source, url)) return null
    return source
}
