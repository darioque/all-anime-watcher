/**
 * Exercise the download filename builder.
 *
 *   npm run check:downloads
 *
 * `chrome.downloads.download` refuses a filename it dislikes with one opaque
 * error and no hint which character it objected to, so every way a name can be
 * illegal has to be handled before it gets there. The rules followed are
 * Windows' rather than Linux's: download folders live on shared and synced
 * drives, and a name that is fine here and fatal there fails later, on someone
 * else's machine, with no clue why.
 */
import { fileNameFor, formatEpisode } from "~/downloads/naming"
import { hexToBytes, ivFor } from "~/downloads/hls"
import { chooseTracks, sidecarNames, subtitleFormat } from "~/downloads/subtitles"

let failures = 0

function eq(label: string, actual: unknown, expected: unknown) {
    const ok = Object.is(actual, expected)
    if (!ok) failures++
    console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${ok ? "" : ` — got ${String(actual)}`}`)
}

const DEFAULT = "{title}/{title} - E{ep}.{ext}"
const base = { title: "Xian Ni", number: 47, ext: "mp4" }

console.log("\n\x1b[1mepisode numbers\x1b[0m\n")

// Two digits so a file manager sorts E9 before E10 rather than after it.
eq("single digits are padded", formatEpisode(9), "09")
eq("two digits are left alone", formatEpisode(47), "47")
eq("and three are not truncated", formatEpisode(476), "476")
eq("zero is a real episode number", formatEpisode(0), "00")
// Recaps and specials really are published as 13.5.
eq("a fraction keeps its decimal", formatEpisode(13.5), "13.5")
eq("and is padded on the whole part", formatEpisode(1.5), "01.5")
eq("floating point noise is not carried through", formatEpisode(0.1 + 0.2), "00.3")

console.log("\n\x1b[1mthe default template\x1b[0m\n")

eq("makes a folder per series", fileNameFor(DEFAULT, base), "Xian Ni/Xian Ni - E47.mp4")
eq(
    "and every placeholder is available",
    fileNameFor("{source}/{title} {quality} {variant} E{ep}.{ext}", {
        ...base,
        source: "lmanime",
        quality: "1080p",
        variant: "sub"
    }),
    "lmanime/Xian Ni 1080p sub E47.mp4"
)
// A gap says nothing; the misspelling says what to fix.
eq("an unknown placeholder is left visible", fileNameFor("{titel}-{ep}.{ext}", base), "{titel}-47.mp4")
// A dangling separator reads as a title that got cut off, not as a field that
// was not there.
eq("an empty field takes its separator with it", fileNameFor("{title} {quality}.{ext}", base), "Xian Ni.mp4")
eq("including a dash", fileNameFor("{title} - {quality}.{ext}", base), "Xian Ni.mp4")
eq("and a whole path segment", fileNameFor("{source}/{title}.{ext}", base), "Xian Ni.mp4")
eq(
    "while a present field keeps it",
    fileNameFor("{title} - {quality}.{ext}", { ...base, quality: "1080p" }),
    "Xian Ni - 1080p.mp4"
)

console.log("\n\x1b[1mnames a filesystem would refuse\x1b[0m\n")

/*
 * The one that matters most: a slash inside a *title* is not a folder boundary.
 * "Fate/Zero" would otherwise silently become a directory called Fate, and the
 * series would scatter across two places in the download folder.
 */
eq(
    "a slash in the title does not become a folder",
    fileNameFor(DEFAULT, { ...base, title: "Fate/Zero" }),
    "Fate-Zero/Fate-Zero - E47.mp4"
)
eq(
    "characters Windows forbids are replaced",
    fileNameFor("{title}.{ext}", { ...base, title: 'A<B>C:D"E|F?G*H' }),
    "A-B-C-D-E-F-G-H.mp4"
)
eq(
    "control characters go too",
    fileNameFor("{title}.{ext}", { ...base, title: "Tab\there\nand newline" }),
    "Tab-here-and newline.mp4"
)
// Windows strips these silently, so the same library on two machines would stop
// matching — one has "Series" and the other "Series .".
eq("a trailing dot is removed", fileNameFor("{title}.{ext}", { ...base, title: "Series ." }), "Series.mp4")
eq("as is a trailing space", fileNameFor("{title}/x.{ext}", { ...base, title: "Series " }), "Series/x.mp4")
// "CON.mp4" is as unwritable as "CON" — the extension does not rescue it.
eq("a reserved device name is escaped", fileNameFor("{title}.{ext}", { ...base, title: "CON" }), "_CON.mp4")
eq("in any case", fileNameFor("{title}.{ext}", { ...base, title: "nul" }), "_nul.mp4")
eq(
    "but a name merely starting with one is fine",
    fileNameFor("{title}.{ext}", { ...base, title: "Console" }),
    "Console.mp4"
)

console.log("\n\x1b[1mpaths\x1b[0m\n")

eq("a traversal attempt is dropped, not escaped", fileNameFor("../../{title}.{ext}", base), "Xian Ni.mp4")
eq("a leading slash does not make it absolute", fileNameFor("/{title}.{ext}", base), "Xian Ni.mp4")
eq("empty segments collapse", fileNameFor("{title}//x.{ext}", base), "Xian Ni/x.mp4")
eq(
    "a template that sanitises away still yields a file",
    fileNameFor("{unknownfield}", { ...base, ext: "ts" }),
    "{unknownfield}"
)
eq("an entirely empty template falls back", fileNameFor("", base), "episode.mp4")

const long = "A".repeat(300)
const truncated = fileNameFor("{title}.{ext}", { ...base, title: long })
eq("an absurd title is cut", truncated.length <= 120, true)
// A truncated ".mp4" is a file nothing will open.
eq("but the extension survives the cut", truncated.endsWith(".mp4"), true)

console.log("\n\x1b[1mextensions\x1b[0m\n")

eq("a leading dot on ext is not doubled", fileNameFor("{title}.{ext}", { ...base, ext: ".mkv" }), "Xian Ni.mkv")
// The container is what the segments actually are, not what we wish they were.
eq("transport stream is named as such", fileNameFor("{title}.{ext}", { ...base, ext: "ts" }), "Xian Ni.ts")

console.log("\n\x1b[1mHLS decryption vectors\x1b[0m\n")

/*
 * An IV derived one byte wrong produces a file that downloads perfectly, reports
 * success and plays as noise — a failure with no symptom until someone opens the
 * file, possibly weeks later. Hence spelling the expected bytes out.
 */
const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("")

eq(
    "an explicit IV is used as written",
    hex(ivFor({ iv: "0x0123456789abcdef0123456789abcdef", index: 7 })),
    "0123456789abcdef0123456789abcdef"
)
eq(
    "the 0x prefix is optional",
    hex(ivFor({ iv: "0123456789ABCDEF0123456789ABCDEF", index: 0 })),
    "0123456789abcdef0123456789abcdef"
)

// With no IV stated, the segment's media sequence number is the IV, as a
// 128-bit big-endian integer — which is why the sequence is carried through the
// playlist reader rather than being an index into an array.
eq("no IV means the sequence number, big-endian", hex(ivFor({ index: 1 })), "00000000000000000000000000000001")
eq("and it is genuinely big-endian", hex(ivFor({ index: 256 })), "00000000000000000000000000000100")
eq("sequence 0 is all zeroes", hex(ivFor({ index: 0 })), "00000000000000000000000000000000")
eq("a large sequence still fits", hex(ivFor({ index: 0x0102_0304 })), "00000000000000000000000001020304")

eq("the IV is always sixteen bytes", ivFor({ index: 5 }).length, 16)
eq("even from a short hex string", hex(hexToBytes("0x1")), "00000000000000000000000000000001")
eq("and an over-long one keeps its last sixteen bytes", hex(hexToBytes(`0x${"ab".repeat(20)}`)), "ab".repeat(16))

console.log("\n\x1b[1msubtitle sidecars\x1b[0m\n")

const en = { url: "https://cdn/en.vtt", label: "English", language: "en" }
const es = { url: "https://cdn/es.vtt", label: "Spanish", language: "es" }
const unlabelled = { url: "https://cdn/sub.vtt", label: "Default" }
const tracksOf = (picked: { url: string }[]) => picked.map(track => track.url).join(" ")

eq("preferred keeps the matching language", tracksOf(chooseTracks([en, es], "preferred", ["en"])), en.url)
eq(
    "a label alone is enough to match",
    tracksOf(chooseTracks([{ ...en, language: undefined }, es], "preferred", ["en"])),
    en.url
)
eq("three-letter tags match too", tracksOf(chooseTracks([{ ...en, language: "eng" }, es], "preferred", ["en"])), en.url)
// The point of the fallback: a server with one unlabelled track still gets it saved.
eq("no match falls back to every track", tracksOf(chooseTracks([unlabelled], "preferred", ["en"])), unlabelled.url)
eq("all is all", tracksOf(chooseTracks([en, es], "all", ["en"])), `${en.url} ${es.url}`)
eq("off is nothing", chooseTracks([en, es], "off", ["en"]).length, 0)

eq("WebVTT is recognised", subtitleFormat("WEBVTT\n\n00:00.000 --> 00:01.000\nhi"), "vtt")
eq("ASS stays ASS", subtitleFormat("\ufeff[Script Info]\nTitle: x"), "ass")
eq("anything else is SubRip", subtitleFormat("1\n00:00:00,000 --> 00:00:01,000\nhi"), "srt")

const video = "Solo Leveling/Solo Leveling - E08.ts"
eq(
    "named after the video, tagged by language",
    sidecarNames(video, [{ track: en, format: "ass" }]).join(),
    "Solo Leveling/Solo Leveling - E08.en.ass"
)
eq(
    "two tracks in one language keep apart by label",
    sidecarNames(video, [
        { track: { ...en, label: "Full" }, format: "ass" },
        { track: { ...en, label: "Signs" }, format: "ass" }
    ]).join(" | "),
    "Solo Leveling/Solo Leveling - E08.en.Full.ass | Solo Leveling/Solo Leveling - E08.en.Signs.ass"
)
eq(
    "identical tracks still never collide",
    new Set(
        sidecarNames(video, [
            { track: en, format: "vtt" },
            { track: en, format: "vtt" }
        ])
    ).size,
    2
)
eq(
    "no language falls back to the label",
    sidecarNames(video, [{ track: unlabelled, format: "vtt" }]).join(),
    "Solo Leveling/Solo Leveling - E08.Default.vtt"
)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
