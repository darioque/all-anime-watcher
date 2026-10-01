/**
 * Exercise donghualife.com's payload parsing, and the ASS → WebVTT conversion it
 * brought with it.
 *
 *   npm run check:donghualife
 *
 * The payloads below are cut down from real pages (2026-10-01): a show's page, a
 * watch page and a VIP redirect. What they guard is identity — which season an
 * episode belongs to — because getting that wrong grows a duplicate library
 * entry that never updates, and nothing about it looks broken from outside.
 */
import {
    jsonAt,
    parseEpisodes,
    parseSeasons,
    parseWatchPage,
    rscOf,
    seasonOfUrl,
    seasonTitle,
    seasonUrl,
    showTitleFromPlayer,
    splitWatchSlug,
    watchIdOf
} from "~/sources/sites/donghualife.parse"
import { assToVtt, isAss } from "~/shared/vtt"

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
    const same = JSON.stringify(actual) === JSON.stringify(expected)
    check(label, same, same ? "" : `got ${JSON.stringify(actual)}`)
}

/** Wrap payload text the way Next.js writes it into a page. */
function page(...chunks: string[]): string {
    return `<html><body>${chunks.map(chunk => `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`).join("")}</body></html>`
}

console.log("\n\x1b[1mdonghualife.com payload parsing\x1b[0m\n")

// --- the RSC payload
const split = page(
    '0:{"a":1}\n24:["$","$L28",null,{"seasons":[{"id":"x","slug":"wan-jie-du-zun-1","label":"Temp',
    'orada 1","episodeCount":50}]}]'
)
eq(
    "chunks concatenate before parsing",
    parseSeasons(rscOf(split)).map(s => s.slug),
    ["wan-jie-du-zun-1"]
)
eq("a brace inside a string does not end the value", jsonAt('{"d":"a } b","n":1}', 0), { d: "a } b", n: 1 })
eq("an escaped quote inside a string does not end it", jsonAt('{"d":"say \\"}\\"","n":2}', 0), { d: 'say "}"', n: 2 })

// --- seasons: Wan Jie Du Zun's real shape, plus the empty film placeholder
const show = rscOf(
    page(
        '24:["$","$L28",null,{"seasons":[' +
            '{"id":"a","slug":"wan-jie-du-zun-1","label":"Temporada 1","isSpecial":false,"episodeCount":50,"initialEpisodes":[]},' +
            '{"id":"b","slug":"wan-jie-du-zun-2","label":"Temporada 2","isSpecial":false,"episodeCount":224},' +
            '{"id":"c","slug":"doupo-cangqiong-especial","label":"Especial","isSpecial":true,"episodeCount":2},' +
            '{"id":"d","slug":"29d50e8c-85f6-4c72-8a0b-ebd66d00b72e-peli-ep-151--152","label":"Peli Ep 151- 152","isSpecial":false,"episodeCount":0}' +
            '],"seriesSlug":"wan-jie-du-zun"}]'
    )
)
const seasons = parseSeasons(show)
eq(
    "every non-empty season is offered",
    seasons.map(s => s.slug),
    ["wan-jie-du-zun-1", "wan-jie-du-zun-2", "doupo-cangqiong-especial"]
)
check("a season with no episodes is not something to follow", !seasons.some(s => s.episodeCount === 0))
eq("specials are flagged", seasons.find(s => s.label === "Especial")?.isSpecial, true)

eq("one season: the show's name alone", seasonTitle("Perfect World ", "Temporada 1", 1), "Perfect World")
eq(
    "several: the site's own label goes on",
    seasonTitle("Wan Jie Du Zun", "Temporada 3", 3),
    "Wan Jie Du Zun – Temporada 3"
)

// --- season URLs round-trip, and nothing else yields an id
const stored = seasonUrl(
    "https://donghualife.com",
    "eternal-god-emperor",
    "9796b713-6308-4f48-a6dc-368c11fda2b5-temporada-1"
)
eq("the season survives the round trip", seasonOfUrl(stored), {
    seriesSlug: "eternal-god-emperor",
    seasonSlug: "9796b713-6308-4f48-a6dc-368c11fda2b5-temporada-1"
})
eq("a show's page names no season", seasonOfUrl("https://donghualife.com/series/wan-jie-du-zun"), null)
eq("an episode URL names no season", seasonOfUrl("https://donghualife.com/watch/wan-jie-du-zun-3-211"), null)

// --- watch URLs
eq("number off a season-slug URL", splitWatchSlug("/watch/wan-jie-du-zun-3-211"), {
    prefix: "wan-jie-du-zun-3",
    number: 211
})
eq(
    "number off a UUID-slug URL",
    splitWatchSlug("/watch/9796b713-6308-4f48-a6dc-368c11fda2b5-temporada-1-23")?.number,
    23
)
/*
 * The trap, recorded: this URL is valid and plays season `perfect-world-1`.
 * Its prefix is "perfect-world", which names no season. That is why the source
 * never derives identity from an episode URL.
 */
eq(
    "the series-slug form's prefix is not the season",
    splitWatchSlug("/watch/perfect-world-288")?.prefix,
    "perfect-world"
)
eq("currentId is the last segment", watchIdOf("/watch/perfect-world-288"), "perfect-world-288")

