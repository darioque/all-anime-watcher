import browser from "webextension-polyfill"
import { installRouter } from "./router"
import { installNavigationListeners, reloadExtraDomains } from "./navigation"
import { registerPageHandlers } from "./handlers/page"
import { openLibraryTab, registerLibraryHandlers } from "./handlers/library"
import { registerSettingsHandlers } from "./handlers/settings"
import { registerSourceHandlers } from "./handlers/sources"
import { registerPlaybackHandlers } from "./handlers/playback"
import { registerTrackerHandlers } from "./handlers/tracker"
import { registerBackupHandlers } from "./handlers/backup"
import { registerDownloadHandlers, resumeInterruptedDownloads } from "./downloads"
import { registerLabHandlers } from "./handlers/lab"
import { installRules } from "./dnr"
import { installScheduler } from "./scheduler"
import { installNotificationListeners } from "./notifications"
import { refreshBadge } from "./badge"
import { cachedSettings, loadSettings, loadSourceSettings, patchSettings } from "~/settings/storage"
import { offeredCategories, unseededCategories } from "~/library/categories"
import { allSources } from "~/sources/registry"
import { ensureSourceState } from "~/library/library"
import { log, setLogLevel } from "~/shared/logger"

const logger = log("background")

/**
 * MV3 service workers are killed and restarted freely, so everything here has to
 * be idempotent and every listener has to be registered synchronously at the top
 * level — a listener added inside an `await` misses the event that woke us up.
 */
async function initialise() {
    const settings = await loadSettings()
    setLogLevel(settings.logLevel)
    await loadSourceSettings()

    for (const source of allSources()) {
        await ensureSourceState(source.id)
    }
    await reloadExtraDomains()
    await refreshBadge()
    await applyToolbarBehaviour(settings.openInTab)

    await repairOfferedCategories()
    await seedNewCategories()

    // Referer/Origin rewrites for video CDNs, and any opt-in CSP removal.
    // Dynamic rules persist, so this replaces our own set rather than appending.
    await installRules().catch(error => logger.error("could not install network rules", error))

    // After the router is reachable: a re-queued job pumps immediately, and the
    // offscreen document it talks to answers on the same channel.
    await resumeInterruptedDownloads().catch(error => logger.error("could not resume downloads", error))

    logger.info(`ready — ${allSources().length} source(s)`)
    return true
}

// Handlers must be registered before the router listener goes in.
registerPageHandlers()
registerLibraryHandlers()
registerSettingsHandlers()
registerSourceHandlers()
registerPlaybackHandlers()
registerTrackerHandlers()
registerBackupHandlers()
registerDownloadHandlers()
registerLabHandlers()

/**
 * Offer built-in shelves added since this profile was set up.
 *
 * Settings are stored as a whole object and merged over the defaults, so a
 * `categories` array written by an earlier version wins outright — a shelf added
 * in a later one would never appear. Seeding by id, and remembering what has
 * been seeded, adds it exactly once and leaves a deleted one deleted.
 */
/**
 * Undo a claim an earlier default made about profiles it had never seen.
 *
 * `seededCategories` used to default to every built-in shelf's id. Settings are
 * stored whole, so the first write of *any* setting persisted that into the
 * profile — it then read as "you have already been offered all of these" about
 * shelves that did not exist when the profile was made, and `seedNewCategories`
 * correctly did nothing, for ever. Changing the default cannot help a profile
 * that already wrote the old one down.
 *
 * The repair says the only thing that is actually known: you have been offered
 * the shelves you have. It runs once, because after it runs, deletions recorded
 * the honest way (`offeredCategories`, on save) have to stand. The cost is that
 * a built-in deleted *before* this runs comes back one time — unavoidable, since
 * the record that would have said otherwise is the corrupt one.
 */
const REOFFER_BUILT_INS = "reoffer-built-ins"

async function repairOfferedCategories(): Promise<void> {
    const settings = cachedSettings()
    if ((settings.migrations ?? []).includes(REOFFER_BUILT_INS)) return

    await patchSettings({
        seededCategories: offeredCategories([], settings.categories ?? []),
        migrations: [...(settings.migrations ?? []), REOFFER_BUILT_INS]
    })
    logger.info("repaired the record of which built-in shelves have been offered")
}

async function seedNewCategories(): Promise<void> {
    const settings = cachedSettings()
    const missing = unseededCategories(settings.categories ?? [], settings.seededCategories ?? [])
    if (missing.length === 0) return

    await patchSettings({
        categories: [...(settings.categories ?? []), ...missing],
        seededCategories: [...(settings.seededCategories ?? []), ...missing.map(category => category.id)]
    })
    logger.info(`added ${missing.length} new built-in shelf/shelves: ${missing.map(c => c.name).join(", ")}`)
}

const ready = initialise().catch(error => {
    logger.error("initialisation failed", error)
    return false
})

installRouter(ready)
installNavigationListeners()
installNotificationListeners()
installScheduler()

/**
 * `openInTab` swaps the toolbar button between popup and full library tab. Chrome
 * only fires action.onClicked when there is no popup, so the popup has to be
 * cleared rather than merely ignored.
 */
async function applyToolbarBehaviour(openInTab: boolean) {
    try {
        await browser.action.setPopup({ popup: openInTab ? "" : "src/ui/popup/index.html" })
    } catch (error) {
        logger.warn("could not switch the toolbar behaviour", error)
    }
}

browser.action.onClicked.addListener(() => {
    // Only reached while openInTab is on — otherwise the popup consumes the click.
    void openLibraryTab()
})

browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !("settings" in changes)) return
    const next = changes.settings?.newValue as { openInTab?: boolean } | undefined
    if (next) void applyToolbarBehaviour(Boolean(next.openInTab))
})

browser.runtime.onInstalled.addListener(details => {
    logger.info(`onInstalled: ${details.reason}`)
})
