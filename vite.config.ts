import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import { fileURLToPath, URL } from "node:url"
import { writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { manifest } from "./src/manifest.config.ts"

const root = fileURLToPath(new URL(".", import.meta.url))
const outDir = resolve(root, "dist")

/**
 * Pass A — extension pages (Vue, HTML entries) and the background service
 * worker. Emitted as ES modules; the service worker is declared `type: module`
 * so shared chunks resolve normally.
 *
 * The content script is NOT built here: scripting.executeScript({ files })
 * loads a classic script and cannot resolve `import`. See vite.content.config.ts.
 */
export default defineConfig({
    resolve: {
        alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) }
    },
    plugins: [
        vue(),
        {
            name: "aaw-manifest",
            apply: "build",
            closeBundle() {
                mkdirSync(outDir, { recursive: true })
                writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2))

                const icons = resolve(root, "src/assets/icons")
                if (existsSync(icons)) {
                    cpSync(icons, resolve(outDir, "assets/icons"), { recursive: true })
                }
            }
        }
    ],
    build: {
        outDir,
        emptyOutDir: true,
        target: "chrome120",
        sourcemap: true,
        minify: false,
        /*
         * No <link rel="modulepreload"> in the emitted HTML.
         *
         * Chrome refuses those inside an extension page — "cross-world extension
         * resource mismatch" — so every one of them is a console warning followed
         * by the module being fetched again normally. They exist to hide network
         * latency, and there is none: these files are on disk.
         */
        modulePreload: false,
        rollupOptions: {
            input: {
                background: resolve(root, "src/background/index.ts"),
                popup: resolve(root, "src/ui/popup/index.html"),
                library: resolve(root, "src/ui/library/index.html"),
                offscreen: resolve(root, "src/offscreen/index.html"),
                lab: resolve(root, "src/ui/lab/index.html")
            },
            output: {
                entryFileNames: "[name].js",
                chunkFileNames: "chunks/[name]-[hash].js",
                assetFileNames: "assets/[name]-[hash][extname]"
            }
        }
    }
})
