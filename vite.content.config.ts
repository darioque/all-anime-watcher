import { defineConfig, type Plugin } from "vite"
import vue from "@vitejs/plugin-vue"
import { fileURLToPath, URL } from "node:url"
import { resolve } from "node:path"

const root = fileURLToPath(new URL(".", import.meta.url))

/**
 * Fold the emitted stylesheet into the JS bundle as a runtime <style> injection.
 *
 * Vite's library mode writes CSS to a separate file, which is useless to a
 * content script: nothing loads it, and the player would mount unstyled. There is
 * no HTML document of ours to link it from, so the bundle has to carry it.
 */
function inlineCss(): Plugin {
    return {
        name: "aaw-inline-css",
        apply: "build",
        enforce: "post",
        generateBundle(_options, bundle) {
            const cssFiles = Object.keys(bundle).filter(name => name.endsWith(".css"))
            if (cssFiles.length === 0) return

            let css = ""
            for (const name of cssFiles) {
                const asset = bundle[name]
                if (asset?.type === "asset") {
                    css += typeof asset.source === "string" ? asset.source : Buffer.from(asset.source).toString()
                    delete bundle[name]
                }
            }
            if (css.trim() === "") return

            const entry = Object.values(bundle).find(chunk => chunk.type === "chunk" && chunk.isEntry)
            if (entry?.type !== "chunk") return

            // data-aaw marks it so mount.ts's style stripper leaves it alone.
            const injector = `;(function(){try{var s=document.createElement("style");s.setAttribute("data-aaw","1");s.textContent=${JSON.stringify(
                css
            )};(document.head||document.documentElement).appendChild(s)}catch(e){console.warn("[AAW] style injection failed",e)}})();`
            entry.code = injector + entry.code
        }
    }
}

/**
 * Pass B — the injected content script and player, as a single self-contained IIFE.
 *
 * scripting.executeScript({ files }) runs a classic script: no `import`, no
 * shared chunks, no dynamic import. Everything the player needs — Vue and
 * hls.js — has to be inlined here, stylesheet included.
 *
 * HTML parsing, sources and extractors deliberately stay in the background, so
 * cheerio and every site definition never enter this bundle.
 */
export default defineConfig(({ mode }) => ({
    plugins: [vue(), inlineCss()],
    define: {
        // Vite's app build substitutes this automatically; library mode does not,
        // and Vue's runtime is full of `process.env.NODE_ENV !== "production"`
        // guards. Without the define they reach the page as a bare `process`
        // reference and the bundle throws on its first line.
        "process.env.NODE_ENV": JSON.stringify(mode === "development" ? "development" : "production"),
        __VUE_PROD_DEVTOOLS__: "false",
        __VUE_OPTIONS_API__: "false",
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false"
    },
    resolve: {
        alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) }
    },
    build: {
        outDir: resolve(root, "dist"),
        emptyOutDir: false,
        target: "chrome120",
        sourcemap: true,
        // This bundle is injected into a page on every episode load, so its parse
        // cost is on the user's critical path. Sourcemaps keep it debuggable.
        minify: mode === "development" ? false : "esbuild",
        cssCodeSplit: false,
        lib: {
            entry: resolve(root, "src/content/index.ts"),
            formats: ["iife"],
            name: "AAWContent",
            fileName: () => "content.js"
        }
    }
}))
