import browser from "webextension-polyfill"
import type { Episode, TrackedAnime } from "~/model/types"
import { nextEpisode, titleOf } from "~/model/keys"
import { getAllAnime } from "~/model/db"
import { resolve } from "~/settings/resolver"
import { cachedSettings } from "~/settings/storage"
import { log } from "~/shared/logger"

const logger = log("notify")

/**
 * Clicking a new-episode notification should open that episode, so the URL is
 * held against the notification id until it is clicked or dismissed. Chrome
 * gives no way to attach data to a notification, hence the map.
 */
const pending = new Map<string, string>()
let counter = 0

export function installNotificationListeners() {
    if (!browser.notifications) {
        logger.warn("notifications are unavailable in this browser")
        return
    }

    browser.notifications.onClicked.addListener(id => {
        const url = pending.get(id)
        if (!url) return
        pending.delete(id)
        void browser.tabs.create({ url })
        void browser.notifications.clear(id)
    })

    // Without this the map grows for every notification never clicked.
    browser.notifications.onClosed.addListener(id => pending.delete(id))
}

/**
 * Tell the user about episodes that appeared since the last check.
 *
 * One notification per series, not per episode: a source that publishes a whole
 * season at once should not produce twelve toasts.
 */
export async function notifyNewEpisodes(anime: TrackedAnime, added: Episode[]): Promise<void> {
    // Every early return says why. A notification that silently doesn't appear is
    // untraceable otherwise — the difference between "suppressed on purpose",
    // "the browser refused" and "never called" is invisible from the outside.
    if (added.length === 0) {
        logger.debug(`${anime.key}: nothing new to announce`)
        return
    }
    if (!browser.notifications) {
        logger.warn(`${anime.key}: browser.notifications is unavailable`)
        return
    }

    const wanted = resolve("notifyNewEpisode", { anime, sourceId: anime.sourceId })
    if (!wanted) {
        logger.info(`${anime.key}: suppressed, notifyNewEpisode resolves to false`)
        return
    }
    // An unfollowed series still gets its episode list refreshed; it just
    // shouldn't interrupt anyone.
    if (!anime.follow) {
        logger.info(`${anime.key}: suppressed, series is not followed`)
        return
    }

    const newest = added.reduce((hi, ep) => (ep.number > hi.number ? ep : hi), added[0]!)
    const target = nextEpisode(anime) ?? newest

    const message =
        added.length === 1
            ? `Episode ${formatNumber(newest.number)} is out`
            : `${added.length} new episodes, up to ${formatNumber(newest.number)}`

    const id = `aaw-${counter++}`
    pending.set(id, target.url)

    try {
        const created = await browser.notifications.create(id, {
            type: "basic",
            title: titleOf(anime),
            message,
            contextMessage: anime.sourceId,
            iconUrl: browser.runtime.getURL("assets/icons/icon-128.png")
        })
        // Chrome resolves with the id it actually used. An empty result means it
        // accepted the call and dropped the notification — worth saying out loud,
        // because nothing else distinguishes that from success.
        logger.info(`${anime.key}: notified as "${created || id}" — ${message}`)
    } catch (error) {
        pending.delete(id)
        logger.error(`could not raise a notification for ${anime.key}`, error)
        return
    }

    const timeout = cachedSettings().notificationTimeoutMs
    if (timeout > 0) {
        setTimeout(() => void browser.notifications.clear(id), timeout)
    }
}

/** 13.5 rather than 13.5000001, and 13 rather than 13.0. */
function formatNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)))
}

/**
 * Prove the notification path without waiting for a real release.
 *
 * Deliberately runs `notifyNewEpisodes` against a real library entry with a
 * synthetic episode, rather than calling `notifications.create` directly. A test
 * that exercises a parallel code path can pass while the real one is broken —
 * which is exactly what happened here: the plain test notification worked while
 * new-episode notifications did not, and that told us nothing about why.
 */
export async function testNotification(): Promise<boolean> {
    if (!browser.notifications) {
        logger.warn("browser.notifications is unavailable")
        return false
    }

    const followed = (await getAllAnime()).find(anime => anime.follow)
    if (!followed) {
        logger.info("no followed series, sending a bare notification instead")
        try {
            await browser.notifications.create(`aaw-test-${counter++}`, {
                type: "basic",
                title: "All Anime Watcher",
                message: "Notifications are working.",
                iconUrl: browser.runtime.getURL("assets/icons/icon-128.png")
            })
            return true
        } catch (error) {
            logger.error("test notification failed", error)
            return false
        }
    }

    const latest = followed.episodes.reduce<number>((hi, ep) => Math.max(hi, ep.number), 0)
    const pretend: Episode = {
        number: latest + 1,
        url: followed.episodes[0]?.url ?? followed.url,
        ...(followed.episodes[0]?.variant ? { variant: followed.episodes[0].variant } : {})
    }

    logger.info(`test: running the real notify path for ${followed.key}`)
    await notifyNewEpisodes(followed, [pretend])
    return true
}
