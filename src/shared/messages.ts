import browser from "webextension-polyfill"
import type { GlobalSettings } from "~/settings/schema"
import type { PageInfo, Server } from "~/sources/types"
import type { Stream } from "~/extractors/types"
import type { DomainResolution } from "~/background/domains"
import type { SchedulePolicy, TrackedAnime } from "~/model/types"
import type { ImportMode, ImportSummary } from "~/model/backup"
import type { DownloadJob, DownloadProgress, FetchPlan } from "~/downloads/types"
import type { LabFetchReport, LabSeriesReport } from "~/lab/types"
import type { SearchResult } from "~/sources/types"

/** A source as the UI sees it — no functions, safe to structured-clone. */
export interface SourceDescriptor {
    id: string
    name: string
    languages: string[]
    domains: string[]
    home: string
    enabled: boolean
    preferredDomain?: string
    pinnedDomain?: string
    knownDomains?: string[]
    /** Whether the site announces its live domains somewhere. */
    hasDomainSource?: boolean
    /** Categories the site claims for everything it carries, by name. */
    categories?: string[]
    lastDomainCheckAt?: number
    lastDomainCheckResult?: "ok" | "moved" | "unreachable"
}

export interface PageIdentity {
    sourceId: string | null
    isEpisode: boolean
    pageInfo?: PageInfo
    /** Library key, once the entry exists. */
    key?: string
    /** Servers the page offers, already ordered by preference. */
    servers?: Server[]
    /**
     * Whether opening the episode should count as watching it when the player
     * ends up embedding the site's own frame — the one case where no completion
     * threshold can ever be reached, because nothing can see inside the frame.
     */
    markOnEmbed?: boolean
    /**
     * Whether opening the episode counts as watching it.
     *
     * Resolved in the background like `markOnEmbed`. It matters for the in-place
     * episode swap in particular: nothing navigates, so nothing re-runs the
     * tracking that a page load would have done.
     */
    markOnOpen?: boolean
    /**
     * The background already recorded the on-open mark, so the player must not.
     *
     * False means "opening counts, but only once you have something on screen" —
     * the player marks it at that moment instead. See `onOpenMark`.
     */
    markedOnOpen?: boolean
    /**
     * The source recognised this page as posted-but-not-watchable: a countdown,
     * a premium window, a placeholder. The player says so instead of walking
     * five servers that each resolve to nothing.
     */
    pending?: boolean
    pendingReason?: string
    error?: string
}

/**
 * Response of the playback proxy. Exactly one of `text` / `base64` is set.
 *
 * Binary comes back base64-encoded because Chrome JSON-serialises extension
 * messages — an ArrayBuffer would arrive as `{}`. See shared/binary.ts.
 */
export interface ProxyResponse {
    status: number
    url?: string
    text?: string
    base64?: string
    error?: string
}

/**
 * Every background message, request type to response type.
 *
 * One map instead of a loose union so `send()` infers the response and a typo in
 * an action name fails at compile time rather than at 2am in the console.
 */
export interface MessageMap {
    "page:identify": { req: { url: string; html: string }; res: PageIdentity }

    "library:list": { req: Record<string, never>; res: TrackedAnime[] }
    "library:get": { req: { key: string }; res: TrackedAnime | null }
    "library:add": {
        req: { sourceId: string; seriesUrl: string; seriesId?: string; title?: string; poster?: string }
        res: TrackedAnime | null
    }
    "library:remove": { req: { key: string }; res: boolean }
    "library:setFlags": { req: { key: string; follow?: boolean; poll?: boolean }; res: TrackedAnime | null }
    "library:rename": { req: { key: string; displayTitle: string }; res: TrackedAnime | null }
    /** Manual shelf membership, as a whole list. */
    "library:setCategories": { req: { key: string; categories: string[] }; res: TrackedAnime | null }
    /**
     * One series on or off one shelf — including a shelf that fills itself.
     *
     * Separate from `setCategories` because the answer depends on the shelf's
     * rule: taking a series off "Donghua" has to record an exclusion, while
     * taking it off a shelf it was only ever put on by hand records nothing.
     */
    "library:shelve": { req: { key: string; categoryId: string; on: boolean }; res: TrackedAnime | null }
    /** One shelf, many series — the bulk action behind the category bar. */
    "library:bulkCategory": {
        req: { keys: string[]; categoryId: string; action: "add" | "remove" }
        res: number
    }
    "library:refresh": { req: { key: string }; res: TrackedAnime | null }
    "library:checkAll": { req: { force?: boolean }; res: number }
    /** Forget the viewer's position, keeping the series. */
    "library:resetWatch": { req: { key: string }; res: TrackedAnime | null }
    "debug:testNotification": { req: Record<string, never>; res: boolean }
    "library:setSchedule": { req: { key: string; schedule: SchedulePolicy }; res: TrackedAnime | null }
    "scheduler:status": {
        req: Record<string, never>
        res: { running: boolean; lastRunAt: number; lastRunFound: number; paused: boolean }
    }

