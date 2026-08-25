/**
 * The bits of HLS decryption that are arithmetic rather than I/O.
 *
 * Kept apart from the fetching so they can be checked without a browser: an IV
 * derived one byte wrong produces a file that downloads perfectly, reports
 * success, and plays as noise — a failure with no symptom until someone opens it.
 */

/**
 * The initialisation vector for a segment.
 *
 * HLS states it two ways. An explicit `IV=0x…` on the `#EXT-X-KEY` is used as
 * written; where there is none, the IV is the segment's media sequence number as
 * a 128-bit big-endian integer — which is why the sequence has to be carried
 * this far rather than being an index into an array.
 */
export function ivFor(part: { iv?: string; index: number }): Uint8Array<ArrayBuffer> {
    if (part.iv) return hexToBytes(part.iv)

    const iv = new Uint8Array(16)
    // Big-endian, low byte last. Sequence numbers stay well inside 2^53, so the
    // top eight bytes are only ever zero in practice; they are filled anyway
    // because the spec says the number occupies the whole field.
    let value = Math.trunc(part.index)
    for (let offset = 15; offset >= 8 && value > 0; offset--) {
        iv[offset] = value % 256
        value = Math.floor(value / 256)
    }
    return iv
}

/**
 * `0x…` or bare hex to bytes, padded or truncated to 16.
 *
 * Playlists in the wild write the IV with and without the prefix, in either
 * case, and occasionally with fewer than 32 digits. Left-padding a short one is
 * what every player does.
 */
export function hexToBytes(hex: string, length = 16): Uint8Array<ArrayBuffer> {
    const digits = hex.replace(/^0x/i, "").replace(/[^0-9a-f]/gi, "")
    const padded = digits.padStart(length * 2, "0").slice(-length * 2)

    const bytes = new Uint8Array(length)
    for (let index = 0; index < length; index++) {
        bytes[index] = Number.parseInt(padded.slice(index * 2, index * 2 + 2), 16)
    }
    return bytes
}
