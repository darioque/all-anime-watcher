/**
 * Minimal HLS playlist reading, kept free of transport so it can be tested.
 *
 * Not a parser — hls.js does the real work. This exists to answer one question
 * the background needs before playback starts: which *hosts* does this playlist
 * refer to? A manifest and its segments are routinely served from unrelated
 * domains, and a header rewrite installed for only the manifest's host gets the
 * manifest and none of the video.
 */

/** True for a master playlist — one that names variants rather than segments. */
export function isMasterPlaylist(text: string): boolean {
    return /#EXT-X-STREAM-INF/.test(text)
}

/**
 * Every URL the playlist refers to, in the order it names them.
 *
 * Bare lines are the obvious ones. The rest hide in `URI="…"` attributes:
 * `#EXT-X-MEDIA` for alternate audio and subtitles, `#EXT-X-KEY` for the
 * decryption key, `#EXT-X-I-FRAME-STREAM-INF` for the trick-play playlist. A key
 * that fails to load is an encrypted stream that never plays, so missing those
 * is not a cosmetic gap.
 *
 * Returned as written: relative entries stay relative, and resolving them is the
 * caller's job because only it knows the playlist's own URL.
 */
export function playlistUrls(text: string): string[] {
    const found: string[] = []

    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed === "") continue

        if (!trimmed.startsWith("#")) {
            found.push(trimmed)
            continue
        }

        for (const match of trimmed.matchAll(/URI="([^"]+)"/g)) {
            if (match[1]) found.push(match[1])
        }
    }

    return found
}
