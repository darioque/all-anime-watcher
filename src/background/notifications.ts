import browser from "webextension-polyfill"
import type { Episode, TrackedAnime } from "~/model/types"
import { nextEpisode, titleOf } from "~/model/keys"
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
    if (added.length === 0) return
    if (!browser.notifications) return

    if (!resolve("notifyNewEpisode", { anime, sourceId: anime.sourceId })) {
        logger.debug(`${anime.key}: notifications are off for this series`)
        return
    }
    // An unfollowed series still gets its episode list refreshed; it just
    // shouldn't interrupt anyone.
    if (!anime.follow) return

    const newest = added.reduce((hi, ep) => (ep.number > hi.number ? ep : hi), added[0]!)
    const target = nextEpisode(anime) ?? newest

    const message =
        added.length === 1
            ? `Episode ${formatNumber(newest.number)} is out`
            : `${added.length} new episodes, up to ${formatNumber(newest.number)}`

    const id = `aaw-${counter++}`
    pending.set(id, target.url)

    try {
        await browser.notifications.create(id, {
            type: "basic",
            title: titleOf(anime),
            message,
            contextMessage: anime.sourceId,
            iconUrl: browser.runtime.getURL("assets/icons/icon-128.png")
        })
        logger.info(`${anime.key}: notified — ${message}`)
    } catch (error) {
        pending.delete(id)
        logger.warn(`could not raise a notification for ${anime.key}`, error)
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
