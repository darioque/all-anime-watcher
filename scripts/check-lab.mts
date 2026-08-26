/**
 * Exercise what the Lab page asserts, without a network.
 *
 *   npm run check:lab
 *
 * The Lab's probes fetch; these decide. Every case below is a fault that has
 * either happened in this repo or would have gone unnoticed if it had: a source
 * giving one series two identities, an episode list handed back in the wrong
 * order, a CDN answering an error page under a 200 because no Referer reached
 * it. A check that only ever runs against a live site is a check nobody can
 * trust — and these are the ones that decide whether a source is healthy.
 */
import {
    checkAttributes,
    checkFetch,
    checkPage,
    checkSearch,
    checkSeries,
    checkServers,
    checkStreams
} from "~/lab/checks"
import type { SourceFacts } from "~/lab/checks"
import type { LabFetchReport, LabSeriesReport } from "~/lab/types"
import type { SearchResult } from "~/sources/types"
import type { Episode } from "~/model/types"

let failures = 0

function eq<T>(label: string, actual: T, expected: T) {
    const ok = Object.is(actual, expected)
    if (!ok) failures++
    console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${ok ? "" : ` — got ${String(actual)}`}`)
}

function says(label: string, note: string, fragment: string) {
    const ok = note.toLowerCase().includes(fragment.toLowerCase())
    if (!ok) failures++
    console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${ok ? "" : ` — said "${note}"`}`)
}

const source: SourceFacts = {
    id: "anikoto",
    name: "Anikoto",
    domains: ["anikoto.to"],
    home: "https://anikoto.to/",
    languages: ["en"],
    enabled: true
}

const hit = (over: Partial<SearchResult> = {}): SearchResult => ({
    title: "Xian Ni",
    url: "https://anikoto.to/watch/xian-ni",
    seriesId: "xian-ni",
    ...over
})

const ep = (number: number, url = `https://anikoto.to/watch/xian-ni/ep-${number}`): Episode => ({ number, url })

const series = (over: Partial<LabSeriesReport> = {}): LabSeriesReport => ({
    seriesId: "xian-ni",
    info: { title: "Xian Ni", seriesId: "xian-ni", url: "https://anikoto.to/watch/xian-ni" },
    episodeCount: 3,
    numbers: [3, 2, 1],
    first: [ep(3)],
    last: [ep(1)],
    episodePattern: "^/watch/[^/]+/ep-[\\d.]+",
    ...over
})

console.log("\n\x1b[1msource attributes\x1b[0m\n")

eq("a complete source passes", checkAttributes(source).ok, true)
eq("one with no domains cannot be matched at all", checkAttributes({ ...source, domains: [] }).ok, false)
says("and says which attribute is missing", checkAttributes({ ...source, languages: [] }).note, "languages")
eq("a home that is not a URL fails", checkAttributes({ ...source, home: "anikoto" }).ok, false)

// Not a failure — a source is allowed to have moved — but it must be said,
// because the configured home is what every relative URL is resolved against.
const moved = checkAttributes({ ...source, home: "https://anikoto.se/" })
eq("a home outside the domain list still passes", moved.ok, true)
eq("but warns about it", moved.warnings?.length ?? 0, 1)

console.log("\n\x1b[1msearch\x1b[0m\n")

eq("results with ids and titles pass", checkSearch("xian ni", [hit()], source).ok, true)
eq("no results at all fails", checkSearch("xian ni", [], source).ok, false)

// The key is built from the id. A result without one cannot become a library
// entry however good it looks in the list.
eq("a result with no seriesId fails", checkSearch("x", [hit({ seriesId: "" })], source).ok, false)

// A relative URL that was never made absolute: fetched later, elsewhere, with
// an error that names the URL rather than the mistake.
const offsite = checkSearch("x", [hit({ url: "https://cdn.example/img.png" })], source)
eq("an off-site result URL is only a warning", offsite.ok, true)
says("which names the host", offsite.warnings?.[0] ?? "", "cdn.example")

