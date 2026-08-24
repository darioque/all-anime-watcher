import { send } from "~/shared/messages"
import type { PageIdentity } from "~/shared/messages"

/**
 * A small marker on an episode page the extension is *not* taking over.
 *
 * Two jobs, both of which the player would otherwise have covered: say that this
 * page was recognised, and offer to follow the series. Without it, turning off
 * "replace the site's player" or "add a series when I open an episode" leaves no
 * way at all to add a series from the site — which is where you find them.
 *
 * Lives in a closed shadow root: the sites this attaches to are dense with their
 * own CSS, and a bare div would be restyled, hidden or covered by it.
 */

const HOST_ID = "aaw-page-badge"

export function showPageBadge(identity: PageIdentity): void {
    removePageBadge()

    const info = identity.pageInfo
    if (!info) return

    const host = document.createElement("div")
    host.id = HOST_ID
    host.style.cssText = "position:fixed;inset:auto 16px 16px auto;z-index:2147483646;"
    const shadow = host.attachShadow({ mode: "closed" })

    shadow.innerHTML = `
        <style>
            .card {
                display: flex; align-items: center; gap: 10px;
                font: 500 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
                color: #e3ecef; background: #131c21;
                border: 1px solid #253239; border-left: 3px solid #45cddb;
                border-radius: 6px; padding: 8px 12px;
                box-shadow: 0 8px 24px -8px rgba(0,0,0,.6);
                max-width: 320px;
            }
            .text { min-width: 0; }
            .title {
                font-weight: 600; white-space: nowrap;
                overflow: hidden; text-overflow: ellipsis;
            }
            .sub { color: #8ba3ad; font-size: 11px; }
            button {
                font: inherit; font-size: 11px; font-weight: 600;
                color: #04222a; background: #45cddb;
                border: none; border-radius: 4px; padding: 4px 9px;
                cursor: pointer; white-space: nowrap; flex: 0 0 auto;
            }
            button:disabled { opacity: .6; cursor: default; }
            .close {
                background: none; color: #8ba3ad; padding: 2px 4px;
                font-size: 14px; line-height: 1;
            }
        </style>
        <div class="card">
            <div class="text">
                <div class="title"></div>
                <div class="sub"></div>
            </div>
            <button class="act"></button>
            <button class="close" title="Dismiss">×</button>
        </div>
    `

    const titleEl = shadow.querySelector(".title") as HTMLElement
    const subEl = shadow.querySelector(".sub") as HTMLElement
    const action = shadow.querySelector(".act") as HTMLButtonElement

    titleEl.textContent = info.title
    subEl.textContent = `Episode ${info.number}`

    const tracked = Boolean(identity.key)
    action.textContent = tracked ? "Open library" : "+ Follow"

    action.addEventListener("click", () => {
        if (tracked) {
            void send("tab:openLibrary", {})
            return
        }
        action.disabled = true
        action.textContent = "Adding…"
        void send("library:add", {
            sourceId: identity.sourceId ?? "",
            seriesUrl: info.seriesUrl,
            seriesId: info.seriesId,
            title: info.title
        })
            .then(() => {
                action.textContent = "Following"
                subEl.textContent = `Episode ${info.number} · tracked`
            })
            .catch((error: unknown) => {
                action.disabled = false
                action.textContent = "+ Follow"
                subEl.textContent = error instanceof Error ? error.message : String(error)
            })
    })
    ;(shadow.querySelector(".close") as HTMLElement).addEventListener("click", removePageBadge)

    document.documentElement.appendChild(host)
}

export function removePageBadge(): void {
    document.getElementById(HOST_ID)?.remove()
}
