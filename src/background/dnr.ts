import browser from "webextension-polyfill"
import { allNetRules } from "~/extractors/registry"
import { allSources } from "~/sources/registry"
import { log } from "~/shared/logger"

const logger = log("dnr")

/**
 * Declarative rules for two jobs the extension cannot do any other way.
 *
 * 1. **Referer/Origin rewriting.** Both are forbidden header names — `fetch()`
 *    silently refuses to set them — so a video CDN that checks them can only be
 *    satisfied by a DNR rule. Scoped to `initiatorDomains: [our own id]` so we
 *    never touch a request the user's own browsing made.
 *
 * 2. **CSP removal**, opt-in per source. Only needed where a site's
 *    Content-Security-Policy would block Media Source Extensions in the page we
 *    take over. Most sites send no CSP at all — lmanime sends none — so this is
 *    off unless a source asks, rather than a blanket relaxation.
 */

/** Dynamic rule ids we own. Anything in this range is ours to replace. */
const ID_BASE = 1000

function extensionId(): string {
    // @@extension_id resolves without a _locales tree.
    return browser.i18n.getMessage("@@extension_id")
}

export async function installRules(): Promise<void> {
    const self = extensionId()
    const rules: browser.DeclarativeNetRequest.Rule[] = []
    let id = ID_BASE

    // Pages of our own sources, so a `page`-scoped rule can be narrowed to
    // requests our taken-over player actually makes.
    const sourceDomains = [...new Set(allSources().flatMap(source => source.domains))]

    for (const rule of allNetRules()) {
        const requestHeaders: browser.DeclarativeNetRequest.RuleActionRequestHeadersItemType[] = []

        if (rule.referer) {
            requestHeaders.push({ header: "Referer", operation: "set", value: rule.referer })
        }
        if (rule.origin) {
            requestHeaders.push({ header: "Origin", operation: "set", value: rule.origin })
        }
        for (const header of rule.removeHeaders ?? []) {
            requestHeaders.push({ header, operation: "remove" })
        }
        if (requestHeaders.length === 0) continue

        const appliesTo = rule.appliesTo ?? "extension"
        const initiators =
            appliesTo === "extension" ? [self] : appliesTo === "page" ? sourceDomains : [self, ...sourceDomains]

        rules.push({
            id: id++,
            priority: 1,
            action: { type: "modifyHeaders", requestHeaders },
            condition: {
                ...(initiators.length > 0 ? { initiatorDomains: initiators } : {}),
                ...(rule.urlFilter ? { urlFilter: rule.urlFilter } : {}),
                ...(rule.requestDomains ? { requestDomains: rule.requestDomains } : {}),
                resourceTypes: rule.resourceTypes ?? ["xmlhttprequest", "media", "other"]
            }
        })
    }

    // Opt-in CSP removal, only on the episode pages of sources that ask for it.
    for (const source of allSources()) {
        if (!source.stripCsp) continue
        const regexFilter = episodeUrlRegexFor(source.domains, source.episodeUrl)
        if (!regexFilter) {
            logger.warn(`${source.id}: stripCsp is set but no usable regex could be built`)
            continue
        }
        const supported = await isRegexSupported(regexFilter)
        if (!supported) {
            logger.warn(`${source.id}: DNR rejected the episode-page regex, skipping CSP removal`)
            continue
        }
        rules.push({
            id: id++,
            priority: 1,
            action: {
                type: "modifyHeaders",
                responseHeaders: [
                    { header: "content-security-policy", operation: "remove" },
                    { header: "content-security-policy-report-only", operation: "remove" }
                ]
            },
            condition: { regexFilter, resourceTypes: ["main_frame"] }
        })
        logger.info(`${source.id}: CSP removal armed for ${regexFilter}`)
    }

    const existing = await browser.declarativeNetRequest.getDynamicRules()
    const ours = existing.filter(rule => rule.id >= ID_BASE).map(rule => rule.id)

    await browser.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: ours,
        addRules: rules
    })

    logger.info(`installed ${rules.length} rule(s), replacing ${ours.length}`)
}

/**
 * Compose a whole-URL regex from a source's hosts and its pathname-only
 * `episodeUrl`. DNR uses RE2, so no lookarounds — the source regexes avoid them.
 */
function episodeUrlRegexFor(domains: string[], episodeUrl: RegExp): string | null {
    const path = episodeUrl.source
    if (!path.startsWith("^\\/") && !path.startsWith("^/")) return null

    const hosts = domains.map(d => d.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")
    if (hosts === "") return null

    const tail = path.replace(/^\^\\?\//, "/")
    return `^https?://(www\\.)?(${hosts})${tail}`
}

async function isRegexSupported(regex: string): Promise<boolean> {
    try {
        const result = await browser.declarativeNetRequest.isRegexSupported({ regex })
        if (!result.isSupported) logger.warn(`regex rejected: ${result.reason}`)
        return Boolean(result.isSupported)
    } catch (error) {
        logger.warn("isRegexSupported unavailable, assuming the regex is fine", error)
        return true
    }
}
