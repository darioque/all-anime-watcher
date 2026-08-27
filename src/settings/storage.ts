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

/**
 * Merge a patch into one source's settings.
 *
 * `null` deletes a key, so a source can be handed back to the global default
 * rather than being pinned to whatever it happened to say. Without that there is
 * no way back: every override is sticky once written, and "inherit" stops being
 * reachable from the UI.
 */
export async function setSourceSettings(
    sourceId: string,
    patch: { [K in keyof SourceSettings]?: SourceSettings[K] | null }
): Promise<Record<string, SourceSettings>> {
    const all = await loadSourceSettings()
    const merged: SourceSettings = { ...(all[sourceId] ?? {}) }

    for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete merged[key as keyof SourceSettings]
        else Object.assign(merged, { [key]: value })
    }

    all[sourceId] = merged
    sourceCache = all
    await browser.storage.local.set({ [SOURCE_KEY]: all })
    logger.debug(`set source settings for ${sourceId}`, patch)
    return all
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

/**
 * Keep the cache *populated* rather than merely invalidating it.
 *
 * `cachedSettings()` is synchronous — the resolver is on the hot path and cannot
 * await — and it falls back to `defaultSettings()` when the cache is empty. So
 * nulling the cache here did not mean "re-read on next use", it meant "every
 * setting silently reverts to its default until something happens to await
 * loadSettings() again". Turning off `autoAddOnWatch` and watching a series get
 * added anyway is what that looked like from the outside.
 *
 * The change record carries the new value, so the cache can be replaced in the
 * same tick with no window where it is empty.
 */
browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return

    if (GLOBAL_KEY in changes) {
        const next = changes[GLOBAL_KEY]?.newValue as Partial<GlobalSettings> | undefined
        cache = next ? { ...defaultSettings(), ...next } : null
    }
    if (SOURCE_KEY in changes) {
        const next = changes[SOURCE_KEY]?.newValue as Record<string, SourceSettings> | undefined
        sourceCache = next ?? null
    }
})
