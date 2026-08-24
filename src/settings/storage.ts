import browser from "webextension-polyfill"
import { defaultSettings, type GlobalSettings, type SourceSettings } from "./schema"
import { log } from "~/shared/logger"

const logger = log("settings")

const GLOBAL_KEY = "settings"
const SOURCE_KEY = "sourceSettings"

let cache: GlobalSettings | null = null
let sourceCache: Record<string, SourceSettings> | null = null

/**
 * Settings live in storage.local and are cached in the background for the
 * lifetime of the service worker. Everything reads through here so the resolver
 * never has to await on the hot path more than once per worker start.
 */
export async function loadSettings(): Promise<GlobalSettings> {
    if (cache) return cache
    const stored = (await browser.storage.local.get(GLOBAL_KEY))[GLOBAL_KEY] as Partial<GlobalSettings> | undefined
    // Merge over defaults so a new key added in a later version just appears.
    cache = { ...defaultSettings(), ...(stored ?? {}) }
    return cache
}

export async function loadSourceSettings(): Promise<Record<string, SourceSettings>> {
    if (sourceCache) return sourceCache
    const stored = (await browser.storage.local.get(SOURCE_KEY))[SOURCE_KEY] as
        Record<string, SourceSettings> | undefined
    sourceCache = stored ?? {}
    return sourceCache
}

export function cachedSettings(): GlobalSettings {
    return cache ?? defaultSettings()
}

export function cachedSourceSettings(): Record<string, SourceSettings> {
    return sourceCache ?? {}
}

export async function setSetting<K extends keyof GlobalSettings>(key: K, value: GlobalSettings[K]): Promise<void> {
    const settings = await loadSettings()
    settings[key] = value
    await browser.storage.local.set({ [GLOBAL_KEY]: settings })
    logger.debug(`set ${String(key)} =`, value)
}

export async function patchSettings(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
    const settings = await loadSettings()
    Object.assign(settings, patch)
    await browser.storage.local.set({ [GLOBAL_KEY]: settings })
    return settings
}

export async function setSourceSettings(sourceId: string, patch: SourceSettings): Promise<void> {
    const all = await loadSourceSettings()
    all[sourceId] = { ...(all[sourceId] ?? {}), ...patch }
    await browser.storage.local.set({ [SOURCE_KEY]: all })
    logger.debug(`set source settings for ${sourceId}`, patch)
}

export async function resetSettings(): Promise<GlobalSettings> {
    cache = defaultSettings()
    await browser.storage.local.set({ [GLOBAL_KEY]: cache })
    return cache
}

/** Called when another context writes settings, so the cache doesn't go stale. */
export function invalidateSettingsCache() {
    cache = null
    sourceCache = null
}

browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return
    if (GLOBAL_KEY in changes) cache = null
    if (SOURCE_KEY in changes) sourceCache = null
})
