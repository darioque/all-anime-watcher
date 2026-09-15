/**
 * Exercise the segment unwrapping.
 *
 *   npm run check:segments
 *
 * The shapes are the real ones, measured on 2026-09-15: MegaPlay's "HD-1" CDN
 * serves each MPEG-TS segment behind a 252-byte PNG header, its other two CDNs
 * serve plain TS under image names, and hls.js is fed the result of this either
 * way. The rule has to strip the first without touching anything else, and the
 * "anything else" cases are the ones that would break streams that were fine.
 */
import { unwrapSegment, wrapperLength } from "~/shared/segments"

let failures = 0

function eq<T>(label: string, actual: T, expected: T) {
    const ok = Object.is(actual, expected)
    if (!ok) failures++
    console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${ok ? "" : ` — got ${String(actual)}`}`)
}

/** `packets` MPEG-TS packets: a sync byte and a filler pattern that is never 0x47. */
function ts(packets: number): Uint8Array {
    const bytes = new Uint8Array(packets * 188)
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 188 === 0 ? 0x47 : (i * 7) % 251
    return bytes
}

function concat(...parts: Uint8Array[]): ArrayBuffer {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let offset = 0
    for (const part of parts) {
        out.set(part, offset)
        offset += part.length
    }
    return out.buffer
}

/** A PNG header of `length` bytes: the signature, then bytes that are not a sync. */
function png(length: number): Uint8Array {
    const bytes = new Uint8Array(length)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    for (let i = 8; i < length; i += 1) bytes[i] = (i * 13) % 250
    return bytes
}

console.log("\n\x1b[1msegments — the measured shape\x1b[0m\n")

{
    const wrapped = concat(png(252), ts(40))
    eq("a 252-byte PNG in front of the packets is found", wrapperLength(new Uint8Array(wrapped)), 252)
    const out = new Uint8Array(unwrapSegment(wrapped))
    eq("and cut off", out.length, 40 * 188)
    eq("leaving the first packet at zero", out[0], 0x47)
    eq("and the second where it belongs", out[188], 0x47)
}

console.log("\n\x1b[1msegments — everything that must be left alone\x1b[0m\n")

{
    const plain = concat(ts(40))
    eq("plain TS needs nothing", wrapperLength(new Uint8Array(plain)), 0)
    eq("and comes back as the same buffer", unwrapSegment(plain), plain)
}

{
    // fMP4: a box size, "ftyp", and bytes that happen to contain sync-spaced
    // 0x47s. Without the image gate this would be cut.
    const bytes = new Uint8Array(2000)
    bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])
    for (let i = 100; i < 2000; i += 188) bytes[i] = 0x47
    eq("fMP4 is not searched, whatever its bytes", wrapperLength(bytes), 0)
}

{
    const image = concat(png(4000))
    eq("an image that never becomes TS is left whole", wrapperLength(new Uint8Array(image)), 0)
    eq("and returned as-is", unwrapSegment(image), image)
}

{
    eq("an empty response is not touched", wrapperLength(new Uint8Array(0)), 0)
    eq("nor one shorter than a signature", wrapperLength(new Uint8Array([0x89, 0x50])), 0)
}

{
    // JPEG-wrapped, at an odd length: the rule reads the bytes, not a constant.
    const wrapped = concat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]), ts(5))
    eq("a JPEG header of a different length is measured, not assumed", wrapperLength(new Uint8Array(wrapped)), 12)
}

{
    // Fewer than three packets after the header: nothing to confirm the
    // spacing against, so the search cannot vouch for an offset.
    const wrapped = concat(png(252), ts(2))
    eq("two packets are not enough to prove a sync", wrapperLength(new Uint8Array(wrapped)), 0)
}

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
