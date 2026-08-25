/**
 * Exercise the playlist host discovery.
 *
 *   npm run check:m3u8
 *
 * The fixtures are the real thing, taken off MegaPlay's CDN: a master playlist
 * whose variants are relative, and a variant whose segments are absolute and on
 * an entirely different domain. That split is the whole reason this code exists.
 */
import { containerFor, isMasterPlaylist, pickVariant, playlistUrls, playlistVariants, readMediaPlaylist } from "~/shared/m3u8"

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

console.log("\n\x1b[1mvariants\x1b[0m\n")

const LADDER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640032,mp4a.40.2",NAME="1080p"
v/1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,NAME="720p"
v/720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,NAME="360p"
v/360/index.m3u8
`

const ladder = playlistVariants(LADDER)
eq("every rendition is found", ladder.length, 3)
eq("with its height", ladder[0]?.height, 1080)
eq("its bandwidth", ladder[0]?.bandwidth, 5_000_000)
eq("and its URL from the following line", ladder[1]?.url, "v/720/index.m3u8")
// CODECS holds a comma inside quotes, which a naive split on "," would cut in half.
eq("a quoted comma does not split an attribute", ladder[0]?.codecs, "avc1.640032,mp4a.40.2")
eq("the I-frame rendition is not a variant", playlistVariants(MASTER).length, 1)

eq("a preference picks that height", pickVariant(ladder, "720p")?.height, 720)
eq("highest picks the top", pickVariant(ladder, "highest")?.height, 1080)
eq("lowest picks the bottom", pickVariant(ladder, "lowest")?.height, 360)
// Falling back *upward* would hand someone a file far larger than they asked for.
eq("a preference above everything on offer falls back downward", pickVariant(ladder, "4320p")?.height, 1080)
eq("and one below everything takes the smallest", pickVariant(ladder, "144p")?.height, 360)
eq("no variants means no choice", pickVariant([], "1080p"), undefined)

console.log("\n\x1b[1mmedia playlists\x1b[0m\n")

const plain = readMediaPlaylist(VARIANT)
eq("segments are read in order", plain.segments.length, 2)
eq("with their durations", plain.segments[0]?.durationSec, 4.004)
eq("and the total", Number(plain.totalDurationSec.toFixed(3)), 9.635)
eq("EXT-X-MEDIA-SEQUENCE sets the first index", plain.segments[0]?.index, 1)
eq("an unencrypted playlist says so", plain.encryption, "none")
// The extension on the segment is a lie told to caches; it is still a .ts stream.
eq("segments named .jpg are still transport stream", containerFor(plain), "ts")

const FMP4 = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.000,
seg-1.m4s
#EXTINF:6.000,
seg-2.m4s
`
const fmp4 = readMediaPlaylist(FMP4)
eq("an initialisation segment is found", fmp4.initUrl, "init.mp4")
eq("and marks the output as mp4", containerFor(fmp4), "mp4")

/*
 * EXT-X-KEY is stateful: it applies to every segment after it until superseded.
 * A mid-playlist rotation is ordinary, and dropping it produces a file that is
 * half video and half noise — which looks like a corrupt download, not a bug.
 */
const ROTATING = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="k1.key",IV=0x00000000000000000000000000000001
#EXTINF:6.000,
a.ts
#EXT-X-KEY:METHOD=AES-128,URI="k2.key"
#EXTINF:6.000,
b.ts
`
const rotating = readMediaPlaylist(ROTATING)
eq("the key in force is attached to each segment", rotating.segments[0]?.key?.uri, "k1.key")
eq("and the rotation is picked up", rotating.segments[1]?.key?.uri, "k2.key")
eq("an explicit IV is kept", rotating.segments[0]?.key?.iv, "0x00000000000000000000000000000001")
eq("and its absence is left for the sequence number", rotating.segments[1]?.key?.iv, undefined)
eq("AES-128 is something we can handle", rotating.encryption, "aes-128")

const CLEARED = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="k.key"
#EXTINF:6.000,
a.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:6.000,
b.ts
`
eq("METHOD=NONE turns encryption back off", readMediaPlaylist(CLEARED).segments[1]?.key, undefined)

// Writing SAMPLE-AES segments out unchanged makes a file that looks complete
// and plays as noise. Refusing is the only honest answer.
const SAMPLE = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k.key"
#EXTINF:6.000,
a.ts
`
eq("a method we cannot decrypt is refused, not attempted", readMediaPlaylist(SAMPLE).encryption, "unsupported")
eq("and names itself", readMediaPlaylist(SAMPLE).encryptionMethod, "SAMPLE-AES")

eq("an empty playlist has no segments", readMediaPlaylist("").segments.length, 0)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
