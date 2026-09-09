/**
 * Exercise the parts of an extractor that are arithmetic rather than scraping.
 *
 *   npm run check:extractors
 *
 * Most extractor breakage is a selector that stopped matching, and only the live
 * site can tell you that. But a host that hands over an encrypted player config
 * is different: the derivation either reproduces the site's own or it does not,
 * and getting it subtly wrong yields a key of exactly the right length that
 * decrypts to nothing. That failure is indistinguishable from "the site changed"
 * unless something pins the scheme down. This does.
 */
import { assembleKey, decryptPlayback, fromBase64Url, keyIndices, videoCode } from "~/extractors/sites/byse"
import { MegaPlayExtractor, type SourcesResponse } from "~/extractors/sites/megaplay"
import type { ExtractCtx } from "~/extractors/types"
import { bysePlayback, byseExpected } from "./fixtures/byse"

let failures = 0

function eq<T>(label: string, actual: T, expected: T) {
    const ok = Object.is(actual, expected)
    if (!ok) failures++
    console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${ok ? "" : ` — got ${String(actual)}`}`)
}

function throws(label: string, work: () => unknown) {
    let threw = false
    try {
        work()
    } catch {
        threw = true
    }
    if (!threw) failures++
    console.log(`  ${threw ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}`)
}

console.log("\n\x1b[1mbyse — the embed URL\x1b[0m\n")

eq("the code comes out of the path", videoCode("https://bysekoze.com/e/afl6vo7sypot"), "afl6vo7sypot")
eq("a query string is not part of it", videoCode("https://bysekoze.com/e/afl6vo7sypot?autoplay=1"), "afl6vo7sypot")
eq("a page that is not an embed yields nothing", videoCode("https://bysekoze.com/afl6vo7sypot"), null)
eq("nor does something that is not a URL", videoCode("afl6vo7sypot"), null)

console.log("\n\x1b[1mbyse — which parts make the key\x1b[0m\n")

/*
 * The site builds `n → [n, 31 - n]` for n in 1..20 and indexes it by `version`,
 * one-based. Every case below is one the live response can produce: version
 * changes on every request.
 */
eq("version 6 names parts 6 and 25", keyIndices("6", 30)?.join(","), "6,25")
eq("version 1 names the extremes", keyIndices("1", 30)?.join(","), "1,30")
eq("version 20 names the middle", keyIndices("20", 30)?.join(","), "20,11")
eq("whitespace around it is trimmed", keyIndices(" 15 ", 30)?.join(","), "15,16")

// Outside the table, or naming a part that was not sent. The site discards the
// pair in both cases, and so must this — silently using the wrong parts would
// produce a key of the right length that decrypts to nothing.
eq("version 0 names nothing", keyIndices("0", 30), null)
eq("version 21 is off the end of the table", keyIndices("21", 30), null)
eq("a version naming a part that was not sent is discarded", keyIndices("6", 20), null)
eq("and so is a version that is not a number", keyIndices("latest", 30), null)

console.log("\n\x1b[1mbyse — base64url\x1b[0m\n")

// The site's encoding: `-_` for `+/`, and no padding. Decoding it as plain
// base64 gives bytes that are wrong from the first `-` onwards.
eq("padding is restored", fromBase64Url("YQ").length, 1)
// Parts vary in length; it is the two the version names that have to add up.
eq("a 22-character part is 16 bytes", fromBase64Url("D_J4qhSVVh-1W7qKTHZbqA").length, 16)
eq("62 and 63 are - and _", Array.from(fromBase64Url("--__")).join(","), "251,239,255")

console.log("\n\x1b[1mbyse — the whole scheme, against a captured response\x1b[0m\n")

eq("two parts make a 256-bit key", assembleKey(bysePlayback).length, 32)
throws("a version that names no parts refuses to assemble one", () => assembleKey({ ...bysePlayback, version: "99" }))

const config = await decryptPlayback(bysePlayback)
const source = config.sources?.[0]

eq("the payload decrypts to a config with sources", config.sources?.length, 1)
eq("carrying the master playlist", source?.url?.split("?")[0], byseExpected.url)
eq("labelled with its height", source?.label, byseExpected.label)
eq("and typed as HLS", source?.mime_type, byseExpected.mimeType)

// The tag travels appended to the ciphertext, which is what WebCrypto expects
// and what makes a truncated payload fail loudly rather than decrypt to junk.
await decryptPlayback({ ...bysePlayback, payload: bysePlayback.payload.slice(0, -4) })
    .then(() => {
        failures++
        console.log("  \x1b[31m✗\x1b[0m a truncated payload is rejected")
    })
    .catch(() => console.log("  \x1b[32m✓\x1b[0m a truncated payload is rejected"))

console.log("\n\x1b[1mmegaplay — which sources endpoint\x1b[0m\n")

/*
 * MegaPlay migrated `stream/getSources` to `stream/getSourcesNew` by patching
 * its own client, so the old name still answers 200 — with the file gone and an
 * `enc` blob in its place. Nothing in that response is an error, which is how it
 * read downstream as "this host stopped serving sources" and fell back to the
 * iframe for every episode.
 *
 * These drive the real `extract` rather than a helper, because the bug was never
 * in the arithmetic: it was in which URL got asked. A fake ctx records that.
 */

/** The embed page, reduced to the one attribute the extractor reads. */
const embedPage = `<html><body><div id="megaplay-player" data-id="179483"></div></body></html>`

const NEW_PAYLOAD: SourcesResponse = {
    sources: { file: "https://ncdn.imgnex.top/anime/a/b/master.m3u8" },
    tracks: [{ file: "https://cdn.imgnex.top/a/b/track_0_eng.vtt", label: "English", kind: "captions", default: true }],
    intro: { start: 33, end: 133 },
    outro: { start: 569, end: 668 }
}

/** What the pre-migration name returns on a host that has moved. */
const ENC_PAYLOAD: SourcesResponse = { tracks: [], enc: "wdeBruh3qqn_i5wUNnyaPQQl1wp7r0SrL6KQPNFd24" }

/** Records every URL asked for, and answers only the endpoints it was given. */
function ctxServing(answers: Record<string, SourcesResponse>) {
    const asked: string[] = []
    const ctx = {
        referer: "https://anikototv.to/watch/x/ep-17",
        text: async () => embedPage,
        json: async (url: string) => {
            asked.push(new URL(url).pathname.split("/").pop() ?? "")
            const key = Object.keys(answers).find(name => url.includes(`/stream/${name}?`))
            if (!key) throw new Error("HTTP 404")
            return answers[key]
        }
    } as unknown as ExtractCtx
    return { ctx, asked }
}

const megaplay = new MegaPlayExtractor()
const embed = "https://megaplay.buzz/stream/s-2/762833/sub"

async function rejects(label: string, work: Promise<unknown>, expected: string) {
    try {
        await work
        failures++
        console.log(`  \x1b[31m✗\x1b[0m ${label} — resolved instead`)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const ok = message.includes(expected)
        if (!ok) failures++
        console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${ok ? "" : ` — got ${message}`}`)
    }
}

