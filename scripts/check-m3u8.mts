/**
 * Exercise the playlist host discovery.
 *
 *   npm run check:m3u8
 *
 * The fixtures are the real thing, taken off MegaPlay's CDN: a master playlist
 * whose variants are relative, and a variant whose segments are absolute and on
 * an entirely different domain. That split is the whole reason this code exists.
 */
import { isMasterPlaylist, playlistUrls } from "~/shared/m3u8"

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

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1090856,RESOLUTION=1920x1080,FRAME-RATE=23.974,CODECS="avc1.640032,mp4a.40.2"
index-f1-v1-a1.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=36125,RESOLUTION=640x360,CODECS="avc1.64001e",URI="iframes-f3-v1-a1.m3u8"
`

const VARIANT = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:1
#EXT-X-TARGETDURATION:12
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:4.004,
https://cr0x1.cloudvideo.lat/anime/aaa/bbb/seg-1-f1-v1-a1.jpg
#EXTINF:5.631,
https://cr0x1.cloudvideo.lat/anime/aaa/bbb/seg-2-f1-v1-a1.html
#EXT-X-ENDLIST
`

console.log("\n\x1b[1mHLS playlist reading\x1b[0m\n")

check("a master playlist is recognised", isMasterPlaylist(MASTER))
check("a variant is not", !isMasterPlaylist(VARIANT))

const fromMaster = playlistUrls(MASTER)
eq("the master's variant is found", fromMaster[0], "index-f1-v1-a1.m3u8")
check(
    "and so is the one hidden in an attribute",
    fromMaster.includes("iframes-f3-v1-a1.m3u8"),
    "I-frame playlists live in URI=, not on a line of their own"
)

const fromVariant = playlistUrls(VARIANT)
eq("segments are found", fromVariant.length, 2)
check(
    "including their host, which is not the playlist's",
    new URL(fromVariant[0]!).hostname === "cr0x1.cloudvideo.lat",
    "this split is what a manifest-only rewrite misses"
)

// Relative entries are returned as written: only the caller knows the base.
check("relative entries are left alone", playlistUrls("#EXTM3U\nseg-1.ts\n")[0] === "seg-1.ts")

/*
 * An encryption key is a URL like any other, and one that fails to load is a
 * stream that never plays — so it has to be covered by the same rewrite.
 */
const ENCRYPTED = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.test/k",IV=0x0
#EXTINF:4,
seg-1.ts
`
check("the decryption key counts too", playlistUrls(ENCRYPTED).includes("https://keys.example.test/k"))

/*
 * Alternate audio and subtitle renditions are named the same way, and an audio
 * track on a third host is exactly the case that plays video with no sound.
 */
const MULTI = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Japanese",URI="https://audio.example.test/a.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"
v.m3u8
`
check("so do alternate renditions", playlistUrls(MULTI).includes("https://audio.example.test/a.m3u8"))

eq("an empty playlist yields nothing", playlistUrls("").length, 0)
eq("comments alone yield nothing", playlistUrls("#EXTM3U\n#EXT-X-VERSION:3\n").length, 0)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
