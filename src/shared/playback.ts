/**
 * What to do when hls.js reports a *fatal* error.
 *
 * Pure on purpose. This rule used to be three lines inside the error handler in
 * `Player.vue` and it was wrong in a way nothing could catch from outside: every
 * fatal error, whenever it arrived, meant "this server is dead, walk to the next
 * one". hls.js does not use "fatal" that way. A stalled buffer that its nudge
 * loop could not clear, or a segment whose retries ran out, is reported fatal and
 * is *recoverable* — the library's own documented remedy is `recoverMediaError()`
 * or `startLoad()`, in place, on the stream that is already playing.
 *
 * So the viewer would watch three minutes of an episode, hit one bad segment on a
 * CDN edge, and be moved to another server with the first one marked dead for the
 * rest of the session. Nothing in the logs said so, because from the extension's
 * point of view walking the server list is the success path.
 *
 * The distinction that fixes it is the one the old code never drew: **an error
 * before anything played is a verdict about the server; an error after something
 * played is a hiccup in a stream that demonstrably works.**
 */

/** hls.js `ErrorTypes`, reduced to the three that change the answer. */
export type FatalKind = "network" | "media" | "other"

/**
 * `Hls.ErrorTypes` values are plain strings, so the mapping lives here rather
 * than in the component — which keeps this module free of the hls.js import and
 * therefore runnable under node.
 */
export function fatalKind(type: string): FatalKind {
    if (type === "networkError") return "network"
    // A mux error is a media error by another name: the remedy is the same
    // buffer flush, and hls.js recovers from both through `recoverMediaError`.
    if (type === "mediaError" || type === "muxError") return "media"
    return "other"
}

export interface FatalContext {
    kind: FatalKind
    /**
     * Seconds this stream has actually been showing a picture. Zero means it
     * never started, which is the whole hinge of the decision below.
     */
    playedSec: number
    /** Recoveries already spent on this stream since the last time it settled. */
    attempts: number
    /** Milliseconds since the last recovery. `Infinity` when there has been none. */
    sinceLastRecoveryMs: number
    /** This attach is already routed through the background proxy. */
    viaProxy: boolean
    /** The extractor asked for the proxy, so escalating to it is not a move. */
    proxyRequested: boolean
    /** Resolved `recoverStalledPlayback`, per anime → per source → global. */
    recoverEnabled: boolean
}

export type Remedy =
    /** `hls.recoverMediaError()`, optionally swapping the audio codec first. */
    | { do: "recoverMedia"; swapAudioCodec: boolean }
    /** `hls.startLoad()` — re-request the playlist and carry on where we are. */
    | { do: "restartLoad" }
    /** Tear down and re-attach the same stream through the background proxy. */
    | { do: "viaProxy" }
    /** Give up on this server. */
    | { do: "nextServer" }

export interface Decision {
    remedy: Remedy
    /** The attempt count to carry forward on this stream. */
    attempts: number
    /** Whether the server should be struck off, so the ladder never returns. */
    markFailed: boolean
    /** One line for the console, so a switch is never unexplained again. */
    reason: string
}

/**
 * Below this, nothing was ever really playing.
 *
 * Not zero: hls.js can buffer a fragment, paint a frame and then fail, and a
 * single frame is not a working server. Three seconds is long enough that a
 * viewer would have noticed the picture and short enough that it costs nothing
 * on a server that is genuinely dead.
 */
export const STARTED_AFTER_SEC = 3

/**
 * Recoveries allowed before the stream is judged dead after all.
 *
 * Bounded because `recoverMediaError` on a genuinely broken stream loops
 * happily forever, and an endless retry is worse than a server switch: at least
 * the switch ends in a picture.
 */
export const MAX_RECOVERIES = 4

/**
 * Clean playback that buys the budget back.
 *
 * Without this the budget is really "four hiccups per episode", so a
 * twenty-minute stream that stumbles once every five minutes is condemned on the
 * last one even though every recovery worked. A minute and a half of unbroken
 * playback says the previous trouble is over.
 */
export const RECOVERY_RESET_MS = 90_000

export function decideFatal(ctx: FatalContext): Decision {
    /*
     * Startup. Nothing played, so this is a verdict about the server and the old
     * ladder is exactly right: try the proxy once in case the CDN refused what
     * the page sent, then move on.
     */
    if (ctx.playedSec < STARTED_AFTER_SEC) {
        if (!ctx.viaProxy && !ctx.proxyRequested) {
            return {
                remedy: { do: "viaProxy" },
                attempts: ctx.attempts,
                markFailed: false,
                reason: "never started; retrying through the proxy"
            }
        }
        return { remedy: { do: "nextServer" }, attempts: ctx.attempts, markFailed: true, reason: "never started" }
    }

    if (!ctx.recoverEnabled) {
        return {
            remedy: { do: "nextServer" },
            attempts: ctx.attempts,
            markFailed: true,
            reason: "recovery is off for this series"
        }
    }

    // A long clean run since the last recovery means the last trouble is over.
    const spent = ctx.sinceLastRecoveryMs >= RECOVERY_RESET_MS ? 0 : ctx.attempts

    if (spent >= MAX_RECOVERIES) {
        return {
            remedy: { do: "nextServer" },
            attempts: spent,
            markFailed: true,
            reason: `${spent} recoveries in a row did not hold`
        }
    }

    if (ctx.kind === "media") {
        return {
            remedy: { do: "recoverMedia", swapAudioCodec: spent > 0 },
            attempts: spent + 1,
            markFailed: false,
            reason: "media error after playback started"
        }
    }

    if (ctx.kind === "network") {
        /*
         * One reload first, because most of these are a single bad segment. If
         * reloading did not settle it and we are loading straight from the page,
         * the next suspect is the header rewrite not reaching the page's own
         * requests — the same 403-that-looks-like-a-dead-server this codebase
         * already knows about, only arriving mid-episode because the CDN rotated
         * a host or a token expired.
         */
        if (spent >= 1 && !ctx.viaProxy && !ctx.proxyRequested) {
            return {
                remedy: { do: "viaProxy" },
                attempts: spent + 1,
                markFailed: false,
                reason: "reloading did not settle it; moving this stream onto the proxy"
            }
        }
        return {
            remedy: { do: "restartLoad" },
            attempts: spent + 1,
            markFailed: false,
            reason: "network error after playback started"
        }
    }

    return {
        remedy: { do: "nextServer" },
        attempts: spent,
        markFailed: true,
        reason: "unrecoverable error after playback started"
    }
}
