import type { FetchCtx, SourceRequestInit } from "~/sources/types"
import { log } from "~/shared/logger"

const logger = log("net")

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * A browser-ish User-Agent is not settable from an extension (Chrome blocks the
 * UA request header), but Accept and Accept-Language are, and several themes
 * behave differently without them.
 */
const BASE_HEADERS: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
}

export class FetchError extends Error {
    constructor(
        message: string,
        readonly url: string,
        readonly status?: number
    ) {
        super(message)
        this.name = "FetchError"
    }
}

export interface FetcherOptions {
    baseUrl: string
    tabId?: number
    /** Sent on every request from this context — a source's Referer, typically. */
    defaultHeaders?: Record<string, string>
}

/**
 * Phase 1 fetcher: a plain background fetch with host permissions, which already
 * bypasses CORS. The escalation ladder from the design (page fetch → DNR header
 * rewrite → offscreen Cloudflare bypass → tab context) plugs in here behind the
 * same interface, so sources never learn which rung served them.
 */
export function createFetchCtx(options: FetcherOptions): FetchCtx {
    const baseUrl = options.baseUrl.replace(/\/+$/, "")

    async function request(url: string, init: SourceRequestInit = {}): Promise<Response> {
        const headers = { ...BASE_HEADERS, ...options.defaultHeaders, ...init.headers }
        const signal = AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS)

        logger.debug(`${init.method ?? "GET"} ${url}`)

        let response: Response
        try {
            response = await fetch(url, {
                method: init.method ?? "GET",
                headers,
                body: init.body,
                cache: init.noCache ? "no-cache" : "default",
                credentials: "include",
                redirect: "follow",
                signal
            })
        } catch (cause) {
            throw new FetchError(`request failed: ${String(cause)}`, url)
        }

        if (!response.ok) {
            throw new FetchError(`HTTP ${response.status}`, url, response.status)
        }
        return response
    }

    return {
        baseUrl,
        tabId: options.tabId,
        async text(url, init) {
            return (await request(url, init)).text()
        },
        async json<T>(url: string, init?: SourceRequestInit) {
            const response = await request(url, {
                ...init,
                headers: { Accept: "application/json", ...init?.headers }
            })
            const body = await response.text()
            try {
                return JSON.parse(body) as T
            } catch {
                throw new FetchError("response was not valid JSON", url, response.status)
            }
        }
    }
}