console.log("\n\x1b[1mseries and episodes\x1b[0m\n")

eq("a descending list passes", checkSeries(series(), { seriesId: "xian-ni" }).ok, true)
eq("an empty one fails", checkSeries(series({ episodeCount: 0, numbers: [] }), { seriesId: "xian-ni" }).ok, false)

/*
 * The ordering contract. Element 0 is read as the newest episode everywhere —
 * by the scheduler deciding what is new, by the player deciding what is next,
 * by the library deciding whether you are caught up. Reversed, all three are
 * wrong and none of them says so.
 */
const ascending = checkSeries(series({ numbers: [1, 2, 3], first: [ep(1)], last: [ep(3)] }), { seriesId: "xian-ni" })
eq("an ascending list fails", ascending.ok, false)
says("and is named as ascending", ascending.note, "ascending")

const scrambled = checkSeries(series({ numbers: [3, 1, 2] }), { seriesId: "xian-ni" })
eq("so does a scrambled one", scrambled.ok, false)
says("described as unordered rather than reversed", scrambled.note, "not in order")

/*
 * Two identities for one series. Search says one id and the series URL derives
 * another, so the library grows a second entry that never updates — and the
 * only visible symptom is a series that stopped getting episodes.
 */
const drifted = checkSeries(series({ seriesId: "xian-ni-2023" }), { seriesId: "xian-ni" })
eq("a series id that disagrees with search fails", drifted.ok, false)
says("naming both", drifted.note, "xian-ni-2023")

/*
 * Episode URLs that the source's own episodeUrl pattern does not match: click
 * one and the extension never recognises the page it lands on, however
 * correctly everything upstream parsed.
 */
const unroutable = checkSeries(series({ first: [ep(3, "https://anikoto.to/e/9999")] }), { seriesId: "xian-ni" })
eq("episode URLs that do not match the source's own pattern fail", unroutable.ok, false)

console.log("\n\x1b[1mepisode page\x1b[0m\n")

const page = {
    isEpisode: true,
    pageInfo: {
        title: "Xian Ni",
        seriesId: "xian-ni",
        seriesUrl: "https://anikoto.to/watch/xian-ni",
        number: 3
    },
    servers: [{ name: "Vidstream" }]
}

eq("a readable page with servers passes", checkPage(page, { seriesId: "xian-ni", number: 3 }).ok, true)
eq("a page with no servers fails", checkPage({ ...page, servers: [] }, { seriesId: "xian-ni", number: 3 }).ok, false)
eq("an unrecognised page fails", checkPage({ isEpisode: false }, { seriesId: "xian-ni", number: 3 }).ok, false)

// The identity check from the other side, and the one that bites: this is the
// id the content script keys the library on, so a disagreement here is what
// makes an already-followed series offer to be followed again.
const mismatch = checkPage(
    { ...page, pageInfo: { ...page.pageInfo, seriesId: "xian-ni-dub" } },
    { seriesId: "xian-ni", number: 3 }
)
eq("an episode page under a different series id fails", mismatch.ok, false)
says("naming the id the page gave", mismatch.note, "xian-ni-dub")

eq(
    "an episode numbered differently from its list entry fails",
    checkPage(page, { seriesId: "xian-ni", number: 4 }).ok,
    false
)

console.log("\n\x1b[1mstreams\x1b[0m\n")

const resolved = {
    embedUrl: "https://megaplay.buzz/stream/s-2/1/sub",
    extractorId: "megaplay",
    streams: [{ url: "https://cdn.example/master.m3u8", kind: "hls" as const }]
}

eq("an extracted stream passes", checkStreams(resolved).ok, true)
eq("nothing at all fails", checkStreams({ ...resolved, streams: [] }).ok, false)

/*
 * The quiet one. An iframe result is the "no extractor claims this host"
 * fallback: it plays, so nothing looks wrong, while progress tracking, the
 * quality picker and downloads are all silently gone.
 */
