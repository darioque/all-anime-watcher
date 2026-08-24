import browser from "webextension-polyfill"
import { installRouter } from "./router"
import { installNavigationListeners, reloadExtraDomains } from "./navigation"
import { registerPageHandlers } from "./handlers/page"
import { openLibraryTab, registerLibraryHandlers } from "./handlers/library"
import { registerSettingsHandlers } from "./handlers/settings"
import { registerSourceHandlers } from "./handlers/sources"
import { registerPlaybackHandlers } from "./handlers/playback"
import { installRules } from "./dnr"
import { refreshBadge } from "./badge"
import { loadSettings, loadSourceSettings } from "~/settings/storage"
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

    // Referer/Origin rewrites for video CDNs, and any opt-in CSP removal.
    // Dynamic rules persist, so this replaces our own set rather than appending.
    await installRules().catch(error => logger.error("could not install network rules", error))

    logger.info(`ready — ${allSources().length} source(s)`)
    return true
}

// Handlers must be registered before the router listener goes in.
registerPageHandlers()
registerLibraryHandlers()
registerSettingsHandlers()
registerSourceHandlers()
registerPlaybackHandlers()

const ready = initialise().catch(error => {
    logger.error("initialisation failed", error)
    return false
})

installRouter(ready)
installNavigationListeners()

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
