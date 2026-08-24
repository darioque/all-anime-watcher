/**
 * The manifest is authored here so it can be typed, commented, and derived from
 * package.json. `vite.config.ts` emits it to dist/manifest.json at build time.
 */
import pkg from "../package.json" with { type: "json" }

export const manifest = {
    manifest_version: 3,
    name: "All Anime Watcher",
    short_name: "AAW",
    version: pkg.version,
    description: pkg.description,

    icons: {
        "16": "assets/icons/icon-16.png",
        "32": "assets/icons/icon-32.png",
        "48": "assets/icons/icon-48.png",
        "128": "assets/icons/icon-128.png"
    },

    action: {
        default_title: "All Anime Watcher",
        default_popup: "src/ui/popup/index.html"
    },

    background: {
        service_worker: "background.js",
        type: "module"
    },

    // Full library view, opened in a tab. Registered as the options page too, so
    // the browser's own "Extension options" entry lands somewhere useful.
    options_ui: {
        page: "src/ui/library/index.html",
        open_in_tab: true
    },

    permissions: [
        // Reading tab context and injecting the player
        "tabs",
        "scripting",
        "webNavigation",
        // Library and settings storage
        "storage",
        "unlimitedStorage",
        // Update scheduler
        "alarms",
        "notifications",
        // Rewriting Referer/Origin for video CDNs, and stripping page CSP so the
        // in-page player can use Media Source Extensions.
        "declarativeNetRequest",
        "declarativeNetRequestWithHostAccess",
        // Hidden document for Cloudflare challenges and download blob handoff
        "offscreen",
        // Episode downloads
        "downloads",
        // Some sites gate content behind cookies (age gates, language)
        "cookies"
    ],

    host_permissions: ["https://*/*", "http://*/*"],

    // The programmatically-injected player bundle. Listed here so
    // scripting.executeScript can reach it and so the page can load its assets.
    web_accessible_resources: [
        {
            resources: ["content.js", "assets/*"],
            matches: ["<all_urls>"]
        }
    ]
} as const
