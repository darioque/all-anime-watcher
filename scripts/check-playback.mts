/**
 * Exercise the rule that decides what a fatal hls.js error means.
 *
 *   npm run check:playback
 *
 * The bug this suite exists for: the extension used to read every fatal error as
 * "this server is dead" and walk to the next one. On anikoto, where MegaPlay's
 * CDN stalls a fragment now and then, that moved a viewer off a working server
 * three minutes into an episode, and off the next one a few minutes after that,
 * with each server struck off for the rest of the session. The cases below are
 * that failure, its recovery ladder, and the boundaries either side of it.
 */
import {
    decideFatal,
    fatalKind,
    MAX_RECOVERIES,
    RECOVERY_RESET_MS,
    STARTED_AFTER_SEC,
    type FatalContext
} from "~/shared/playback"

let failures = 0

function check(label: string, condition: boolean, detail = "") {
    if (condition) {
        console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`)
    } else {
        failures++
        console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`)
    }
}

function eq<T>(label: string, actual: T, expected: T) {
    check(label, Object.is(actual, expected), Object.is(actual, expected) ? "" : `got ${String(actual)}`)
}

/** A stream that has been playing happily for five minutes and has never faltered. */
function playing(over: Partial<FatalContext> = {}): FatalContext {
    return {
        kind: "network",
        playedSec: 300,
        attempts: 0,
        sinceLastRecoveryMs: Number.POSITIVE_INFINITY,
        viaProxy: false,
        proxyRequested: false,
        recoverEnabled: true,
        ...over
    }
}

console.log("\nhls.js error types")
eq("networkError", fatalKind("networkError"), "network")
eq("mediaError", fatalKind("mediaError"), "media")
eq("a mux error is a media error by another name", fatalKind("muxError"), "media")
eq("anything else is unrecoverable", fatalKind("otherError"), "other")
eq("and so is a type we have never heard of", fatalKind("keySystemError"), "other")

console.log("\nnothing has played yet: a verdict about the server")
const cold = playing({ playedSec: 0 })
eq("the proxy is tried once first", decideFatal(cold).remedy.do, "viaProxy")
check("and the server is not struck off for it", decideFatal(cold).markFailed === false)
eq("already on the proxy: move on", decideFatal({ ...cold, viaProxy: true }).remedy.do, "nextServer")
check("and that one is struck off", decideFatal({ ...cold, viaProxy: true }).markFailed)
eq(
    "the extractor asked for the proxy, so there is nothing to escalate to",
    decideFatal({ ...cold, proxyRequested: true }).remedy.do,
    "nextServer"
)
eq(
    "a frame or two is not a working server",
    decideFatal({ ...cold, playedSec: STARTED_AFTER_SEC - 0.5 }).remedy.do,
    "viaProxy"
)

console.log("\nit has been playing: a hiccup, not a verdict")
// The reported bug, exactly: three minutes in, one stalled buffer.
const stalled = decideFatal(playing({ kind: "media", playedSec: 180 }))
eq("a stalled buffer is recovered in place", stalled.remedy.do, "recoverMedia")
check("the server keeps its place in the ladder", stalled.markFailed === false)
check(
    "the codec swap is held back for the second try",
    stalled.remedy.do === "recoverMedia" && stalled.remedy.swapAudioCodec === false
)
const second = decideFatal(playing({ kind: "media", playedSec: 180, attempts: 1, sinceLastRecoveryMs: 2000 }))
check(
    "a second media error straight after swaps the audio codec",
    second.remedy.do === "recoverMedia" && second.remedy.swapAudioCodec === true
)

eq("a lost fragment is reloaded, not abandoned", decideFatal(playing()).remedy.do, "restartLoad")
eq(
    "if reloading did not settle it, the stream moves onto the proxy",
    decideFatal(playing({ attempts: 1, sinceLastRecoveryMs: 2000 })).remedy.do,
    "viaProxy"
)
eq(
    "unless it is already there",
    decideFatal(playing({ attempts: 1, sinceLastRecoveryMs: 2000, viaProxy: true })).remedy.do,
    "restartLoad"
)
eq(
    "an error we have no remedy for still ends the server",
    decideFatal(playing({ kind: "other" })).remedy.do,
    "nextServer"
)

console.log("\nthe budget")
const spent = playing({ kind: "media", attempts: MAX_RECOVERIES, sinceLastRecoveryMs: 2000 })
eq("recoveries that never hold end in a server change", decideFatal(spent).remedy.do, "nextServer")
check("and the server is struck off then", decideFatal(spent).markFailed)
eq("each recovery spends one", decideFatal(playing({ kind: "media" })).attempts, 1)
eq("a remedy that is not a recovery spends none", decideFatal(playing({ kind: "other" })).attempts, 0)

// Without the reset, the budget is really "four hiccups per episode", and a
// twenty-minute stream that stumbles once every five minutes is condemned on the
// last one even though all four recoveries worked.
const settled = playing({ kind: "media", attempts: MAX_RECOVERIES, sinceLastRecoveryMs: RECOVERY_RESET_MS })
eq("a clean run buys the budget back", decideFatal(settled).remedy.do, "recoverMedia")
eq("and the count starts over", decideFatal(settled).attempts, 1)
eq(
    "a run just short of it does not",
    decideFatal({ ...settled, sinceLastRecoveryMs: RECOVERY_RESET_MS - 1 }).remedy.do,
    "nextServer"
)

console.log("\nthe setting")
const off = playing({ kind: "media", recoverEnabled: false })
eq("turned off, one stumble is still a server change", decideFatal(off).remedy.do, "nextServer")
eq(
    "but it never overrides the startup ladder, which is not recovery",
    decideFatal(playing({ playedSec: 0, recoverEnabled: false })).remedy.do,
    "viaProxy"
)

console.log("\nevery decision explains itself")
for (const ctx of [cold, playing(), playing({ kind: "media" }), off, spent]) {
    const decision = decideFatal(ctx)
    check(`"${decision.reason}"`, decision.reason.length > 0)
}

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
