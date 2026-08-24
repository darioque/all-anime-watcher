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

/**
 * Referer rewrites discovered at playback time, rather than declared up front.
 *
 * A static rule needs the CDN's hostname written into the source tree, and the
 * hosts these players hand out rotate — MegaPlay's `cdn.watching.onl` is one
 * name for something that has had several. An extractor that knows the Referer
 * its CDN wants can say so on the stream, and the rule is installed for that
 * host the moment the stream is resolved.
 *
 * Kept in its own id range so `installRules` can rebuild the declared rules
 * without disturbing these, and bounded so a long session cannot accumulate
 * rules for every host it ever touched.
 */
const RUNTIME_ID_BASE = 5000
const MAX_RUNTIME_RULES = 24

/** host → the rule id serving it, in insertion order for eviction. */
const runtimeRules = new Map<string, number>()
let nextRuntimeId = RUNTIME_ID_BASE

export async function ensureRefererRule(url: string, referer: string): Promise<void> {
    let host: string
    try {
        host = new URL(url).hostname
    } catch {
        return
    }
    if (host === "" || runtimeRules.has(host)) return

    // An extractor that declared a rule for this host chose its Referer
    // deliberately. These run at a higher priority and would silently override
    // that choice, so they stay out of the way.
    if (hasDeclaredRule(host)) {
        logger.debug(`${host} already has a declared rule; leaving it alone`)
        return
    }

    const id = nextRuntimeId++
    // Wrap rather than grow without bound; ids are only ever ours.
    if (nextRuntimeId > RUNTIME_ID_BASE + 1000) nextRuntimeId = RUNTIME_ID_BASE

    const evict: number[] = []
    while (runtimeRules.size >= MAX_RUNTIME_RULES) {
        const oldest = runtimeRules.keys().next()
        if (oldest.done) break
        const victim = runtimeRules.get(oldest.value)
        if (victim !== undefined) evict.push(victim)
        runtimeRules.delete(oldest.value)
    }

    try {
        await browser.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [id, ...evict],
            addRules: [
                {
                    id,
                    priority: 2,
                    action: {
                        type: "modifyHeaders",
                        requestHeaders: [{ header: "Referer", operation: "set", value: referer }]
                    },
                    condition: {
                        initiatorDomains: [extensionId()],
                        requestDomains: [host],
                        resourceTypes: ["xmlhttprequest", "media", "other"]
                    }
                }
            ]
        })
        runtimeRules.set(host, id)
        logger.debug(`Referer for ${host} → ${referer}`)
    } catch (error) {
        logger.warn(`could not install a Referer rule for ${host}`, error)
    }
}

/** Does any extractor already declare a header rewrite covering this host? */
function hasDeclaredRule(host: string): boolean {
    return allNetRules().some(rule => {
        const token = rule.urlFilter?.replace(/^\|\|/, "")
        const byFilter = token ? host === token || host.endsWith(`.${token}`) : false
        const byDomain = rule.requestDomains?.some(d => host === d || host.endsWith(`.${d}`)) ?? false
        return byFilter || byDomain
    })
}