// The live shape as of 2026-09-09: both endpoints answer, only the new one is
// usable. Asking the old one first is what shipped the bug.
{
    const { ctx, asked } = ctxServing({ getSourcesNew: NEW_PAYLOAD, getSources: ENC_PAYLOAD })
    const streams = await megaplay.extract(embed, ctx)
    eq("the new endpoint is asked first", asked[0], "getSourcesNew")
    eq("and once it answers the old one is left alone", asked.length, 1)
    eq("the stream is the plain file", streams[0]?.url, NEW_PAYLOAD.sources?.file)
    eq("typed from the extension", streams[0]?.kind, "hls")
    eq("subtitles come across", streams[0]?.subtitles?.length, 1)
    eq("and so do the skip offsets", streams[0]?.skips?.intro?.startSec, 33)
}

// A host on this white-labelled engine that has not migrated yet: the new name
// 404s and the old one is still the good one.
{
    const { ctx, asked } = ctxServing({ getSources: NEW_PAYLOAD })
    const streams = await megaplay.extract(embed, ctx)
    eq("a 404 on the new endpoint falls back to the old one", asked.join(","), "getSourcesNew,getSources")
    eq("and still yields the file", streams[0]?.url, NEW_PAYLOAD.sources?.file)
}

// The bug, as it would look if the new endpoint ever went away: an encrypted
// payload is a diagnosis, not a payload, and must not read as "no sources".
await rejects(
    "an encrypted-only answer names the migration",
    megaplay.extract(embed, ctxServing({ getSources: ENC_PAYLOAD }).ctx),
    "encrypted payload"
)

// A file that genuinely has nothing behind it is a different sentence.
await rejects(
    "an empty answer is still just an empty answer",
    megaplay.extract(embed, ctxServing({ getSourcesNew: { tracks: [] } }).ctx),
    "returned no source"
)

// Neither name resolves — a host that is not this engine after all, or is down.
await rejects(
    "neither endpoint is its own report",
    megaplay.extract(embed, ctxServing({}).ctx),
    "served neither sources endpoint"
)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
