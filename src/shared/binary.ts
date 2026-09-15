/**
 * Binary payloads over extension messaging.
 *
 * Chrome serialises `runtime.sendMessage` payloads as JSON, not structured
 * clone — an ArrayBuffer arrives at the other end as `{}`. That silently fed
 * hls.js empty fragments and surfaced as `fragParsingError`, which looks like a
 * codec problem and is really a transport one.
 *
 * Base64 is the portable answer. It costs 33% in size and a copy at each end,
 * which is acceptable for the proxy path — used only where a CDN refuses to
 * serve the page directly.
 */

const CHUNK = 0x8000

export function bufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    let binary = ""
    // Chunked: String.fromCharCode(...bytes) blows the call stack past ~100KB,
    // and a video fragment is measured in megabytes.
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
}

export function base64ToBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes.buffer
}

/**
 * base64url, the `-_` alphabet without padding, as web APIs and hosts that sign
 * things tend to write it. Decoding it as plain base64 goes wrong from the first
 * `-` onwards, silently.
 */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
    const binary = atob(padded)

    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
}

export function toBase64Url(bytes: Uint8Array): string {
    let binary = ""
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
