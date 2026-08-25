import browser from "webextension-polyfill"
import type { Envelope, Reply } from "~/shared/messages"
import type { FetchPlan } from "~/downloads/types"
import { ivFor } from "~/downloads/hls"
import { log } from "~/shared/logger"

/**
 * The part of downloading that a service worker cannot do.
 *
 * Two reasons this document exists rather than the background doing the work:
 *
 *  1. `URL.createObjectURL` is not available in a service worker, and
 *     `chrome.downloads.download` needs a URL. A finished file has to become one
 *     somewhere, and only a document can make it.
 *  2. A service worker is killed after thirty seconds of quiet. An episode takes
 *     minutes. This document stays alive for as long as it is open, so the
 *     download survives the worker being torn down and restarted underneath it.
 *
 * Deliberately dumb: everything site-specific — which server, which quality,
 * which headers — has already been decided by the time a plan arrives here. This
 * fetches a list of URLs, in order, and writes them end to end.
 */

const logger = log("offscreen")

/** Enough to saturate a connection; small enough that a stall is not eight stalls. */
const WINDOW = 6
const ATTEMPTS = 3
const SEGMENT_TIMEOUT_MS = 60_000
/** Progress is for a human watching a bar move, not for accounting. */
const PROGRESS_EVERY_MS = 400

interface Running {
    controller: AbortController
    /** Kept so the URL can be revoked and the scratch file removed once saved. */
    objectUrl?: string
    scratch: string
}

const running = new Map<string, Running>()

browser.runtime.onMessage.addListener((message: unknown) => {
    const envelope = message as Partial<Envelope> | undefined
    // Everything else on this channel belongs to the background's router. A
    // listener that answered anything would race it and win about half the time.
    if (!envelope?.action?.startsWith("offscreen:")) return undefined

    if (envelope.action === "offscreen:download") {
        /*
         * Acknowledged now, finished later.
         *
         * A reply held open for the length of an episode is a reply the service
         * worker will not be alive to receive — it is torn down after thirty
         * seconds of quiet, and nothing about an awaited response keeps it up.
         * So the outcome is *sent* when it happens, which wakes the worker, and
         * this returns straight away.
         */
        const plan = envelope.payload as FetchPlan
        void download(plan).then(
            result =>
                browser.runtime
                    .sendMessage({ action: "downloads:assembled", payload: { id: plan.id, ...result } })
                    .catch(() => undefined),
            error =>
                browser.runtime
                    .sendMessage({
                        action: "downloads:failed",
                        payload: { id: plan.id, error: error instanceof Error ? error.message : String(error) }
                    })
                    .catch(() => undefined)
        )
        return handle(async () => ({ started: true as const }))
    }
    if (envelope.action === "offscreen:cancel") {
        const { id } = envelope.payload as { id: string }
        running.get(id)?.controller.abort(new Error("cancelled"))
        return handle(async () => true)
    }
    if (envelope.action === "offscreen:release") {
        const { id } = envelope.payload as { id: string }
        return handle(async () => release(id))
    }
    return undefined
})

