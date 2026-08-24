import browser from "webextension-polyfill"
import { LIBRARY_CHANGED, type LibraryChanged } from "~/shared/messages"
import { log } from "~/shared/logger"

const logger = log("broadcast")

/**
 * Tell every open extension page that the library moved.
 *
 * Fire-and-forget by design. With no popup or library tab open there is nobody
 * listening and `sendMessage` rejects with "Could not establish connection",
 * which is the normal case rather than an error worth surfacing.
 */
export function libraryChanged(reason: string, key?: string): void {
    const message: LibraryChanged = { action: LIBRARY_CHANGED, reason, ...(key ? { key } : {}) }
    void browser.runtime.sendMessage(message).catch(() => logger.debug(`nobody listening for "${reason}"`))
}
