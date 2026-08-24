import type { Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext, LoaderStats } from "hls.js"
import { send } from "~/shared/messages"

/**
 * An hls.js loader that fetches through the background service worker instead of
 * from the page.
 *
 * This is not an optimisation, it is the only way some streams play. Video CDNs
 * commonly send no `access-control-allow-origin` a third-party page origin can
 * use, and require a Referer that a page cannot forge — Dailymotion does both.
 * The background has host permissions, so it is exempt from CORS, and a DNR rule
 * supplies the Referer.
 *
 * The cost is a structured-clone copy of every segment across the message
 * boundary. Measured on a 1080p stream that is a few MB/s of copying, which is
 * well within what messaging handles; `fetchVia` on a Stream decides per stream
 * so a CDN that behaves gets the cheaper direct path.
 */
export class BackgroundLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null
    stats: LoaderStats

    private aborted = false
    private responseUrl?: string

    constructor(_config: unknown) {
        this.stats = emptyStats()
    }

    load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
        this.context = context
        this.aborted = false

        const wantsText = context.responseType !== "arraybuffer"
        const started = performance.now()
        this.stats.loading.start = started

        void send("playback:fetch", {
            url: context.url,
            responseType: wantsText ? "text" : "arraybuffer",
            ...(context.rangeStart !== undefined ? { rangeStart: context.rangeStart } : {}),
            ...(context.rangeEnd !== undefined ? { rangeEnd: context.rangeEnd } : {}),
            ...(context.headers ? { headers: context.headers } : {})
        })
            .then(response => {
                if (this.aborted) return

                if (response.error || response.status >= 400) {
                    callbacks.onError(
                        { code: response.status, text: response.error ?? `HTTP ${response.status}` },
                        context,
                        null,
                        this.stats
                    )
                    return
                }

                const payload = wantsText ? (response.text ?? "") : (response.buffer ?? new ArrayBuffer(0))
                const length = typeof payload === "string" ? payload.length : payload.byteLength

                const now = performance.now()
                this.stats.loading.first = now
                this.stats.loading.end = now
                this.stats.loaded = length
                this.stats.total = length
                this.responseUrl = response.url ?? context.url

                callbacks.onSuccess(
                    { url: this.responseUrl, data: payload, code: response.status },
                    this.stats,
                    context,
                    null
                )
            })
            .catch(error => {
                if (this.aborted) return
                callbacks.onError({ code: 0, text: String(error) }, context, null, this.stats)
            })
    }

    abort(): void {
        this.aborted = true
        this.stats.aborted = true
    }

    destroy(): void {
        this.abort()
        this.context = null
    }

    /**
     * hls.js asks for response headers to detect redirects and cache age. The
     * proxy does not forward them, so report nothing rather than lying.
     */
    getResponseHeader(): string | null {
        return null
    }

    getCacheAge(): number | null {
        return null
    }
}

function emptyStats(): LoaderStats {
    const timing = { start: 0, first: 0, end: 0 }
    return {
        aborted: false,
        loaded: 0,
        retry: 0,
        total: 0,
        chunkCount: 0,
        bwEstimate: 0,
        loading: { ...timing },
        parsing: { start: 0, end: 0 },
        buffering: { ...timing }
    }
}
