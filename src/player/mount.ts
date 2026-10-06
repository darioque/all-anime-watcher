import { createApp, type App } from "vue"
import Player from "./Player.vue"
import type { PageIdentity } from "~/shared/messages"

let app: App | null = null
let host: HTMLElement | null = null

/**
 * Replace the page with the player.
 *
 * Same move as AMR's reader: empty the body, drop the site's stylesheets, and
 * mount into a fresh root. Wiping is not just cosmetic — it stops the site's own
 * player, its ad scripts and its keyboard handlers from fighting ours.
 */
export interface PlayerOptions {
    progressTickSec: number
    seekStepSec: number
    /** Percentage, 0–100. */
    defaultVolume: number
    preferredQuality: string
    autoAdvance: boolean
    skipIntro: "off" | "button" | "auto"
    skipOutro: "off" | "button" | "auto"
    /**
     * Called when the player changes the URL itself, moving to the next episode
     * without a page load. The content script needs to know so it does not try
     * to re-read a page the player has already replaced.
     */
    onAdoptUrl?: (url: string) => void
}

export function mountPlayer(identity: PageIdentity, options: PlayerOptions): void {
    unmountPlayer()

    if (!document.body) {
        document.documentElement.appendChild(document.createElement("body"))
    }

    stripPageStyles()

    document.body.innerHTML = ""
    document.body.style.cssText = "margin:0;padding:0;background:#0c1216;overflow:hidden;"

    // Mobile and zoomed viewports would otherwise inherit the site's meta viewport.
    let viewport = document.querySelector('meta[name="viewport"]')
    if (!viewport) {
        viewport = document.createElement("meta")
        viewport.setAttribute("name", "viewport")
        document.head.appendChild(viewport)
    }
    viewport.setAttribute("content", "width=device-width, initial-scale=1")

    host = document.createElement("div")
    host.id = "aaw-root"
    document.body.appendChild(host)

    app = createApp(Player, { identity, ...options })
    app.mount(host)
}

export function unmountPlayer(): void {
    app?.unmount()
    app = null
    host?.remove()
    host = null
}

export function isPlayerMounted(): boolean {
    return app !== null
}

/**
 * Drop the site's CSS so it cannot reach the player. Themes re-add stylesheets
 * from script after load, so this repeats a few times — the same pragmatic
 * approach AMR settled on after fighting the problem properly and losing.
 */
function stripPageStyles(times = 6): void {
    for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))) {
        link.remove()
    }
    for (const style of Array.from(document.querySelectorAll("style"))) {
        // Vue injects the player's own scoped CSS as a <style>; leave it alone.
        if (style.dataset.aaw === undefined && !style.textContent?.includes("aaw-player")) {
            style.remove()
        }
    }

    if (times > 0) {
        setTimeout(() => stripPageStyles(times - 1), 700)
    }
}
