/**
 * Validate dist/ before the browser gets a chance to reject it.
 *
 * Chrome refuses a whole extension for things a bundler is perfectly happy with
 * — a `default_locale` with no `_locales` subtree, an icon path that does not
 * resolve, a popup that was never emitted. This runs after both build passes and
 * fails the build instead of letting a broken load reach the user.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = resolve(root, "dist")

const errors = []
const warnings = []

function fileExists(relative) {
    const target = resolve(dist, relative)
    return existsSync(target) && statSync(target).isFile()
}

function requireFile(relative, why) {
    if (!fileExists(relative)) errors.push(`${why}: dist/${relative} is missing`)
}

if (!existsSync(resolve(dist, "manifest.json"))) {
    console.error("✗ dist/manifest.json is missing — did the build run?")
    process.exit(1)
}

const manifest = JSON.parse(readFileSync(resolve(dist, "manifest.json"), "utf8"))

// --- MV3 basics
if (manifest.manifest_version !== 3) errors.push(`manifest_version must be 3, got ${manifest.manifest_version}`)
if (!manifest.name) errors.push("name is required")
if (!manifest.version) errors.push("version is required")
if (manifest.short_name && manifest.short_name.length > 12) {
    errors.push(`short_name must be 12 characters or fewer, got "${manifest.short_name}"`)
}

// --- the one that actually bit us
if (manifest.default_locale) {
    const messages = `_locales/${manifest.default_locale}/messages.json`
    if (!fileExists(messages)) {
        errors.push(
            `default_locale is "${manifest.default_locale}" but dist/${messages} is missing — ` +
                `Chrome rejects the whole extension. Either ship the locale file or drop default_locale.`
        )
    }
}
// A __MSG_x__ placeholder anywhere requires default_locale to be set.
const rawManifest = readFileSync(resolve(dist, "manifest.json"), "utf8")
if (rawManifest.includes("__MSG_") && !manifest.default_locale) {
    errors.push("the manifest uses __MSG_ placeholders but sets no default_locale")
}

// --- every referenced path must exist
if (manifest.background?.service_worker) {
    requireFile(manifest.background.service_worker, "background.service_worker")
}
if (manifest.action?.default_popup) {
    requireFile(manifest.action.default_popup, "action.default_popup")
}
if (manifest.options_ui?.page) {
    requireFile(manifest.options_ui.page, "options_ui.page")
}
for (const [size, path] of Object.entries(manifest.icons ?? {})) {
    requireFile(path, `icons["${size}"]`)
}
for (const entry of manifest.content_scripts ?? []) {
    for (const file of entry.js ?? []) requireFile(file, "content_scripts.js")
    for (const file of entry.css ?? []) requireFile(file, "content_scripts.css")
}

// Web-accessible resources may legitimately be globs; check only literal paths.
for (const entry of manifest.web_accessible_resources ?? []) {
    for (const pattern of entry.resources ?? []) {
        if (pattern.includes("*")) continue
        if (!fileExists(pattern)) {
            errors.push(`web_accessible_resources lists dist/${pattern}, which is missing`)
        }
    }
    if (!entry.matches?.length) errors.push("each web_accessible_resources entry needs matches[]")
}

// --- the injected bundle must be a classic script
if (fileExists("content.js")) {
    const content = readFileSync(resolve(dist, "content.js"), "utf8")
    if (/^\s*import\s.+\sfrom\s/m.test(content) || /^\s*export\s/m.test(content)) {
        errors.push(
            "dist/content.js contains import/export statements. scripting.executeScript({ files }) " +
                "loads a classic script and will fail — the content pass must emit a self-contained IIFE."
        )
    }
} else {
    errors.push("dist/content.js is missing — the second build pass did not run")
}

/*
 * `process.env` is a genuine runtime landmine: neither a page nor a service
 * worker has it, so a surviving reference throws on the bundle's first statement.
 * That is exactly how Vue's dev-warning guards took the whole content script
 * down — Vite substitutes process.env.NODE_ENV in an app build but not in
 * library mode.
 *
 * Deliberately narrow. Checks for `require(` and `module.exports` were tried and
 * removed: bundlers emit both inside CommonJS interop shims where `module` is a
 * local parameter, so they fire on healthy builds. A check you learn to ignore is
 * worse than no check.
 */
for (const file of ["content.js", "background.js"]) {
    if (!fileExists(file)) continue
    const code = readFileSync(resolve(dist, file), "utf8")
    if (/\bprocess\s*\.\s*env\b/.test(code)) {
        errors.push(
            `dist/${file} references process.env, which does not exist at runtime — ` +
                "add a `define` for process.env.NODE_ENV in that build's vite config"
        )
    }
}

// --- permissions sanity
const KNOWN = new Set([
    "activeTab", "alarms", "background", "bookmarks", "browsingData", "certificateProvider",
    "clipboardRead", "clipboardWrite", "contentSettings", "contextMenus", "cookies", "debugger",
    "declarativeContent", "declarativeNetRequest", "declarativeNetRequestFeedback",
    "declarativeNetRequestWithHostAccess", "desktopCapture", "documentScan", "downloads",
    "downloads.open", "downloads.ui", "enterprise.deviceAttributes", "enterprise.hardwarePlatform",
    "enterprise.networkingAttributes", "enterprise.platformKeys", "favicon", "fileBrowserHandler",
    "fileSystemProvider", "fontSettings", "gcm", "geolocation", "history", "identity",
    "identity.email", "idle", "loginState", "management", "nativeMessaging",
    "notifications", "offscreen", "pageCapture", "platformKeys", "power", "printerProvider",
    "printing", "printingMetrics", "privacy", "processes", "proxy", "readingList", "scripting",
    "search", "sessions", "sidePanel", "storage", "system.cpu", "system.display", "system.memory",
    "system.storage", "tabCapture", "tabGroups", "tabs", "topSites", "tts", "ttsEngine",
    "unlimitedStorage", "vpnProvider", "wallpaper", "webAuthenticationProxy", "webNavigation",
    "webRequest", "webRequestBlocking", "webRequestAuthProvider"
])
for (const permission of manifest.permissions ?? []) {
    if (!KNOWN.has(permission)) warnings.push(`"${permission}" is not a permission Chrome recognises`)
}

// --- report
for (const warning of warnings) console.warn(`\x1b[33m!\x1b[0m ${warning}`)

if (errors.length > 0) {
    console.error(`\n\x1b[31mdist/ would not load:\x1b[0m`)
    for (const error of errors) console.error(`  ✗ ${error}`)
    console.error("")
    process.exit(1)
}

console.log(`\x1b[32m✓\x1b[0m dist/ looks loadable (${manifest.name} ${manifest.version})`)
