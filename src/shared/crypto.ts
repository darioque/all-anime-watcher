/**
 * RC4.
 *
 * Not used for anything secret — several sites use it as light obfuscation on
 * their own API parameters, with the key sitting in their front-end bundle. It
 * lives here rather than in one source because that pattern recurs.
 */
export function rc4(key: string, data: Uint8Array): Uint8Array {
    const s = new Uint8Array(256)
    for (let i = 0; i < 256; i++) s[i] = i

    const keyBytes = new TextEncoder().encode(key)
    for (let i = 0, j = 0; i < 256; i++) {
        j = (j + s[i]! + keyBytes[i % keyBytes.length]!) % 256
        ;[s[i], s[j]] = [s[j]!, s[i]!]
    }

    const out = new Uint8Array(data.length)
    for (let n = 0, i = 0, j = 0; n < data.length; n++) {
        i = (i + 1) % 256
        j = (j + s[i]!) % 256
        ;[s[i], s[j]] = [s[j]!, s[i]!]
        out[n] = data[n]! ^ s[(s[i]! + s[j]!) % 256]!
    }
    return out
}

/** RC4 a string and base64 the result, matching JS `btoa(rc4(key, value))`. */
export function rc4ToBase64(key: string, value: string): string {
    const encrypted = rc4(key, new TextEncoder().encode(value))
    let binary = ""
    for (const byte of encrypted) binary += String.fromCharCode(byte)
    return btoa(binary)
}

/** Inverse of `rc4ToBase64`. Tolerates the unpadded base64 sites often emit. */
export function base64ToRc4(key: string, value: string): string {
    const padded = value + "=".repeat((4 - (value.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(rc4(key, bytes))
}
