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
import {
    MegaPlayExtractor,
    cdnToken,
    decryptSources,
    signedUrl,
    tokenPath,
    type SourcesResponse
} from "~/extractors/sites/megaplay"
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

console.log("\n\x1b[1mmegaplay — the encrypted sources payload\x1b[0m\n")

/*
 * Captured 2026-09-15 from file 161371 on megaplay.buzz. Both endpoints answer
 * with this now; the scheme is AES-256-CBC under a key and IV lifted from the
 * host's own bundle. The key is 16 characters padded to 32 bytes — using it as
 * AES-128 fails the same way a rotated key would, so this is the check that
 * separates "we got the arithmetic wrong" from "the host changed".
 */
const CAPTURED_ENC =
    "wdeBruh3qqn_i5wUNnyaPcXqidp1UWP84FfPHzGyKXCtzzjd9QOKnGlfpWz9zni7KLm8ZOSO5mCylRsEEs351e5r8BuIRfR2AqYhvR5XuGJKKk54Uc31mACICmO83ZzaRRdMdWeQitJzZg7oCcdRVgOMYDBWYdD93oNrhz3Vf3E"
const CAPTURED_FILE =
    "https://fetch.nexabloom.top/anime/f6ec706c08a1f5eb01539dafdc14b4a3/8cc6f8a81147b9d284b92b804dae6dd5/master.m3u8"

eq("the captured payload decrypts to the file", (await decryptSources(CAPTURED_ENC)).file, CAPTURED_FILE)
await rejects("a truncated payload is refused", decryptSources(CAPTURED_ENC.slice(0, -8)), "did not decrypt")

console.log("\n\x1b[1mmegaplay — the CDN token\x1b[0m\n")

/*
 * The token the site's own player put on that same master playlist, in the
 * same session. Its expiry was 1789469906, minted 90 seconds ahead, so the same
 * clock reproduces it byte for byte — which pins the message layout, the HMAC
 * key and the encoding at once.
 */
const CAPTURED_TOKEN =
    "MTc4OTQ2OTkwNnxmNmVjNzA2YzA4YTFmNWViMDE1MzlkYWZkYzE0YjRhMy84Y2M2ZjhhODExNDdiOWQyODRiOTJiODA0ZGFlNmRkNQ.2cf3fsX0-0Dd7aioMbrJE7iC3-kWVhwuAH8sA9oqct0"
const CAPTURED_PATH = "f6ec706c08a1f5eb01539dafdc14b4a3/8cc6f8a81147b9d284b92b804dae6dd5"

eq("the two ids come out of the path", tokenPath(CAPTURED_FILE), CAPTURED_PATH)
eq("upper-case hex is lowered, as the site does", tokenPath(CAPTURED_FILE.toUpperCase()), CAPTURED_PATH)
eq("a URL without the pair has no token path", tokenPath("https://cdn.example/anime/abc/master.m3u8"), null)
eq(
    "the site's own token is reproduced from its clock",
    await cdnToken(CAPTURED_PATH, (1789469906 - 90) * 1000, 90),
    CAPTURED_TOKEN
)

const signed = await signedUrl(CAPTURED_FILE, (1789469906 - 90) * 1000)
eq("signing appends the token", signed.startsWith(`${CAPTURED_FILE}?token=`), true)
eq(
    "and the token is url-safe as written, nothing percent-escaped",
    /\?token=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(signed),
    true
)
eq(
    "signed for an hour, not the site's ninety seconds",
    signed.includes(await cdnToken(CAPTURED_PATH, (1789469906 - 90) * 1000)),
    true
)
eq("a URL already carrying one is left alone", await signedUrl(signed), signed)
eq(
    "a query string already there is extended, not replaced",
    (await signedUrl(`${CAPTURED_FILE}?v=1`)).startsWith(`${CAPTURED_FILE}?v=1&token=`),
    true
)
{
    const plain = "https://cdn.example/anime/abc/master.m3u8"
    eq("a URL the token is not bound to is passed through", await signedUrl(plain), plain)
}

console.log("\n\x1b[1mmegaplay — the whole extraction\x1b[0m\n")

/*
 * These drive the real `extract` rather than a helper, because the bugs were
 * never in the arithmetic: one was in which URL got asked (the endpoint
 * migration of 2026-09-09) and one in what got dropped from it (the `?s=` CDN
 * choice, so three servers were one). A fake ctx records that.
 */

/** The embed page, reduced to the one attribute the extractor reads. */
const embedPage = `<html><body><div id="megaplay-player" data-id="179483"></div></body></html>`

const PLAIN_PAYLOAD: SourcesResponse = {
    sources: { file: "https://ncdn.imgnex.top/anime/a/b/master.m3u8" },
    tracks: [{ file: "https://cdn.imgnex.top/a/b/track_0_eng.vtt", label: "English", kind: "captions", default: true }],
    intro: { start: 33, end: 133 },
    outro: { start: 569, end: 668 }
}

/** What both endpoints return today. */
const ENC_PAYLOAD: SourcesResponse = { ...PLAIN_PAYLOAD, sources: undefined, enc: CAPTURED_ENC }

/** Records every URL asked for, and answers only the endpoints it was given. */
function ctxServing(answers: Record<string, SourcesResponse>) {
    const asked: string[] = []
    const ctx = {
        referer: "https://anikototv.to/watch/x/ep-17",
        text: async () => embedPage,
        json: async (url: string) => {
            asked.push(url.slice(url.indexOf("/stream/") + "/stream/".length))
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

// The live shape as of 2026-09-15: both endpoints answer, both encrypted.
{
    const { ctx, asked } = ctxServing({ getSourcesNew: ENC_PAYLOAD, getSources: ENC_PAYLOAD })
    const streams = await megaplay.extract(embed, ctx)
    eq("the new endpoint is asked first", asked[0], "getSourcesNew?id=179483")
    eq("and once it answers the old one is left alone", asked.length, 1)
    eq("the stream is the decrypted file, signed", streams[0]?.url.split("?")[0], CAPTURED_FILE)
    eq("carrying a token", /[?&]token=/.test(streams[0]?.url ?? ""), true)
    eq("typed from the extension", streams[0]?.kind, "hls")
    eq("subtitles come across", streams[0]?.subtitles?.length, 1)
    eq("and so do the skip offsets", streams[0]?.skips?.intro?.startSec, 33)
}

// The CDN choice rides on the embed URL and has to reach the sources request,
// or every server resolves to the same file.
{
    const { ctx, asked } = ctxServing({ getSourcesNew: ENC_PAYLOAD })
    await megaplay.extract(`${embed}?s=tcdn`, ctx)
    eq("the embed's ?s= is forwarded to the sources request", asked[0], "getSourcesNew?id=179483&s=tcdn")
}

// A host on this white-labelled engine that still hands the file over in plain
// text — the pre-migration shape.
{
    const { ctx, asked } = ctxServing({ getSources: PLAIN_PAYLOAD })
    const streams = await megaplay.extract(embed, ctx)
    eq(
        "a 404 on the new endpoint falls back to the old one",
        asked.join(","),
        "getSourcesNew?id=179483,getSources?id=179483"
    )
    eq("and a plain file is taken as it is", streams[0]?.url, PLAIN_PAYLOAD.sources?.file)
}

// A file that genuinely has nothing behind it.
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