/** Match the router's reply contract so `send()` works against this document too. */
async function handle<T>(fn: () => Promise<T>): Promise<Reply<T>> {
    try {
        return { ok: true, data: await fn() }
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
}

async function download(plan: FetchPlan): Promise<{ url: string; bytes: number }> {
    const controller = new AbortController()
    const scratch = `${plan.id}.part`
    running.set(plan.id, { controller, scratch })

    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(scratch, { create: true })
    const writable = await handle.createWritable()

    let bytes = 0
    let done = 0
    let announced = 0

    const announce = (force = false) => {
        if (!force && Date.now() - announced < PROGRESS_EVERY_MS) return
        announced = Date.now()
        void browser.runtime
            .sendMessage({
                action: "downloads:progress",
                payload: { id: plan.id, segmentsDone: done, segmentsTotal: plan.parts.length, bytes }
            })
            // The worker may be asleep and there may be no page open. Progress is
            // cosmetic; losing a tick of it must never fail a download.
            .catch(() => undefined)
    }

    try {
        // The fMP4 initialisation segment carries the moov box. Without it first,
        // the file is a pile of fragments nothing can open.
        if (plan.initUrl) {
            const init = await fetchPart({ url: plan.initUrl, index: -1 }, controller.signal)
            await writable.write(init)
            bytes += init.byteLength
        }

        /*
         * A window of parallel fetches, written strictly in order.
         *
         * Segments must be concatenated in playlist order or the result is
         * unplayable, but fetching them one at a time wastes most of the
         * connection. Fetching a window and writing it in order is the simple
         * shape that gets both, and it bounds memory to WINDOW segments rather
         * than the whole episode.
         */
        for (let start = 0; start < plan.parts.length; start += WINDOW) {
            if (controller.signal.aborted) throw new Error("cancelled")

            const window = plan.parts.slice(start, start + WINDOW)
            const fetched = await Promise.all(window.map(part => fetchPart(part, controller.signal)))

            for (const buffer of fetched) {
                await writable.write(buffer)
                bytes += buffer.byteLength
                done++
            }
            announce()
        }

        await writable.close()
        announce(true)

        const file = await handle.getFile()
        /*
         * `slice` with a content type, rather than `new Blob([file], { type })`:
         * both produce a typed blob, but only this one avoids reading a
         * several-hundred-megabyte file into memory to do it.
         *
         * The type has to be right. Chrome derives a download's extension from
         * the blob's MIME in preference to the filename it was handed, so an
         * untyped blob saves as `.txt` no matter what the name says — which is
         * exactly what the scratch file's `.part` extension produced.
         */
        const url = URL.createObjectURL(file.slice(0, file.size, plan.mime))
        running.set(plan.id, { controller, scratch, objectUrl: url })

        logger.info(`${plan.id}: assembled ${plan.parts.length} segments, ${Math.round(bytes / 1024 / 1024)} MB`)
        return { url, bytes }
    } catch (error) {
        // close() on an aborted writable throws in its own right and would mask
        // the real reason, so the scratch file is abandoned rather than closed.
        await writable.abort().catch(() => undefined)
        await release(plan.id)
        throw error
    }
}

/**
 * One segment, decrypted if the playlist said it was encrypted.
 *
 * Retried, because a CDN dropping one segment out of six hundred is ordinary and
 * failing the whole episode over it is not. `credentials: "include"` and no
 * explicit Referer: the header the CDN wants is forbidden to `fetch()` and comes
 * from a declarativeNetRequest rule the background installed before sending this
 * plan over.
 */
async function fetchPart(
    part: { url: string; keyUrl?: string; iv?: string; index: number },
    signal: AbortSignal
): Promise<ArrayBuffer> {
    let last: unknown

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        if (signal.aborted) throw new Error("cancelled")
        try {
            const response = await fetch(part.url, {
                credentials: "include",
                redirect: "follow",
                signal: AbortSignal.any([signal, AbortSignal.timeout(SEGMENT_TIMEOUT_MS)])
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)

            const buffer = await response.arrayBuffer()
            return part.keyUrl ? await decrypt(buffer, part, signal) : buffer
        } catch (error) {
            if (signal.aborted) throw new Error("cancelled")
            last = error
            if (attempt < ATTEMPTS) await sleep(400 * attempt)
        }
    }

    const detail = last instanceof Error ? last.message : String(last)
    throw new Error(`segment ${part.index} failed after ${ATTEMPTS} tries — ${detail}`)
}

/** Keys repeat across hundreds of segments; fetching each one again would double the requests. */
const keyCache = new Map<string, Promise<CryptoKey>>()

async function decrypt(
    buffer: ArrayBuffer,
    part: { keyUrl?: string; iv?: string; index: number },
    signal: AbortSignal
): Promise<ArrayBuffer> {
    const keyUrl = part.keyUrl!
    let pending = keyCache.get(keyUrl)
    if (!pending) {
        pending = (async () => {
            const response = await fetch(keyUrl, { credentials: "include", signal })
            if (!response.ok) throw new Error(`key ${keyUrl} — HTTP ${response.status}`)
            return crypto.subtle.importKey("raw", await response.arrayBuffer(), "AES-CBC", false, ["decrypt"])
        })()
        keyCache.set(keyUrl, pending)
    }

    // HLS pads every segment individually, which is exactly what AES-CBC decrypt
    // expects — no manual unpadding.
    return crypto.subtle.decrypt({ name: "AES-CBC", iv: ivFor(part) }, await pending, buffer)
}

/** Drop the blob URL and the scratch file. Called once the browser has the file. */
async function release(id: string): Promise<boolean> {
    const job = running.get(id)
    if (!job) return false

    if (job.objectUrl) URL.revokeObjectURL(job.objectUrl)
    try {
        const root = await navigator.storage.getDirectory()
        await root.removeEntry(job.scratch)
    } catch {
        // Already gone, or never created. Either way there is nothing to clean.
    }
    running.delete(id)
    return true
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

logger.info("offscreen document ready")
