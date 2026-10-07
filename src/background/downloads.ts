import browser from "webextension-polyfill"
import { on } from "./router"
import { ensureOffscreen, closeOffscreen, hasDocument } from "./offscreen"
import { resolveServerStreams, coverPlaylistHosts, refererOf } from "./streams"
import { DOWNLOADS_CHANGED, send, type DownloadsChanged } from "~/shared/messages"
import type { DownloadJob, DownloadPart, FetchPlan } from "~/downloads/types"
import { fileNameFor } from "~/downloads/naming"
import { chooseTracks, sidecarNames, subtitleFormat, SUBTITLE_MIME } from "~/downloads/subtitles"
import { BASE_HEADERS } from "~/net/fetcher"
import { containerFor, isMasterPlaylist, pickVariant, playlistVariants, readMediaPlaylist } from "~/shared/m3u8"
import { getAnime } from "~/model/db"
import { fetchCtxFor } from "~/library/library"
import { orderServers } from "~/library/servers"
import { sourceById } from "~/sources/registry"
import { resolve } from "~/settings/resolver"
import { titleOf } from "~/model/keys"
import { swapOrigin } from "~/shared/url"
import { log } from "~/shared/logger"
import type { Stream } from "~/extractors/types"
import type { Episode, TrackedAnime } from "~/model/types"

const logger = log("downloads")

const STORAGE_KEY = "downloads"

let jobs: DownloadJob[] = []
let loaded = false
/** Ids currently being worked on in *this* worker, so the pump never double-starts one. */
const active = new Set<string>()

// ------------------------------------------------------------------- state

async function load(): Promise<void> {
    if (loaded) return
    const stored = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as DownloadJob[] | undefined
    jobs = stored ?? []
    loaded = true
}

async function save(): Promise<void> {
    await browser.storage.local.set({ [STORAGE_KEY]: jobs })
    const message: DownloadsChanged = { action: DOWNLOADS_CHANGED, jobs }
    // Nobody may be listening, which is the normal case rather than an error.
    void browser.runtime.sendMessage(message).catch(() => undefined)
}

async function patch(id: string, changes: Partial<DownloadJob>): Promise<void> {
    const job = jobs.find(candidate => candidate.id === id)
    if (!job) return
    Object.assign(job, changes)
    await save()
}

// ------------------------------------------------------------------ handlers

