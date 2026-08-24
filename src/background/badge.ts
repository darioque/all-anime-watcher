import browser from "webextension-polyfill"
import { getAllAnime } from "~/model/db"
import { hasUnwatched, unwatchedCount } from "~/model/keys"
import { log } from "~/shared/logger"

const logger = log("badge")

const ACCENT = "#0b7f8c"
const IDLE = "#5b676d"

/** Series with something unwatched, as shown on the toolbar icon. */
export async function refreshBadge(): Promise<number> {
    try {
        const all = await getAllAnime()
        const count = all.reduce((n, anime) => (hasUnwatched(anime) ? n + 1 : n), 0)
        const episodes = all.reduce((n, anime) => (anime.follow ? n + unwatchedCount(anime) : n), 0)

        await browser.action.setBadgeText({ text: count === 0 ? "" : String(count) })
        await browser.action.setBadgeBackgroundColor({ color: count === 0 ? IDLE : ACCENT })
        await browser.action.setTitle({
            title:
                count === 0
                    ? "All Anime Watcher — nothing new"
                    : `All Anime Watcher — ${episodes} new episode(s) across ${count} series`
        })
        return count
    } catch (error) {
        logger.warn("could not refresh the badge", error)
        return 0
    }
}
