import { send } from "~/shared/messages"
import type { PageIdentity } from "~/shared/messages"
import { isPlayerMounted, mountPlayer, unmountPlayer, type PlayerOptions } from "~/player/mount"
import { removePageBadge, showPageBadge } from "./pageBadge"

/**
 * Injected on episode pages only, by the background's navigation matcher.
 *
 * Its two jobs: hand the page's HTML to the background (which owns every parser)
 * and, if this really is a watchable episode, replace the page with our player.
 *
 * Built as a standalone IIFE — scripting.executeScript loads a classic script and
 * cannot resolve `import`.
 */

const MARKER = "__AAW__"
const ROUTE_HOOK = "__AAW_ROUTE_CHANGED__"

interface Globals {
    [MARKER]?: { version: string; url: string }
    [ROUTE_HOOK]?: () => void
}

const globals = globalThis as unknown as Globals

if (globals[MARKER]) {
    globals[ROUTE_HOOK]?.()
} else {
    globals[MARKER] = { version: "0.2.0", url: location.href }
    globals[ROUTE_HOOK] = () => void identify()
    void identify()
}

let lastHandledUrl = ""
/**
 * A run is already under way.
 *
 * Identification is a round trip to the background that reads the episode list,
 * the server list and then resolves a server — a second or two, and every bit of
 * it network. `isPlayerMounted()` only becomes true at the very end of that, so
 * the guard below used to let a route hook arriving *during* the round trip
 * straight through: same URL, no player yet. anikoto fires one, which is why its
 * logs show every `ajax/*` call and every resolved stream exactly twice, and why
 * a player that had just started was replaced by a second one built from the
 * same page.
 */
let identifying = false

/**
 * The player moved to another episode in place.
 *
 * It pushes the new URL so the address bar is honest, which the background sees
 * as a history event and answers by asking us to re-identify. There is nothing
 * to re-identify: the site's markup was replaced by the player long ago, and
 * reading it now would find no episode and tear down a working player. Recording
 * the URL as already handled is what makes that hook a no-op.
 */
function adoptUrl(url: string) {
    lastHandledUrl = url
}

async function identify() {
    const url = location.href
    if (url === lastHandledUrl && (isPlayerMounted() || identifying)) return
    lastHandledUrl = url
    identifying = true
    try {
        await identifyNow()
    } finally {
        identifying = false
    }
}

async function identifyNow() {
    const url = location.href
    await waitForBody()

    // Read the DOM before taking it over — the server list is in the page.
    const html = document.documentElement.outerHTML

    let identity: PageIdentity
    try {
        identity = await send("page:identify", { url, html })
    } catch (error) {
        console.warn("[AAW] identification failed", error)
        return
    }

    if (!identity.isEpisode) {
        console.debug("[AAW] not an episode page, leaving it alone")
        return
    }

    if (identity.error || !identity.pageInfo) {
        toast(`Couldn't read this page: ${identity.error ?? "no episode info"}`, "warn")
        return
    }

    console.debug("[AAW] episode identified", identity.pageInfo, `${identity.servers?.length ?? 0} server(s)`)

    // Defaults keep playback working if the read fails; they are not the source
    // of truth, which is why they mirror settings/schema.ts rather than inventing
    // values.
    let options: PlayerOptions = {
        progressTickSec: 5,
        seekStepSec: 5,
        defaultVolume: 50,
        preferredQuality: "1080p",
        autoAdvance: true,
        skipIntro: "button",
        skipOutro: "button",
        onAdoptUrl: adoptUrl
    }
    let takeOver = true
    try {
        const settings = await send("settings:get", {})
        options = {
            progressTickSec: settings.progressTickSec,
            seekStepSec: settings.seekStepSec,
            defaultVolume: settings.defaultVolume,
            preferredQuality: settings.preferredQuality,
            autoAdvance: settings.autoAdvance,
            skipIntro: settings.skipIntro,
            skipOutro: settings.skipOutro,
            onAdoptUrl: adoptUrl
        }
        takeOver = settings.takeOverPage
    } catch {
        // A settings read failure shouldn't block playback.
    }

    /*
     * "Replace the site's player with ours" off means exactly that: the page is
     * left alone. Tracking has already happened in the background by this point,
     * so all that is left is a marker saying the page was recognised — and, if
     * the series is not followed yet, the only way to follow it from the site.
     */
    if (!takeOver) {
        showPageBadge(identity)
        return
    }

    mountPlayer(identity, options)
}

function waitForBody(timeoutMs = 4000): Promise<void> {
    if (document.body) return Promise.resolve()
    return new Promise(resolve => {
        const started = Date.now()
        const tick = () => {
            if (document.body || Date.now() - started > timeoutMs) return resolve()
            requestAnimationFrame(tick)
        }
        tick()
    })
}

window.addEventListener("pagehide", () => {
    unmountPlayer()
    removePageBadge()
})

/** Shadow root so the site's CSS can't erase the message. */
function toast(message: string, kind: "info" | "warn") {
    const host = document.createElement("div")
    host.style.cssText = "position:fixed;inset:auto 16px 16px auto;z-index:2147483647;"
    const shadow = host.attachShadow({ mode: "closed" })
    const accent = kind === "warn" ? "#e0a34a" : "#45cddb"

    shadow.innerHTML = `
        <style>
            .card {
                display: flex; align-items: center; gap: 10px; max-width: 340px;
                font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
                color: #e3ecef; background: #131c21;
                border: 1px solid #253239; border-left: 3px solid ${accent};
                border-radius: 6px; padding: 10px 14px;
                box-shadow: 0 8px 24px -8px rgba(0,0,0,.6);
            }
            .dot { width: 7px; height: 7px; border-radius: 50%; background: ${accent}; flex: 0 0 auto; }
        </style>
        <div class="card"><span class="dot"></span><span class="txt"></span></div>
    `
    ;(shadow.querySelector(".txt") as HTMLElement).textContent = message

    document.documentElement.appendChild(host)
    setTimeout(() => host.remove(), 6000)
}
