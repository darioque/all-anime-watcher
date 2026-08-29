import browser from "webextension-polyfill"
import { getAllSourceState } from "~/model/db"
import { matchEpisodeUrl, sourceForUrl } from "~/sources/registry"
import { resolve } from "~/settings/resolver"
import { log } from "~/shared/logger"

const logger = log("nav")

/**
 * Sites that fire a burst of history events on load would otherwise get us
 * injecting several times. AMR uses the same 500ms window.
 */
const HISTORY_DEBOUNCE_MS = 500
const recentTabs = new Set<number>()

/** Runtime-discovered hosts, refreshed when domain resolution promotes one. */
let extraDomains = new Map<string, string[]>()

/**
 * Every host we have ever seen for a source, including ones discovered after a
 * move. DNR rules scoped to "our own pages" need these — a source promoted to a
 * new domain would otherwise stop matching its own header rewrites.
 */
export function knownSourceDomains(): string[] {
    return [...new Set([...extraDomains.values()].flat())]
}

export async function reloadExtraDomains() {
    const states = await getAllSourceState()
    extraDomains = new Map(states.map(s => [s.sourceId, s.knownDomains]))
    logger.debug(`domain overrides loaded for ${extraDomains.size} source(s)`)
}

function debounced(tabId: number): boolean {
    if (recentTabs.has(tabId)) return true
    recentTabs.add(tabId)
    setTimeout(() => recentTabs.delete(tabId), HISTORY_DEBOUNCE_MS)
    return false
}

/**
 * Decide whether a URL is worth injecting into, then inject.
 *
 * Injection is programmatic rather than a declared content script so that we
 * touch only episode pages — the whole point of AMR's design is that browsing
 * the rest of a site costs nothing.
 */
export async function considerUrl(url: string, tabId: number): Promise<void> {
    if (!/^https?:/i.test(url)) return

    const source = sourceForUrl(url, extraDomains)
    if (!source) return

    if (!matchEpisodeUrl(source, url)) {
        logger.debug(`${source.id}: not an episode URL, leaving the page alone — ${url}`)
        return
    }

    if (!resolve("takeOverPage", { sourceId: source.id })) {
        logger.debug(`${source.id}: takeOverPage is off, skipping injection`)
        return
    }

    try {
        // Bail if we are already in this tab. The content script sets the marker,
        // so an SPA route change reuses the existing instance instead of stacking.
        const [already] = await browser.scripting.executeScript({
            target: { tabId },
            func: () => Boolean((globalThis as Record<string, unknown>).__AAW__)
        })

        if (already?.result === true) {
            /*
             * Said apart from the injection line on purpose. Both used to log
             * "injecting", so a site that fires a stray history event produced
             * two identical lines and looked like a double injection — which is
             * how a real duplicate would look too, leaving nothing to tell them
             * apart in the one place anyone goes looking.
             */
            logger.debug(`${source.id}: already injected here, re-identifying — ${url}`)
            await browser.scripting.executeScript({
                target: { tabId },
                func: () => {
                    const hook = (globalThis as Record<string, unknown>).__AAW_ROUTE_CHANGED__
                    if (typeof hook === "function") (hook as () => void)()
                }
            })
            return
        }

        logger.info(`${source.id}: episode page detected, injecting — ${url}`)
        await browser.scripting.executeScript({ target: { tabId }, files: ["content.js"] })
    } catch (error) {
        logger.warn(`injection failed in tab ${tabId}`, error)
    }
}

export function installNavigationListeners() {
    browser.webNavigation.onCommitted.addListener(details => {
        if (details.frameId !== 0) return
        if (details.transitionType === "auto_subframe") return
        debounced(details.tabId)
        void considerUrl(details.url, details.tabId)
    })

    // SPA navigation. The content script's own pushState calls are filtered by
    // the __AAW__ marker check in considerUrl.
    browser.webNavigation.onHistoryStateUpdated.addListener(details => {
        if (details.frameId !== 0) return
        if (details.transitionType === "auto_subframe") return
        if (debounced(details.tabId)) return
        void considerUrl(details.url, details.tabId)
    })

    logger.info("navigation listeners installed")
}
