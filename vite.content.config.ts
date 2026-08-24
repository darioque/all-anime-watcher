import { defineConfig } from "vite"
import { fileURLToPath, URL } from "node:url"
import { resolve } from "node:path"

const root = fileURLToPath(new URL(".", import.meta.url))

/**
 * Pass B — the injected content script, as a single self-contained IIFE.
 *
 * scripting.executeScript({ files }) runs a classic script: no `import`, no
 * shared chunks. Keep this bundle small — HTML parsing and all source/extractor
 * logic lives in the background, which talks to this script over messages.
 */
export default defineConfig({
    resolve: {
        alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) }
    },
    build: {
        outDir: resolve(root, "dist"),
        emptyOutDir: false,
        target: "chrome120",
        sourcemap: true,
        minify: false,
        lib: {
            entry: resolve(root, "src/content/index.ts"),
            formats: ["iife"],
            name: "AAWContent",
            fileName: () => "content.js"
        }
    }
})
