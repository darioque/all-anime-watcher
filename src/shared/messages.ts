import browser from "webextension-polyfill"
import type { GlobalSettings } from "~/settings/schema"
import type { PageInfo, Server } from "~/sources/types"
import type { Stream } from "~/extractors/types"
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
}

export interface PageIdentity {
    sourceId: string | null
    isEpisode: boolean
    pageInfo?: PageInfo
    /** Library key, once the entry exists. */
    key?: string
    /** Servers the page offers, already ordered by preference. */
    servers?: Server[]
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
    "library:add": { req: { sourceId: string; seriesUrl: string }; res: TrackedAnime | null }
    "library:remove": { req: { key: string }; res: boolean }
    "library:setFlags": { req: { key: string; follow?: boolean; poll?: boolean }; res: TrackedAnime | null }
    "library:rename": { req: { key: string; displayTitle: string }; res: TrackedAnime | null }
    "library:refresh": { req: { key: string }; res: TrackedAnime | null }
    "library:checkAll": { req: { force?: boolean }; res: number }
    "library:setSchedule": { req: { key: string; schedule: SchedulePolicy }; res: TrackedAnime | null }
    "scheduler:status": {
        req: Record<string, never>
        res: { running: boolean; lastRunAt: number; lastRunFound: number }
    }

    "library:markWatched": {
        req: { key: string; number: number; variant?: string }
        res: TrackedAnime | null
    }

    "settings:get": { req: Record<string, never>; res: GlobalSettings }
    "settings:patch": { req: { patch: Partial<GlobalSettings> }; res: GlobalSettings }

    "sources:list": { req: Record<string, never>; res: SourceDescriptor[] }
    "sources:search": {
        req: { sourceId: string; query: string }
        res: { title: string; url: string; seriesId: string; poster?: string }[]
    }

    "playback:streams": {
        req: { sourceId: string; server: Server; episodeUrl: string }
        res: { embedUrl: string; extractorId: string; streams: Stream[] }
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

export async function send<A extends Action>(action: A, payload: Request<A>): Promise<Response<A>> {
    const reply = (await browser.runtime.sendMessage({ action, payload } satisfies Envelope<A>)) as
        Reply<Response<A>> | undefined

    if (!reply) throw new Error(`no reply from background for "${action}"`)
    if (!reply.ok) throw new Error(reply.error)
    return reply.data
}
