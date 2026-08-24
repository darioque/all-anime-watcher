import { send } from "~/shared/messages"
import type { PageIdentity } from "~/shared/messages"

/**
 * Phase 1 content script: identify the page and confirm tracking. The player
 * replaces this toast in phase 2, but the identification handshake stays exactly
 * as it is — the background does all parsing, this script only supplies the DOM.
 *
 * Deliberately dependency-free and tiny: it is injected via
 * scripting.executeScript, which loads a classic script with no module support.
 */

const MARKER = "__AAW__"
const ROUTE_HOOK = "__AAW_ROUTE_CHANGED__"

interface Globals {
    [MARKER]?: { version: string; url: string }
    [ROUTE_HOOK]?: () => void
}

const globals = globalThis as unknown as Globals

if (globals[MARKER]) {
    // Already injected. considerUrl() normally catches this, but a race is
    // possible; re-running identification is the correct response either way.
    globals[ROUTE_HOOK]?.()
} else {
    globals[MARKER] = { version: "0.1.0", url: location.href }
    globals[ROUTE_HOOK] = () => void identify()
    void identify()
}

async function identify() {
    const url = location.href

    // Give a client-rendered player a moment to put its server list in the DOM
    // before we read it. Cheap because we only ever get here on an episode URL.
    await waitForBody()

    let identity: PageIdentity
    try {
        identity = await send("page:identify", { url, html: document.documentElement.outerHTML })
    } catch (error) {
        console.warn("[AAW] identification failed", error)
        return
    }

    if (!identity.isEpisode) {
        console.debug("[AAW] not an episode page")
        return
    }

    if (identity.error) {
        toast(`Couldn't read this page: ${identity.error}`, "warn")
        return
    }

    const info = identity.pageInfo
    if (!info) return

    console.debug("[AAW] episode identified", info)
    toast(`${info.title} — Episode ${info.number}`, identity.key ? "tracked" : "info")
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

/**
 * A shadow root keeps the site's CSS from reaching in — several themes set
 * `div { all: unset }`-grade rules that would otherwise erase this.
 */
function toast(message: string, kind: "tracked" | "info" | "warn") {
    const host = document.createElement("div")
    host.id = "aaw-toast-host"
    host.style.cssText = "position:fixed;inset:auto 16px 16px auto;z-index:2147483647;"
    const shadow = host.attachShadow({ mode: "closed" })

    const accent = kind === "warn" ? "#e0a34a" : kind === "tracked" ? "#45cddb" : "#8e9ba2"
    shadow.innerHTML = `
        <style>
            .card {
                display: flex; align-items: center; gap: 10px;
                font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
                color: #e3ecef; background: #131c21;
                border: 1px solid #253239; border-left: 3px solid ${accent};
                border-radius: 6px; padding: 10px 14px; max-width: 340px;
                box-shadow: 0 8px 24px -8px rgba(0,0,0,.6);
                opacity: 0; transform: translateY(6px);
                transition: opacity .18s ease, transform .18s ease;
            }
            .card.in { opacity: 1; transform: none; }
            .dot { width: 7px; height: 7px; border-radius: 50%; background: ${accent}; flex: 0 0 auto; }
            .txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            @media (prefers-reduced-motion: reduce) { .card { transition: none; } }
        </style>
        <div class="card"><span class="dot"></span><span class="txt"></span></div>
    `

    const card = shadow.querySelector(".card") as HTMLElement
    ;(shadow.querySelector(".txt") as HTMLElement).textContent = message

    document.documentElement.appendChild(host)
    requestAnimationFrame(() => card.classList.add("in"))
    setTimeout(() => {
        card.classList.remove("in")
        setTimeout(() => host.remove(), 250)
    }, 3200)
}