const fallback = checkStreams({
    embedUrl: "https://unknown.host/e/1",
    extractorId: null,
    streams: [{ url: "https://unknown.host/e/1", kind: "iframe" as const }]
})
eq("an iframe fallback is a failure, not a pass", fallback.ok, false)
says("naming the host nothing claims", fallback.note, "unknown.host")

console.log("\n\x1b[1mall the servers, not the first one\x1b[0m\n")

const dead = {
    embedUrl: "https://bysekoze.com/e/afl6vo7sypot",
    extractorId: null,
    streams: [{ url: "https://bysekoze.com/e/afl6vo7sypot", kind: "iframe" as const }],
    error: "streamwish: no playlist in the player"
}

/*
 * The case that prompted this. mundodonghua lists "Fm" first and "Vh" second;
 * Fm was falling back to an iframe while Vh played perfectly. Stopping at the
 * first server called a working source broken — and said nothing about the one
 * that worked.
 */
const mixed = checkServers([
    { server: "Fm", resolved: dead },
    { server: "Vh", resolved: resolved }
])
eq("one working server is a pass", mixed.ok, true)
says("naming the server that works and its extractor", mixed.note, "Vh → megaplay")
eq("with the dead one kept as a warning", mixed.warnings?.length, 1)
says("carrying the reason it died", mixed.warnings?.[0] ?? "", "no playlist in the player")

/*
 * And the reverse, which is the failure that had gone unnoticed: every server
 * falls back to an iframe, so the episode still plays and nothing looks wrong,
 * while progress, the quality picker and downloads are all quietly gone.
 */
const allIframes = checkServers([
    { server: "Fm", resolved: dead },
    { server: "Vh", resolved: { ...dead, embedUrl: "https://other.host/e/2" } }
])
eq("every server on an iframe is a failure", allIframes.ok, false)
says("said as a count rather than one host", allIframes.note, "2")

eq("a probe that threw is a dead server too", checkServers([{ server: "Fm", thrown: "unknown source" }]).ok, false)
eq("and no servers at all cannot pass", checkServers([]).ok, false)

console.log("\n\x1b[1mthe fetch the CLI cannot make\x1b[0m\n")

const fetched = (over: Partial<LabFetchReport> = {}): LabFetchReport => ({
    url: "https://cdn.example/master.m3u8",
    status: 200,
    ok: true,
    bytes: 812,
    contentType: "application/vnd.apple.mpegurl",
    kind: "master playlist",
    entries: 4,
    head: "#EXTM3U",
    ...over
})

eq("a master playlist with variants passes", checkFetch(fetched(), { playlist: true }).ok, true)
eq("a 403 fails", checkFetch(fetched({ status: 403, ok: false }), { playlist: true }).ok, false)
eq("an empty playlist fails", checkFetch(fetched({ entries: 0 }), { playlist: true }).ok, false)

/*
 * The MegaPlay failure, exactly as it appeared: HTTP 200, a plausible length,
 * and a body that is not a playlist — because Referer is a forbidden header
 * name in a browser and only a declarativeNetRequest rule can supply it. Node's
 * fetch sets it happily, which is why every CLI probe called the extractor
 * healthy while nothing played.
 */
const errorPage = checkFetch(
    fetched({ kind: "not a playlist", entries: 0, contentType: "text/html", head: "<!doctype html>" }),
    { playlist: true }
)
eq("a 200 carrying an error page fails", errorPage.ok, false)
says("and points at the missing header", errorPage.note, "referer")

// A progressive file is not a playlist and must not be judged as one: only the
// first slice was requested, so the test is that video came back at all.
eq(
    "a partial MP4 response passes when no playlist was expected",
    checkFetch(fetched({ status: 206, kind: "not a playlist", entries: 0, contentType: "video/mp4" }), {
        playlist: false
    }).ok,
    true
)
eq(
    "but HTML in place of the file does not",
    checkFetch(fetched({ status: 200, kind: "not a playlist", entries: 0, contentType: "text/html" }), {
        playlist: false
    }).ok,
    false
)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