// --- the watch page
const watch = parseWatchPage(
    page(
        '1f:["$","$L1f","e",{"sources":[' +
            '{"id":"e-0","label":"R2","name":"R2","token":"tok-r2","type":"video","provider":"R2","subtitleSupport":"jassub","isWorking":true,"priority":1},' +
            '{"id":"e-1","label":"rumble","name":"rumble","token":"tok-rumble","type":"embed","provider":"rumble","subtitleSupport":"native","isWorking":true,"priority":2}' +
            '],"title":"Wan Jie Du Zun - Capítulo 211","episodeId":"07670060-9d1d-4641-9139-6b0d77e2e831","seriesId":"568c7425"}]\n',
        '2c:["$","$L2c",null,{"episodes":[{"id":"x","number":211,"title":"Capítulo 211","isVipOnly":false,"serverCount":2}],' +
            '"activeEpisodeId":"x","seasonSlug":"wan-jie-du-zun-3","seriesSlug":"wan-jie-du-zun","watchedEpisodeIds":"$W2d",' +
            '"seasons":[{"id":"a","name":"Temporada 1","slug":"wan-jie-du-zun-1","episodes":[]},{"id":"b","name":"Temporada 2","slug":"wan-jie-du-zun-2","episodes":[]},{"id":"c","name":"Temporada 3","slug":"wan-jie-du-zun-3","episodes":[]}],' +
            '"activeSeasonIndex":2,"currentId":"wan-jie-du-zun-3-211"}]'
    )
)
eq("the page states its season", watch.seasonSlug, "wan-jie-du-zun-3")
eq("and its show", watch.seriesSlug, "wan-jie-du-zun")
eq("and which URL it was rendered for", watch.currentId, "wan-jie-du-zun-3-211")
eq(
    "servers, with their tokens",
    watch.sources.map(s => [s.label, s.token, s.subtitleSupport]),
    [
        ["R2", "tok-r2", "jassub"],
        ["rumble", "tok-rumble", "native"]
    ]
)
eq("the episode id rides with the player", watch.episodeId, "07670060-9d1d-4641-9139-6b0d77e2e831")
eq("the show's name, off the player title", showTitleFromPlayer(watch.playerTitle ?? ""), "Wan Jie Du Zun")
eq(
    "seasons listed on the watch page",
    watch.seasons.map(s => s.name),
    ["Temporada 1", "Temporada 2", "Temporada 3"]
)
eq("an ordinary page is not a VIP redirect", watch.vipOnly, false)

const vip = parseWatchPage(page('6:E{"digest":"NEXT_REDIRECT;replace;/vip;307;"}\n'))
eq("a VIP redirect is recognised", vip.vipOnly, true)
eq("and names no season", vip.seasonSlug, null)
eq("and no server", vip.sources.length, 0)

// --- episodes: VIP early access is not out yet
const episodes = parseEpisodes(
    [
        { id: "1", number: 1, title: "Capítulo 1", isVipOnly: false },
        { id: "2", number: 211, title: "Capítulo 211", isVipOnly: false },
        { id: "3", number: 212, title: "Capítulo 212", isVipOnly: true },
        { id: "4", number: 213, title: "Capítulo 213", isVipOnly: true },
        { id: "5", number: 2, title: "El torneo", isVipOnly: false }
    ],
    n => `https://donghualife.com/watch/wan-jie-du-zun-3-${n}`
)
eq(
    "VIP-only posts are dropped, the rest descend",
    episodes.map(e => e.number),
    [211, 2, 1]
)
eq("URLs use the season slug", episodes[0]?.url, "https://donghualife.com/watch/wan-jie-du-zun-3-211")
eq("a title that only restates the number is not kept", episodes[0]?.title, undefined)
eq("a real title is", episodes[1]?.title, "El torneo")

console.log("\n\x1b[1mASS → WebVTT\x1b[0m\n")

// Lines taken from the real Perfect World 288 script.
const ass = `﻿[Script Info]
ScriptType: v4.00+
PlayResX: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cuerpo,Nunito ExtraBold,68,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,1.6,1.6,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:05:08.08,0:05:09.56,Cuerpo,,0,0,110,,Tienen una marca única en el hueso frontal
Dialogue: 0,0:05:05.60,0:05:07.28,Cuerpo,,0,0,110,,Muchos de ellos, al igual que yo
Dialogue: 0,0:05:12.79,0:05:14.64,Nombres,,0,0,0,,{\\pos(389,563)}Cultivador de la familia Jin\\NJin Kun
Dialogue: 0,0:05:20.00,0:05:22.00,Notas,,0,0,0,,{\\an8}Nota: <linaje>
Comment: 0,0:05:30.00,0:05:31.00,Cuerpo,,0,0,0,,not shown
Dialogue: 0,0:05:40.00,0:05:41.00,Cuerpo,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}
`
check("an ASS script is recognised, BOM and all", isAss(ass))
check("WebVTT is not ASS", !isAss("WEBVTT\n\n"))
const vtt = assToVtt(ass)
check("a WebVTT header", vtt.startsWith("WEBVTT\n\n"))
check("cues in time order", vtt.indexOf("Muchos de ellos") < vtt.indexOf("Tienen una marca"))
check("centiseconds become milliseconds", vtt.includes("00:05:05.600 --> 00:05:07.280"))
check("a comma inside the dialogue survives", vtt.includes("Muchos de ellos, al igual que yo"))
check(
    "override blocks are stripped, \\N breaks the line",
    vtt.includes("Cultivador de la familia Jin\nJin Kun") && !vtt.includes("\\pos")
)
check("a top-aligned sign stays at the top", vtt.includes("00:05:20.000 --> 00:05:22.000 line:5%"))
check("angle brackets are escaped, not read as tags", vtt.includes("Nota: &lt;linaje&gt;"))
check("comments are not shown", !vtt.includes("not shown"))
check("drawings are not text", !vtt.includes("m 0 0 l"))

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