    /** The whole library as a file. Text rather than a Blob: messages are JSON. */
    "backup:export": { req: Record<string, never>; res: { filename: string; text: string } }
    /**
     * Apply a backup file, or — with `dryRun` — work out what it would do and
     * report that without writing anything.
     */
    "backup:import": {
        req: { text: string; mode: ImportMode; settings: boolean; dryRun?: boolean }
        res: ImportSummary & { mode: ImportMode; exportedAt: number; appVersion?: string; applied: boolean }
    }

    "library:markWatched": {
        req: {
            key: string
            number: number
            variant?: string
            /** Deliberate "set my position here", allowed to move backwards. */
            force?: boolean
        }
        res: TrackedAnime | null
    }

    "settings:get": { req: Record<string, never>; res: GlobalSettings }
    "settings:patch": { req: { patch: Partial<GlobalSettings> }; res: GlobalSettings }

    "sources:list": { req: Record<string, never>; res: SourceDescriptor[] }
    "tracker:matches": {
        /** `query` searches AniList for what the user typed; without it, for the series' own title. */
        req: { key: string; query?: string }
        res: {
            id: number
            title: string
            year?: number
            format?: string
            episodes?: number
            cover?: string
            score: number
        }[]
    }
    "tracker:link": { req: { key: string; anilistId: number }; res: TrackedAnime | null }
    "tracker:unlink": { req: { key: string }; res: TrackedAnime | null }
    "tracker:refresh": { req: { key?: string }; res: number }

    "sources:resolveDomains": { req: { sourceId?: string; force?: boolean }; res: DomainResolution[] }
    "sources:pinDomain": { req: { sourceId: string; host?: string }; res: boolean }

    "sources:search": {
        req: { sourceId: string; query: string }
        res: { title: string; url: string; seriesId: string; poster?: string }[]
    }

    "playback:streams": {
        req: { sourceId: string; server: Server; episodeUrl: string }
        res: { embedUrl: string; extractorId: string | null; streams: Stream[] }
    }
    /**
     * Read the next episode's page while the current one is still playing.
     *
     * Never a tracking signal — see `identifyEpisode`. With `warm`, the first
     * server's stream is resolved too, so arriving at the episode costs nothing
     * but attaching it.
     */
    "playback:prepare": {
        req: { sourceId: string; episodeUrl: string; warm?: boolean }
        res: PageIdentity
    }

    "playback:orderServers": {
        req: { sourceId: string; animeKey?: string; servers: Server[] }
        res: Server[]
    }
    "playback:fetch": {
        req: {
            url: string
            rangeStart?: number
            rangeEnd?: number
            responseType: "text" | "arraybuffer"
            headers?: Record<string, string>
        }
        res: ProxyResponse
    }
    /** Intro/outro offsets for an episode, from the tracker when the site has none. */
    "playback:skipTimes": {
        req: { key?: string; number: number; durationSec?: number }
        res: { intro?: { startSec: number; endSec: number }; outro?: { startSec: number; endSec: number } } | null
    }
    "playback:sourceForUrl": { req: { url: string }; res: string | null }

    "progress:update": {
        req: { key: string; number: number; variant?: string; positionSec: number; durationSec?: number }
        res: boolean
    }

    "downloads:list": { req: Record<string, never>; res: DownloadJob[] }
    /** Queue one episode. Returns the job, or null if it is already queued. */
    "downloads:add": { req: { key: string; number: number; variant?: string }; res: DownloadJob | null }
    "downloads:cancel": { req: { id: string }; res: boolean }
    /** Forget finished, failed and cancelled jobs. */
    "downloads:clearFinished": { req: Record<string, never>; res: number }
    "downloads:retry": { req: { id: string }; res: DownloadJob | null }
    /** Offscreen → background, while a job runs. */
    "downloads:progress": { req: DownloadProgress; res: boolean }
    /**
     * Offscreen → background, once the file exists.
     *
     * The completion travels this way rather than as the reply to
     * `offscreen:download` because an episode takes minutes and a service worker
     * is torn down after thirty seconds of quiet. A reply awaited across that is
     * a reply nobody is left to receive; a message *sent* to the worker wakes it.
     */
    "downloads:assembled": { req: { id: string; url: string; bytes: number }; res: boolean }
    "downloads:failed": { req: { id: string; error: string }; res: boolean }

