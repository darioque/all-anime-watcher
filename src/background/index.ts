import browser from "webextension-polyfill"
import { installRouter } from "./router"
import { installNavigationListeners, reloadExtraDomains } from "./navigation"
import { registerPageHandlers } from "./handlers/page"
import { registerLibraryHandlers } from "./handlers/library"
import { registerSettingsHandlers } from "./handlers/settings"
import { registerSourceHandlers } from "./handlers/sources"
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

    logger.info(`ready — ${allSources().length} source(s)`)
    return true
}

// Handlers must be registered before the router listener goes in.
registerPageHandlers()
registerLibraryHandlers()
registerSettingsHandlers()
registerSourceHandlers()

const ready = initialise().catch(error => {
    logger.error("initialisation failed", error)
    return false
})

installRouter(ready)
installNavigationListeners()

browser.runtime.onInstalled.addListener(details => {
    logger.info(`onInstalled: ${details.reason}`)
})
