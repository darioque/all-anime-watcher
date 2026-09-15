/**
 * Segments that arrive dressed as something else.
 *
 * Some CDNs will not host video, so a host stores each MPEG-TS segment on one as
 * an image: a real image header glued to the front of the packets, served with
 * `image/png`, named `.png`. MegaPlay's "HD-1" CDN is TikTok's image CDN with a
 * 252-byte PNG in front of every segment, and its own player strips it in an
 * XMLHttpRequest hook. Handed to hls.js as-is, the segment fails demuxing —
 * `fragParsingError`, which reads as a codec problem — and three retries later
 * the server is condemned.
 *
 * Pure, and in `shared/` because two things read segment bytes: the player's
 * fragment loader and the offscreen downloader. A file written with the
 * headers left in plays as badly as a stream does.
 */

/** An MPEG-TS packet is 188 bytes and begins with this. */
const TS_SYNC = 0x47
const TS_PACKET = 188

/**
 * How far into a segment to look for the packets. The known wrapper is 252
 * bytes; a decoy that is a genuine small image is a few kilobytes. Past this a
 * segment is simply not TS.
 */
const SEARCH_LIMIT = 64 * 1024

/**
 * Signatures worth looking past. The search is gated on these because it is
 * not free of false positives: three sync bytes at packet spacing occur by
 * chance somewhere in an fMP4 segment often enough to matter, and cutting the
 * front off one of those would break a stream that was fine.
 */
const IMAGE_SIGNATURES: readonly (readonly number[])[] = [
    [0x89, 0x50, 0x4e, 0x47], // PNG
    [0xff, 0xd8, 0xff], // JPEG
    [0x47, 0x49, 0x46, 0x38], // GIF8
    [0x52, 0x49, 0x46, 0x46], // RIFF, which is how WebP starts
    [0x42, 0x4d] // BM
]

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
    if (bytes.length < signature.length) return false
    return signature.every((byte, index) => bytes[index] === byte)
}

function syncAt(bytes: Uint8Array, offset: number): boolean {
    return (
        bytes[offset] === TS_SYNC && bytes[offset + TS_PACKET] === TS_SYNC && bytes[offset + 2 * TS_PACKET] === TS_SYNC
    )
}

/**
 * Where the MPEG-TS packets begin in a segment that starts with an image
 * header, or `0` for a segment that needs nothing done — including one that
 * starts with an image and never turns into TS, which is left alone rather than
 * guessed at.
 */
export function wrapperLength(bytes: Uint8Array): number {
    if (syncAt(bytes, 0)) return 0
    if (!IMAGE_SIGNATURES.some(signature => startsWith(bytes, signature))) return 0

    const limit = Math.min(SEARCH_LIMIT, bytes.length - 2 * TS_PACKET)
    for (let offset = 1; offset <= limit; offset += 1) {
        if (syncAt(bytes, offset)) return offset
    }
    return 0
}

/** The segment with any image wrapper removed. The same buffer back when there is none. */
export function unwrapSegment(buffer: ArrayBuffer): ArrayBuffer {
    const skip = wrapperLength(new Uint8Array(buffer))
    return skip === 0 ? buffer : buffer.slice(skip)
}
