import { log } from "~/shared/logger"

const logger = log("offscreen")

/** Where vite writes src/offscreen/index.html. */
const PATH = "src/offscreen/index.html"

/**
 * Make sure the download document exists.
 *
 * Chrome allows exactly one offscreen document per extension, and
 * `createDocument` throws rather than no-ops when one is already open — so the
 * check is not an optimisation. Two callers arriving at once would both see none
 * and both try to create it, hence the shared promise.
 */
let pending: Promise<void> | null = null

export function ensureOffscreen(): Promise<void> {
    pending ??= create().finally(() => {
        pending = null
    })
    return pending
}

async function create(): Promise<void> {
    if (await hasDocument()) return

    await chrome.offscreen.createDocument({
        url: PATH,
        // BLOBS is the accurate one: the whole reason a document is involved is
        // that a service worker has no URL.createObjectURL, and the browser's
        // download manager needs a URL.
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: "Assemble downloaded video segments into a file the browser can save."
    })
    logger.info("offscreen document created")
}

export async function hasDocument(): Promise<boolean> {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] })
    return contexts.length > 0
}

/**
 * Shut it down when nothing needs it.
 *
 * An open offscreen document is a whole renderer process sitting idle, and the
 * blob URLs it holds keep their files on disk. Closed once the queue drains,
 * reopened on the next download.
 */
export async function closeOffscreen(): Promise<void> {
    if (!(await hasDocument())) return
    await chrome.offscreen.closeDocument()
    logger.info("offscreen document closed")
}