export function registerDownloadHandlers() {
    on("downloads:list", async () => {
        await load()
        return jobs
    })

    on("downloads:add", async ({ key, number, variant }) => {
        await load()

        const already = jobs.find(
            job =>
                job.key === key &&
                job.number === number &&
                job.variant === variant &&
                job.status !== "failed" &&
                job.status !== "cancelled"
        )
        if (already) return null

        const anime = await getAnime(key)
        if (!anime) throw new Error(`not tracking "${key}"`)

        const episode = findEpisode(anime, number, variant)
        if (!episode) throw new Error(`${titleOf(anime)} has no episode ${number}`)

        const job: DownloadJob = {
            id: `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            key,
            sourceId: anime.sourceId,
            title: titleOf(anime),
            number,
            ...(variant ? { variant } : {}),
            episodeUrl: episode.url,
            status: "queued",
            progress: 0,
            segmentsDone: 0,
            segmentsTotal: 0,
            bytes: 0,
            addedAt: Date.now()
        }

        jobs = [job, ...jobs]
        await save()
        void pump()
        return job
    })

    on("downloads:cancel", async ({ id }) => {
        await load()
        const job = jobs.find(candidate => candidate.id === id)
        if (!job) return false

        // Tell the document first: it is the thing actually holding the fetches
        // open, and a job marked cancelled while its segments keep arriving would
        // still finish and save.
        if (await hasDocument()) await send("offscreen:cancel", { id }).catch(() => false)
        await patch(id, { status: "cancelled", finishedAt: Date.now() })
        active.delete(id)
        void pump()
        return true
    })

    on("downloads:retry", async ({ id }) => {
        await load()
        const job = jobs.find(candidate => candidate.id === id)
        if (!job) return null

        Object.assign(job, {
            status: "queued",
            progress: 0,
            segmentsDone: 0,
            segmentsTotal: 0,
            bytes: 0,
            startedAt: undefined,
            finishedAt: undefined,
            error: undefined
        } satisfies Partial<DownloadJob>)
        await save()
        void pump()
        return job
    })

    on("downloads:clearFinished", async () => {
        await load()
        const before = jobs.length
        jobs = jobs.filter(job => job.status !== "done" && job.status !== "failed" && job.status !== "cancelled")
        await save()
        return before - jobs.length
    })

    on("downloads:assembled", async ({ id, url, bytes }) => {
        await onAssembled(id, url, bytes)
        return true
    })

    on("downloads:failed", async ({ id, error }) => {
        await fail(id, error)
        return true
    })

    on("downloads:progress", async ({ id, segmentsDone, segmentsTotal, bytes }) => {
        await load()
        await patch(id, {
            segmentsDone,
            segmentsTotal,
            bytes,
            progress: segmentsTotal > 0 ? segmentsDone / segmentsTotal : 0
        })
        return true
    })
}

/**
 * Put interrupted jobs back in the queue on worker startup.
 *
 * A service worker is killed whenever Chrome feels like it. If the offscreen
 * document survived, it is still fetching and its next progress message revives
 * the job; if it did not, the job would otherwise sit at "downloading" forever,
 * looking active and never finishing. Restarting is safe because the scratch
 * file is rewritten from the beginning.
 */
export async function resumeInterruptedDownloads(): Promise<void> {
    await load()
    if (await hasDocument()) return

    let requeued = 0
    for (const job of jobs) {
        if (job.status === "resolving" || job.status === "downloading" || job.status === "saving") {
            job.status = "queued"
            job.progress = 0
            job.segmentsDone = 0
            requeued++
        }
    }

    if (requeued > 0) {
        logger.info(`re-queued ${requeued} download(s) interrupted by a worker restart`)
        await save()
    }
    void pump()
}

// --------------------------------------------------------------------- pump

/**
 * Start as many queued jobs as the limit allows.
 *
 * `active` counts jobs *handed to the offscreen document*, not promises awaited
 * here — a download outlives this worker, so there is no promise to hold. A job
 * leaves the set when its outcome arrives back as a message, or when the worker
 * restarts and the queue is rebuilt from what is on disk.
 */
async function pump(): Promise<void> {
    await load()
    const limit = Math.max(1, resolve("maxParallelDownloads"))

    for (;;) {
        /*
         * What counts as busy is the union of two answers, because neither alone
         * survives a worker restart: `active` is this worker's in-memory set and
         * is empty after one, while a job's status is durable but only becomes
         * "resolving" an await after startJob is called. Taking both means a
         * restarted worker respects downloads still running in the offscreen
         * document, and this loop cannot start the same job twice.
         */
        const busy = new Set(active)
        for (const job of jobs) {
            if (job.status === "resolving" || job.status === "downloading" || job.status === "saving") busy.add(job.id)
        }
        if (busy.size >= limit) return

        const next = jobs.find(job => job.status === "queued" && !busy.has(job.id))
        if (!next) return

        active.add(next.id)
        void startJob(next.id).catch(error => fail(next.id, error instanceof Error ? error.message : String(error)))
    }
}

/**
 * Close the document once nothing needs it.
 *
 * An open offscreen document is a whole renderer sitting idle, and the blob URLs
 * it holds keep their files on disk until it goes.
 */
async function closeWhenIdle(): Promise<void> {
    await load()
    if (jobs.some(job => job.status !== "done" && job.status !== "failed" && job.status !== "cancelled")) return
    await closeOffscreen().catch(() => undefined)
}

/**
 * Get one job as far as the offscreen document, then stop.
 *
 * Everything up to here needs the database, the settings chain and the source
 * registry, so it has to happen in the worker. Everything after it is minutes of
 * fetching, which must not.
 */
async function startJob(id: string): Promise<void> {
    const job = jobs.find(candidate => candidate.id === id)
    if (!job || job.status !== "queued") return

    await patch(id, { status: "resolving", startedAt: Date.now(), error: undefined })

    const anime = await getAnime(job.key)
    if (!anime) throw new Error("that series is no longer in the library")

    const { plan, detail } = await buildPlan(job, anime)

    // A cancel that landed while the server was being resolved.
    if (currentStatus(id) === "cancelled") return

    await patch(id, {
        status: "downloading",
        filename: plan.filename,
        detail,
        segmentsTotal: plan.parts.length
    })

    await ensureOffscreen()
    await send("offscreen:download", plan)
    logger.info(`${job.title} E${job.number}: ${plan.parts.length} part(s) handed over — ${detail}`)
}

/** Offscreen says the file exists. Hand it to the browser and finish the job. */
async function onAssembled(id: string, url: string, bytes: number): Promise<void> {
    await load()
    const job = jobs.find(candidate => candidate.id === id)
    if (!job) return

    try {
        if (job.status === "cancelled") return

        await patch(id, { status: "saving", bytes })
        await saveToDisk(id, url, job.filename ?? `episode-${job.number}.ts`)
        await saveSubtitles(id)
        await patch(id, { status: "done", progress: 1, finishedAt: Date.now() })
        logger.info(`${job.title} E${job.number} → ${job.filename}`)
    } catch (error) {
        await fail(id, error instanceof Error ? error.message : String(error))
    } finally {
        active.delete(id)
        await dropSubtitles(id)
        await send("offscreen:release", { id }).catch(() => false)
        void pump()
        void closeWhenIdle()
    }
}

async function fail(id: string, message: string): Promise<void> {
    await load()
    active.delete(id)

    if (currentStatus(id) === "cancelled" || /cancelled|aborted/i.test(message)) {
        await patch(id, { status: "cancelled", finishedAt: Date.now() })
    } else {
        const job = jobs.find(candidate => candidate.id === id)
        await patch(id, { status: "failed", error: message, finishedAt: Date.now() })
        logger.warn(`${job?.title} E${job?.number} failed — ${message}`)
    }
    await dropSubtitles(id)

    await send("offscreen:release", { id }).catch(() => false)
    void pump()
    void closeWhenIdle()
}

function currentStatus(id: string): DownloadJob["status"] | undefined {
    return jobs.find(job => job.id === id)?.status
}

// -------------------------------------------------------------------- planning

/**
 * Everything site-specific, done once and up front.
 *
 * The offscreen document is handed a flat list of URLs precisely because it has
 * to keep running while the worker is torn down and restarted — anything that
 * needs settings, sources or the database has to be resolved before it starts.
 */
async function buildPlan(job: DownloadJob, anime: TrackedAnime): Promise<{ plan: FetchPlan; detail: string }> {
    const source = sourceById(job.sourceId)
    if (!source) throw new Error(`unknown source "${job.sourceId}"`)

    const ctx = await fetchCtxFor(source)
    const episodeUrl = swapOrigin(job.episodeUrl, ctx.baseUrl)

    const html = await ctx.text(episodeUrl)
    const servers = await source.getServers(html, episodeUrl, ctx)
    if (servers.length === 0) throw new Error("that episode page lists no video servers")

    const ordered = orderServers(
        servers,
        resolve("preferredServers", { anime, sourceId: job.sourceId }),
        resolve("variantPref", { anime, sourceId: job.sourceId })
    )

    const refused: string[] = []

    for (const server of ordered) {
        let stream: Stream | undefined
        try {
            const resolved = await resolveServerStreams({ sourceId: job.sourceId, server, episodeUrl })
            // An `iframe` stream is the host's own player, not a file. It is a
            // perfectly good fallback for watching and no use at all here.
            stream = resolved.streams.find(candidate => candidate.kind === "hls" || candidate.kind === "mp4")
            if (!stream) {
                refused.push(`${server.name}: nothing downloadable, only the host's own player`)
                continue
            }
        } catch (error) {
            refused.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`)
            continue
        }

        try {
            const planned = await planFromStream(job, anime, stream, server.name)
            const saved = await stashSubtitles(job, anime, stream, planned.plan.filename)
            if (saved > 0) planned.detail += ` · ${saved} subtitle${saved === 1 ? "" : "s"}`
            return planned
        } catch (error) {
            refused.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    throw new Error(`no server could be downloaded — ${refused.join("; ")}`)
}

async function planFromStream(
    job: DownloadJob,
    anime: TrackedAnime,
    stream: Stream,
    serverName: string
): Promise<{ plan: FetchPlan; detail: string }> {
    const wanted = resolve("downloadQuality", { anime, sourceId: job.sourceId })
    const preference =
        wanted === "same-as-playback" ? resolve("preferredQuality", { anime, sourceId: job.sourceId }) : wanted

    if (stream.kind === "mp4") {
        return {
            plan: {
                id: job.id,
                filename: nameFor(job, anime, "mp4", stream.quality),
                mime: MIME.mp4,
                parts: [{ url: stream.url, index: 0 }]
            },
            detail: `${serverName} · direct file`
        }
    }

    // --- HLS
    let playlistUrl = stream.url
    let text = await fetchText(playlistUrl)
    let chosen: string | undefined = stream.quality

    if (isMasterPlaylist(text)) {
        const variants = playlistVariants(text)
        const variant = pickVariant(variants, preference)
        if (!variant) throw new Error("the master playlist offered no renditions")

        playlistUrl = new URL(variant.url, playlistUrl).toString()
        chosen = variant.height ? `${variant.height}p` : (variant.name ?? chosen)

        // The variant commonly lives on a different host from the master, and
        // segments on a third. The rules for those are installed against the
        // manifest's own Referer.
        const referer = refererOf(stream)
        if (referer) await coverPlaylistHosts(playlistUrl, referer)

        text = await fetchText(playlistUrl)
    }

    const playlist = readMediaPlaylist(text)
    if (playlist.segments.length === 0) throw new Error("that playlist lists no segments")
    if (playlist.encryption === "unsupported") {
        // Writing the segments out unchanged would produce a file that looks
        // complete, reports success and plays as noise.
        throw new Error(`${playlist.encryptionMethod} encryption cannot be decrypted here`)
    }

    const parts: DownloadPart[] = playlist.segments.map(segment => ({
        url: new URL(segment.url, playlistUrl).toString(),
        index: segment.index,
        ...(segment.key?.uri ? { keyUrl: new URL(segment.key.uri, playlistUrl).toString() } : {}),
        ...(segment.key?.iv ? { iv: segment.key.iv } : {})
    }))

    const container = containerFor(playlist)

    return {
        plan: {
            id: job.id,
            filename: nameFor(job, anime, container, chosen),
            mime: MIME[container],
            ...(playlist.initUrl ? { initUrl: new URL(playlist.initUrl, playlistUrl).toString() } : {}),
            parts
        },
        detail:
            `${serverName}${chosen ? ` · ${chosen}` : ""} · ${parts.length} segments` +
            (container === "ts" ? " · transport stream" : "") +
            (playlist.encryption === "aes-128" ? " · encrypted" : "")
    }
}

/**
 * Extension → content type, which Chrome trusts over the filename when deciding
 * what to call a download. `video/mp2t` is the registered type for the transport
 * stream that HLS segments actually are.
 */
const MIME = { ts: "video/mp2t", mp4: "video/mp4" } as const

function nameFor(job: DownloadJob, anime: TrackedAnime, ext: string, quality?: string): string {
    return fileNameFor(resolve("downloadFilenameTemplate", { anime, sourceId: job.sourceId }), {
        title: job.title,
        number: job.number,
        ext,
        source: job.sourceId,
        ...(job.variant ? { variant: job.variant } : {}),
        ...(quality ? { quality } : {})
    })
}

/** Playlists come through the background: it has host permissions and the DNR rules. */
async function fetchText(url: string): Promise<string> {
    const response = await fetch(url, {
        credentials: "include",
        redirect: "follow",
        signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw new Error(`playlist ${new URL(url).hostname} — HTTP ${response.status}`)
    return response.text()
}

// ---------------------------------------------------------------- saving

// ------------------------------------------------------------- subtitles

interface Sidecar {
    filename: string
    mime: string
    text: string
}

const subtitleKey = (jobId: string) => `download-subtitles:${jobId}`

/**
 * Fetch the stream's subtitle tracks now, while the URLs are fresh.
 *
 * Not at save time: an episode takes minutes to pull, and hosts sign subtitle
 * URLs with the same short-lived tokens as the segments. The text goes to
 * session storage rather than onto the job, because the job list is broadcast
 * on every progress tick and the worker may restart before the video is done.
 *
 * Returns how many were kept. A track that will not fetch is logged and left
 * out; a missing subtitle never fails a download.
 */
async function stashSubtitles(
    job: DownloadJob,
    anime: TrackedAnime,
    stream: Stream,
    videoFilename: string
): Promise<number> {
    const tracks = chooseTracks(
        stream.subtitles ?? [],
        resolve("downloadSubtitles", { anime, sourceId: job.sourceId }),
        resolve("subtitleLanguages", { anime, sourceId: job.sourceId })
    )
    if (tracks.length === 0) return 0

    const fetched = await Promise.all(
        tracks.map(async track => {
            try {
                const response = await fetch(track.url, {
                    headers: { ...BASE_HEADERS, ...stream.headers },
                    credentials: "include",
                    redirect: "follow",
                    signal: AbortSignal.timeout(30_000)
                })
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                const body = await response.text()
                const text = track.jsonField ? unwrapJson(body, track.jsonField) : body
                if (!text?.trim()) throw new Error("empty")
                return { track, text, format: subtitleFormat(text) }
            } catch (error) {
                logger.warn(
                    `${job.title} E${job.number}: subtitle "${track.label}" — ${error instanceof Error ? error.message : String(error)}`
                )
                return null
            }
        })
    )

    const ok = fetched.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    if (ok.length === 0) return 0

    const names = sidecarNames(videoFilename, ok)
    const sidecars: Sidecar[] = ok.map((entry, index) => ({
        filename: names[index]!,
        mime: SUBTITLE_MIME[entry.format],
        text: entry.text
    }))
    await chrome.storage.session.set({ [subtitleKey(job.id)]: sidecars })
    return sidecars.length
}

/** Write the stashed sidecars beside the finished video. */
async function saveSubtitles(jobId: string): Promise<void> {
    const key = subtitleKey(jobId)
    const sidecars = ((await chrome.storage.session.get(key))[key] as Sidecar[] | undefined) ?? []

    for (const sidecar of sidecars) {
        let url: string | undefined
        try {
            await ensureOffscreen()
            url = await send("offscreen:textUrl", { text: sidecar.text, mime: sidecar.mime })
            await saveToDisk(jobId, url, sidecar.filename)
        } catch (error) {
            logger.warn(`${sidecar.filename} — ${error instanceof Error ? error.message : String(error)}`)
        } finally {
            if (url) await send("offscreen:revoke", { url }).catch(() => false)
        }
    }
}

async function dropSubtitles(jobId: string): Promise<void> {
    await chrome.storage.session.remove(subtitleKey(jobId)).catch(() => undefined)
}

/** The string under `field` in a JSON envelope — donghualife's `{ "content": … }`. */
function unwrapJson(text: string, field: string): string | null {
    try {
        const value = (JSON.parse(text) as Record<string, unknown>)[field]
        return typeof value === "string" ? value : null
    } catch {
        return null
    }
}

/** Resolvers waiting on `downloads.onChanged`, keyed by the browser's download id. */
const saving = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()

chrome.downloads?.onChanged.addListener(delta => {
    const waiter = saving.get(delta.id)
    if (!waiter) return

    if (delta.state?.current === "complete") {
        saving.delete(delta.id)
        waiter.resolve()
    } else if (delta.state?.current === "interrupted") {
        saving.delete(delta.id)
        waiter.reject(new Error(delta.error?.current ?? "the browser interrupted the download"))
    }
})

/**
 * Filenames for our own downloads still waiting on the browser to name them,
 * keyed by the object URL — the naming event can arrive before
 * `downloads.download` has even resolved with an id.
 *
 * `filename` on `downloads.download` alone is not enough. While any other
 * extension listens to `onDeterminingFilename`, Chrome can throw the creator's
 * name away and fall back to the blob URL's last segment: every episode saved
 * as a bare UUID with no extension. XDM's integration is the usual culprit — it
 * listens permanently and returns without suggesting for anything that is not
 * http(s), which Chrome counts as suggesting "". A suggestion made *through* the
 * event is honoured, and between extensions the most recently installed wins;
 * the losing one gets a "failed to name the download" warning on its card,
 * which is expected.
 *
 * The listener is only attached while one of ours is pending, so the browser
 * does not wake this worker for every unrelated download.
 */
const naming = new Map<string, string>()

function suggestOurName(
    item: chrome.downloads.DownloadItem,
    suggest: (suggestion?: chrome.downloads.FilenameSuggestion) => void
): void {
    const filename = naming.get(item.url) ?? naming.get(item.finalUrl)
    // Not ours: answering nothing leaves the decision to everyone else.
    if (!filename) return
    suggest({ filename, conflictAction: "uniquify" })
    forgetName(item.url)
    forgetName(item.finalUrl)
}

function forgetName(url: string): void {
    naming.delete(url)
    if (naming.size === 0) chrome.downloads.onDeterminingFilename?.removeListener(suggestOurName)
}

/**
 * Hand the assembled file to the browser's own download manager.
 *
 * `uniquify` rather than `overwrite`: re-downloading an episode you already have
 * should never silently destroy the copy on disk, and the extension has no way
 * to know whether the existing file is the same encode.
 */
async function saveToDisk(jobId: string, objectUrl: string, filename: string): Promise<void> {
    naming.set(objectUrl, filename)
    chrome.downloads.onDeterminingFilename?.addListener(suggestOurName)

    let downloadId: number
    try {
        downloadId = await chrome.downloads.download({
            url: objectUrl,
            filename,
            conflictAction: "uniquify",
            saveAs: false
        })
    } catch (error) {
        forgetName(objectUrl)
        throw error
    }

    await new Promise<void>((resolveWait, reject) => {
        saving.set(downloadId, { resolve: resolveWait, reject })
        // A download that never reports back must not hold the queue slot for
        // ever; the file is usually on disk by then regardless.
        setTimeout(
            () => {
                if (!saving.has(downloadId)) return
                saving.delete(downloadId)
                logger.warn(`${jobId}: the browser never reported the download finishing`)
                resolveWait()
            },
            10 * 60 * 1000
        )
    })
}

function findEpisode(anime: TrackedAnime, number: number, variant?: string): Episode | undefined {
    return (
        anime.episodes.find(episode => episode.number === number && episode.variant === variant) ??
        anime.episodes.find(episode => episode.number === number)
    )
}
