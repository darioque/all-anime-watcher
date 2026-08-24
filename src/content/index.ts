import { send } from "~/shared/messages"
import type { PageIdentity } from "~/shared/messages"
import { isPlayerMounted, mountPlayer, unmountPlayer } from "~/player/mount"

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

async function identify() {
    const url = location.href
    if (url === lastHandledUrl && isPlayerMounted()) return
    lastHandledUrl = url

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

    let tickSec = 5
    try {
        tickSec = (await send("settings:get", {})).progressTickSec
    } catch {
        // Default is fine; a settings read failure shouldn't block playback.
    }

    mountPlayer(identity, tickSec)
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

window.addEventListener("pagehide", () => unmountPlayer())

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
