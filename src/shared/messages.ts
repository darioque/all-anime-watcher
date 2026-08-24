import browser from "webextension-polyfill"
import type { GlobalSettings } from "~/settings/schema"
import type { PageInfo, Server } from "~/sources/types"
import type { Stream } from "~/extractors/types"
import type { DomainResolution } from "~/background/domains"
import type { SchedulePolicy, TrackedAnime } from "~/model/types"

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
    "library:refresh": { req: { key: string }; res: TrackedAnime | null }
    "library:checkAll": { req: { force?: boolean }; res: number }
    /** Forget the viewer's position, keeping the series. */
    "library:resetWatch": { req: { key: string }; res: TrackedAnime | null }
    "debug:testNotification": { req: Record<string, never>; res: boolean }
    "library:setSchedule": { req: { key: string; schedule: SchedulePolicy }; res: TrackedAnime | null }
    "scheduler:status": {
        req: Record<string, never>
        res: { running: boolean; lastRunAt: number; lastRunFound: number }
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
        req: { key: string }
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