    /*
     * Background → offscreen document. Namespaced so the offscreen listener can
     * tell at a glance what is addressed to it: every context receives every
     * runtime message, and a listener that answered one meant for the router
     * would race it and win about half the time.
     */
    /** Acknowledged immediately; the result arrives later as `downloads:assembled`. */
    "offscreen:download": { req: FetchPlan; res: { started: true } }
    "offscreen:cancel": { req: { id: string }; res: boolean }
    "offscreen:release": { req: { id: string }; res: boolean }

    /*
     * The Lab: run one piece of a source or extractor on demand, inside the
     * extension. `npm run probe` covers most of this faster, but Node's fetch
     * can set Referer and a browser's cannot — so a site that demands one works
     * under the CLI and fails here, which is precisely the class of bug that has
     * cost the most time.
     */
    "lab:search": { req: { sourceId: string; query: string }; res: { ms: number; result: SearchResult[] } }
    "lab:series": { req: { sourceId: string; url: string }; res: { ms: number; result: LabSeriesReport } }
    "lab:page": { req: { url: string }; res: { ms: number; result: { htmlBytes: number; identity: PageIdentity } } }
    "lab:streams": {
        req: { sourceId: string; episodeUrl: string; server: Server }
        res: { ms: number; result: { embedUrl: string; extractorId: string | null; streams: Stream[]; error?: string } }
    }
    "lab:extract": {
        req: { embedUrl: string; referer?: string }
        res: { ms: number; result: { extractorId: string; streams: Stream[] } }
    }
    /** One URL, fetched from in here, with whatever rules are installed. */
    "lab:fetch": { req: { url: string }; res: { ms: number; result: LabFetchReport } }
    "lab:rules": {
        req: Record<string, never>
        res: {
            id: number
            requestDomains: string[]
            initiatorDomains: string[]
            resourceTypes: string[]
            setHeaders: string[]
            removeHeaders: string[]
        }[]
    }

    "tab:open": { req: { url: string; active?: boolean }; res: boolean }
    "tab:openLibrary": { req: Record<string, never>; res: boolean }
}

export type Action = keyof MessageMap
export type Request<A extends Action> = MessageMap[A]["req"]
export type Response<A extends Action> = MessageMap[A]["res"]

export interface Envelope<A extends Action = Action> {
    action: A
    payload: Request<A>
}

/** Errors are returned rather than thrown, so a sender can't take down a caller. */
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Background → open extension pages: "something in the library changed".
 *
 * A broadcast rather than a request: there may be a popup, a library tab, both,
 * or neither, and none of them can be asked to poll — a series added from a site
 * has to appear in an already-open library without the user reloading it.
 *
 * Deliberately outside `MessageMap`: nothing replies to it, and Chrome does not
 * deliver a runtime message back to the context that sent it, so the background's
 * own router never sees these.
 */
export const LIBRARY_CHANGED = "ui:libraryChanged"

/**
 * Background → open pages: "the download queue moved".
 *
 * Its own channel rather than a `libraryChanged` reason, because progress ticks
 * arrive several times a second and the library list re-reads the whole database
 * when it hears one. A downloads panel wants every tick; the library wants none
 * of them.
 */
export const DOWNLOADS_CHANGED = "aaw:downloadsChanged"

export interface DownloadsChanged {
    action: typeof DOWNLOADS_CHANGED
    jobs: DownloadJob[]
}

export function onDownloadsChanged(handler: (event: DownloadsChanged) => void): () => void {
    const listener = (message: unknown) => {
        const event = message as Partial<DownloadsChanged> | undefined
        if (event?.action === DOWNLOADS_CHANGED) handler(event as DownloadsChanged)
        return undefined
    }
    browser.runtime.onMessage.addListener(listener)
    return () => browser.runtime.onMessage.removeListener(listener)
}

export interface LibraryChanged {
    action: typeof LIBRARY_CHANGED
    /** What happened, for logging and for deciding how much to reload. */
    reason: string
    /** The entry involved, when it was a single one. */
    key?: string
}

/** Subscribe an extension page. Returns an unsubscribe function. */
export function onLibraryChanged(handler: (event: LibraryChanged) => void): () => void {
    const listener = (message: unknown) => {
        const event = message as Partial<LibraryChanged> | undefined
        if (event?.action === LIBRARY_CHANGED) handler(event as LibraryChanged)
        // Returning nothing leaves the channel free for the real handlers.
        return undefined
    }
    browser.runtime.onMessage.addListener(listener)
    return () => browser.runtime.onMessage.removeListener(listener)
}

export async function send<A extends Action>(action: A, payload: Request<A>): Promise<Response<A>> {
    const reply = (await browser.runtime.sendMessage({ action, payload } satisfies Envelope<A>)) as
        Reply<Response<A>> | undefined

    if (!reply) throw new Error(`no reply from background for "${action}"`)
    if (!reply.ok) throw new Error(reply.error)
    return reply.data
}
