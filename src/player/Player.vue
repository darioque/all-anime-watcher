<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import Hls from "hls.js"
import type { Level } from "hls.js"
import { send } from "~/shared/messages"
import type { PageIdentity } from "~/shared/messages"
import type { Server } from "~/sources/types"
import type { Episode, TrackedAnime } from "~/model/types"
import { progressKey, resumePositionFor } from "~/model/keys"
import { automaticCategoriesOf, categoriesOf } from "~/library/categories"
import type { Category, SourceCategories } from "~/library/categories"
import type { Stream } from "~/extractors/types"
import { decideFatal, fatalKind, MAX_RECOVERIES, STARTED_AFTER_SEC } from "~/shared/playback"
import { BackgroundLoader } from "./backgroundLoader"
import { unwrapping } from "./unwrappingLoader"
import { loadTrack, releaseTracks, type LoadedTrack } from "./subtitles"

const props = defineProps<{
    identity: PageIdentity
    progressTickSec: number
    seekStepSec: number
    /** Percentage, 0–100. */
    defaultVolume: number
    preferredQuality: string
    autoAdvance: boolean
    skipIntro: "off" | "button" | "auto"
    skipOutro: "off" | "button" | "auto"
    /**
     * Tell the content script we changed the URL ourselves.
     *
     * Without it the background sees a history event, calls the route hook, and
     * the content script re-identifies the page — reading the DOM we have already
     * replaced with the player, and finding no episode in it.
     */
    onAdoptUrl?: (url: string) => void
}>()

const video = ref<HTMLVideoElement | null>(null)
/** The picture and everything drawn over it — the thing F makes fullscreen. */
const stage = ref<HTMLElement | null>(null)
const hls = shallowRef<Hls | null>(null)

const status = ref<"idle" | "resolving" | "ready" | "error">("idle")
const message = ref("")
/**
 * The episode being played *now*.
 *
 * A ref rather than the prop, because moving to the next episode no longer means
 * loading a page — the player swaps identity in place and everything downstream
 * has to follow it. The prop is only the starting point.
 */
const current = ref<PageIdentity>(props.identity)
const servers = ref<Server[]>(props.identity.servers ?? [])
const activeServer = ref<number>(-1)
/** Servers that already failed this session, so fallback doesn't loop over them. */
const failedServers = ref(new Set<number>())

/*
 * Recovery bookkeeping for the stream attached right now.
 *
 * Plain `let`s rather than refs: nothing renders them, and a ref that nothing
 * renders is a ref that will eventually be read one tick late. The rule that
 * consumes them is `decideFatal` in `~/shared/playback`, which is where the
 * reasoning lives; these are only the three facts it cannot work out for itself.
 */

/** When the current stream first showed a picture. 0 while it never has. */
let streamPlayingSince = 0
/** Recoveries spent on the current stream since the last time it settled. */
let recoveries = 0
/** When the last recovery was attempted, so a clean run can earn the budget back. */
let lastRecoveryAt = 0
/**
 * Where the picture was when the stream we just left stopped.
 *
 * `restorePosition` otherwise asks the library, which is the right source on a
 * fresh page load and the wrong one here: an unfollowed series has no stored
 * progress at all, so changing server mid-episode dropped the viewer back to
 * the start of it.
 */
let resumeAt: number | null = null

/** Seconds the current stream has been showing a picture. */
function playedOnStream(): number {
    return streamPlayingSince === 0 ? 0 : (Date.now() - streamPlayingSince) / 1000
}

/**
 * The stream is showing a picture.
 *
 * This one flag is what separates "this server cannot play" from "this server
 * hiccuped", and every fatal error is read differently on either side of it.
 */
function onPlaying() {
    if (streamPlayingSince === 0) streamPlayingSince = Date.now()
}

function rememberPosition() {
    const at = video.value?.currentTime
    if (typeof at === "number" && Number.isFinite(at) && at > 0) resumeAt = at
}
/**
 * Whether this episode's on-open mark has been spent.
 *
 * Reset per episode, because the in-place swap keeps the component alive across
 * several of them. Not an optimisation — `markWatchedHere` is cheap and the
 * library ignores a repeat — but the flag is what makes "mark once, at the first
 * moment there is a picture" a statement about the episode rather than about
 * whichever code path happened to reach it first.
 */
const openMarkSpent = ref(props.identity.markedOnOpen === true)
const levels = ref<Level[]>([])
const currentLevel = ref(-1)
const streamLabel = ref("")
/** Set while playing a host's own embed rather than a stream we extracted. */
const embedded = ref<string | null>(null)
/** Best embed seen while walking servers, used only if nothing extractable works. */
const embedFallback = ref<{ stream: Stream; index: number } | null>(null)

/** Intro/outro offsets: from the site if it publishes them, else AniSkip. */
const skips = ref<{ intro?: { startSec: number; endSec: number }; outro?: { startSec: number; endSec: number } }>({})
/** Which span the playhead is inside right now, if any. */
const inSkip = ref<"intro" | "outro" | null>(null)
/** Spans already skipped this episode, so an auto-skip doesn't fight a rewind. */
const skipped = ref(new Set<string>())

const subtitles = ref<LoadedTrack[]>([])
const activeSubtitle = ref<number>(-1)
const pipSupported = typeof document !== "undefined" && "pictureInPictureEnabled" in document
const showHelp = ref(false)

/**
 * Library key for this series, once it has one.
 *
 * Not `trackedKey.value` directly: with "add a series when I open an episode"
 * turned off the page arrives untracked, and the viewer can add it from here —
 * at which point everything keyed off it (progress, resume, episode list) has to
 * start working without a reload.
 */
const trackedKey = ref<string | undefined>(props.identity.key)
/** The next episode's page, read ahead so switching costs no navigation. */
const prepared = ref<{ url: string; identity: PageIdentity } | null>(null)
/** Which episode the look-ahead has already been asked for, so it runs once. */
let preparedFor = ""
let warmedFor = ""
const adding = ref(false)

const info = computed(() => current.value.pageInfo)
const title = computed(() => (info.value ? `${info.value.title} — Episode ${info.value.number}` : "Loading…"))

/** The series' episodes, ascending, for the navigator. */
const episodes = ref<Episode[]>([])

const currentIndex = computed(() => {
    if (!info.value) return -1
    return episodes.value.findIndex(ep => ep.number === info.value!.number)
})

const previousEp = computed(() => (currentIndex.value > 0 ? episodes.value[currentIndex.value - 1] : undefined))
const nextEp = computed(() =>
    currentIndex.value >= 0 && currentIndex.value < episodes.value.length - 1
        ? episodes.value[currentIndex.value + 1]
        : undefined
)

/**
 * Move to another episode.
 *
 * In place when the page has already been read ahead, which is the common case
 * for "next" — nothing navigates, nothing reloads, and the switch costs only
 * whatever attaching the video costs. Otherwise the old way: load the episode's
 * own page and let the background re-inject on arrival.
 *
 * Going *back* is deliberately not prefetched. It is rare, and reading a page
 * per direction would double the look-ahead traffic on every site for a button
 * most people press by accident.
 */
function goTo(episode: Episode | undefined) {
    if (!episode) return
    reportProgress()

    if (prepared.value?.url === episode.url && prepared.value.identity.isEpisode) {
        void swapTo(episode, prepared.value.identity)
        return
    }

    window.location.href = episode.url
}

/**
 * Switch episode without leaving the page.
 *
 * Everything the previous episode accumulated has to go, and forgetting one of
 * them is the kind of bug that only shows up three episodes in: a dead server
 * still marked failed, the last episode's subtitles still attached, an intro
 * marked as already skipped. Hence resetting the whole set in one place rather
 * than where each is set.
 */
async function swapTo(episode: Episode, identity: PageIdentity) {
    teardown()
    releaseTracks(subtitles.value)

    current.value = identity
    servers.value = identity.servers ?? []
    failedServers.value = new Set()
    activeServer.value = -1
    embedded.value = null
    embedFallback.value = null
    streamLabel.value = ""
    subtitles.value = []
    activeSubtitle.value = -1
    skips.value = {}
    skipped.value = new Set()
    inSkip.value = null
    lastReported = -1
    recoveries = 0
    lastRecoveryAt = 0
    streamPlayingSince = 0
    resumeAt = null
    prepared.value = null
    openMarkSpent.value = false
    status.value = "resolving"
    message.value = ""

    /*
     * The address bar has to follow, or the page is lying about what it shows and
     * a reload or a shared link lands somewhere else. The content script is told
     * first: the background sees the history event and asks it to re-identify,
     * which would read the DOM the player has already replaced.
     */
    props.onAdoptUrl?.(episode.url)
    try {
        history.pushState(null, "", episode.url)
    } catch {
        // Cross-origin or a sandboxed frame. Playback still works; only the URL
        // is stale, which is worth far less than the reload it would cost.
    }

    document.title = title.value

    /*
     * Nothing navigated, so nothing re-ran the tracking a page load would have
     * done — but the mark still waits for a picture, exactly as it does on a
     * fresh page load. Auto-advance walks into the newest episode, which is
     * precisely the one a site is most likely to have posted early, so marking
     * here on arrival would move the position onto a countdown without the
     * viewer ever having pressed anything.
     */
    if (identity.pending) {
        status.value = "error"
        message.value = notYetMessage(identity)
        return
    }

    if (servers.value.length === 0) {
        status.value = "error"
        message.value = "That episode's page didn't offer any video servers."
        return
    }

    await playServer(0, true)
}

/**
 * Read the next episode's page while this one is still playing.
 *
 * The page read is cheap and never goes stale, so it happens as soon as there is
 * something to read. The *stream* behind it is signed and short-lived, so it is
 * only warmed once the episode is well along — close enough to when it would
 * actually be used.
 */
function prepareNext(warm: boolean) {
    const episode = nextEp.value
    const sourceId = current.value.sourceId
    if (!episode || !sourceId) return

    if (warm ? warmedFor === episode.url : preparedFor === episode.url) return
    if (warm) warmedFor = episode.url
    else preparedFor = episode.url

    void send("playback:prepare", { sourceId, episodeUrl: episode.url, warm })
        .then(identity => {
            if (nextEp.value?.url !== episode.url) return
            if (identity.isEpisode) prepared.value = { url: episode.url, identity }
        })
        .catch(error => console.debug("[AAW] look-ahead failed", error))
}

/** How far in before the next episode's stream is worth resolving. */
const WARM_AT = 0.6

/*
 * One trigger for every way the next episode can become known: the episode list
 * arriving after mount, a swap moving the pointer along, the list being reloaded
 * when the series is followed from the player. Watching the value itself beats
 * calling this from each of those and eventually missing one.
 */
watch(nextEp, episode => {
    if (episode) prepareNext(false)
})

/** Bare hostname, for labelling an embed the viewer is being handed. */
function hostLabel(url: string): string {
    try {
        return new URL(url).hostname.replace(/^(www|geo)\./, "")
    } catch {
        return "embed"
    }
}

let tickTimer: number | undefined
let lastReported = -1

// ------------------------------------------------------------------ playback

/**
 * Play one server, falling through to the next when it fails.
 *
 * Sites list a lot of servers and a good few are dead at any moment — one host
 * needs a session the page never established, another has rotated its domain.
 * Trying the next one automatically is the difference between "it works" and
 * "it works if you know to click a different button", so `auto` walks the list
 * while an explicit click stops at the server the viewer asked for.
 */
async function playServer(index: number, auto = false): Promise<void> {
    const server = servers.value[index]
    if (!server || !info.value || !current.value.sourceId) return

    activeServer.value = index
    recoveries = 0
    lastRecoveryAt = 0
    status.value = "resolving"
    message.value = auto ? `Trying ${server.name}…` : `Resolving ${server.name}…`
    teardown()

    try {
        const result = await send("playback:streams", {
            sourceId: current.value.sourceId,
            server,
            episodeUrl: info.value.episodeUrl
        })

        const stream = result.streams[0]
        if (!stream) throw new Error("the extractor returned no streams")

        /*
         * Remember the host's own player, whatever happened here.
         *
         * Previously this was only kept when the *stream* was an iframe — an
         * unextractable host. But an extractor that succeeds and then hands back
         * a stream the browser refuses to play (a 403 on the manifest, a dead
         * CDN) leaves the viewer with nothing, while the embed that would have
         * played sat one field away in the same response. Every server now
         * contributes a fallback; the first one wins, since it is the
         * highest-preference server.
         */
        if (!embedFallback.value && result.embedUrl) {
            embedFallback.value = {
                stream: { url: result.embedUrl, kind: "iframe", label: hostLabel(result.embedUrl) },
                index
            }
        }

        // An embed is a last resort, not a result: keep looking for a server we
        // can actually extract, so we don't settle for a host's own player (and
        // lose progress tracking) while a real stream exists.
        if (stream.kind === "iframe" && auto) {
            failedServers.value = new Set(failedServers.value).add(index)
            if (await tryNextServer(`${server.name} can only be embedded`)) return
        }

        streamLabel.value = `${result.extractorId ?? "embedded"}${stream.label ? ` · ${stream.label}` : ""}`
        applySkips(stream)
        void loadSubtitles(stream)
        await attach(stream, index)
    } catch (error) {
        failedServers.value = new Set(failedServers.value).add(index)
        const detail = error instanceof Error ? error.message : String(error)
        if (auto && (await tryNextServer(detail))) return
        status.value = "error"
        message.value = detail
    }
}

/**
 * Move to the next untried server. Returns false only when nothing is left to
 * try — including the embedded fallback, which is used once every server has
 * been exhausted rather than never.
 */
async function tryNextServer(reason: string): Promise<boolean> {
    const next = servers.value.findIndex((_, index) => !failedServers.value.has(index))
    if (next !== -1) {
        console.debug(`[AAW] ${reason}; trying "${servers.value[next]?.name}"`)
        await playServer(next, true)
        return true
    }

    // Every server tried and none played: the host's own frame is what is left,
    // and it is a better answer than an error message.
    const fallback = embedFallback.value
    if (fallback) {
        console.debug(`[AAW] ${reason}; no extractable server left, embedding "${servers.value[fallback.index]?.name}"`)
        embedFallback.value = null
        activeServer.value = fallback.index
        streamLabel.value = `embedded · ${fallback.stream.label ?? ""}`.trim()
        await attach(fallback.stream, fallback.index)
        return true
    }

    return false
}

async function attach(stream: Stream, index: number, viaProxy = false) {
    /*
     * The host's own player, in a frame. Nothing to attach and nothing to
     * measure: a cross-origin frame reports no position, no duration and no
     * ended event, so the completion threshold can never be reached here.
     *
     * Opening the episode is therefore the only signal there will ever be, and
     * it is taken — otherwise every episode watched on an unextractable host
     * stays "unwatched" forever. It never moves the pointer backwards; the
     * library decides that.
     */
    if (stream.kind === "iframe") {
        embedded.value = stream.url
        status.value = "ready"
        message.value = ""
        // Either setting is enough here: the frame is the whole of what will
        // ever be known about this episode, so both "opening counts" and
        // "embedding counts" are answered by the same moment.
        if (current.value.markOnEmbed !== false || current.value.markOnOpen !== false) markOnScreen()
        return
    }

    embedded.value = null

    // A fresh attach has shown nothing yet, re-attach through the proxy
    // included. The recovery *budget* deliberately survives that re-attach —
    // moving a stream onto the proxy is one of the attempts.
    streamPlayingSince = 0

    const element = video.value
    if (!element) return

    if (stream.kind !== "hls") {
        // A progressive file plays straight from the element; a DNR rule
        // supplies whatever Referer the file host insists on.
        element.onerror = () => {
            const played = playedOnStream()

            /*
             * A file that played and then broke gets the same benefit of the
             * doubt as a stalled HLS stream: reload it where it stopped rather
             * than condemning a server that was working a second ago.
             */
            const canRecover =
                played >= STARTED_AFTER_SEC &&
                recoveries < MAX_RECOVERIES &&
                current.value.recoverStalledPlayback !== false
            if (canRecover) {
                recoveries += 1
                lastRecoveryAt = Date.now()
                rememberPosition()
                streamPlayingSince = 0
                console.debug(
                    `[AAW] ${stream.url} broke after ${Math.round(played)}s of playback; reloading it in place`
                )
                element.addEventListener("loadedmetadata", () => void restorePosition(), { once: true })
                element.src = stream.url
                return
            }

            failedServers.value = new Set(failedServers.value).add(index)
            rememberPosition()
            void tryNextServer(`media error on ${stream.url}`).then(moved => {
                if (moved) return
                status.value = "error"
                message.value = "The video file wouldn't load."
            })
        }
        element.src = stream.url
        status.value = "ready"
        message.value = ""
        markOnScreen()
        void restorePosition()
        return
    }

    if (!Hls.isSupported()) {
        status.value = "error"
        message.value = "This browser can't play HLS through Media Source Extensions."
        return
    }

    // Route every manifest and segment through the background when the
    // extractor says the CDN won't serve the page directly.
    const loader = stream.fetchVia === "background" ? BackgroundLoader : Hls.DefaultConfig.loader
    const instance = new Hls({
        loader,
        // Segments come through the same loader, minus any image header a CDN
        // dressed them in.
        fLoader: unwrapping(loader),
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90
    })
    hls.value = instance

    instance.on(Hls.Events.MANIFEST_PARSED, () => {
        levels.value = instance.levels
        applyPreferredQuality(instance)
        currentLevel.value = instance.currentLevel
        status.value = "ready"
        message.value = ""
        markOnScreen()
        void restorePosition()
    })

    instance.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        currentLevel.value = data.level
    })

    /*
     * "Fatal" is hls.js's word for "I have stopped", not for "this stream is
     * dead". A buffer its nudge loop could not clear, or a fragment whose
     * retries ran out, arrives here fatal and is recoverable in place — and
     * treating every one of them as a verdict on the server is what walked a
     * viewer three minutes into an episode onto a different server, and then
     * onto a third, on a stream that was fine. The rule lives in
     * `~/shared/playback` so it can be reasoned about and checked; this only
     * carries it out.
     */
    instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        const detail = `${data.details}${data.response?.code ? ` (HTTP ${data.response.code})` : ""}`
        const name = servers.value[index]?.name ?? `server ${index}`

        const decision = decideFatal({
            kind: fatalKind(data.type),
            playedSec: playedOnStream(),
            attempts: recoveries,
            sinceLastRecoveryMs: lastRecoveryAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - lastRecoveryAt,
            viaProxy,
            proxyRequested: stream.fetchVia === "background",
            recoverEnabled: current.value.recoverStalledPlayback !== false
        })

        recoveries = decision.attempts
        if (decision.remedy.do !== "nextServer") lastRecoveryAt = Date.now()
        console.debug(`[AAW] ${name}: ${detail} — ${decision.reason}`)

        switch (decision.remedy.do) {
            case "recoverMedia":
                // Swapping the codec is hls.js's own second move when a flush
                // alone does not clear it; doing it first would break streams a
                // plain recovery would have fixed.
                if (decision.remedy.swapAudioCodec) instance.swapAudioCodec()
                instance.recoverMediaError()
                return

            case "restartLoad":
                // From where the picture is, not from the top.
                instance.startLoad(video.value?.currentTime ?? -1)
                return

            case "viaProxy":
                rememberPosition()
                teardown()
                void attach({ ...stream, fetchVia: "background" }, index, true)
                return
        }

        if (decision.markFailed) failedServers.value = new Set(failedServers.value).add(index)
        rememberPosition()
        void tryNextServer(detail).then(moved => {
            if (moved) return
            status.value = "error"
            message.value = detail
        })
    })

    instance.loadSource(stream.url)
    instance.attachMedia(element)
}

function teardown() {
    hls.value?.destroy()
    hls.value = null
    levels.value = []
    if (video.value) video.value.removeAttribute("src")
}

function selectLevel(index: number) {
    if (hls.value) hls.value.currentLevel = index
    currentLevel.value = index
}

// ------------------------------------------------------------------ quality

/**
 * Honour the preferred quality once hls.js knows what the stream offers.
 *
 * Without this hls.js picks a starting level by its own bandwidth heuristic,
 * which is why a stream carrying two 1080p renditions still opened at 720p. The
 * preference is a ceiling, not an exact match: asking for 1080p on a stream that
 * tops out at 720p should give you 720p rather than silently doing nothing.
 */
function applyPreferredQuality(instance: Hls) {
    const wanted = Number.parseInt(props.preferredQuality.replace(/\D/g, ""), 10)
    if (!Number.isFinite(wanted) || instance.levels.length === 0) return

    let best = -1
    let bestHeight = -1
    instance.levels.forEach((level, index) => {
        const height = level.height ?? 0
        // Prefer the tallest level that does not exceed the target; among equals,
        // the higher bitrate wins, which is the better of two 1080p renditions.
        if (height <= wanted && height >= bestHeight) {
            if (height > bestHeight || (instance.levels[best]?.bitrate ?? 0) < level.bitrate) {
                best = index
                bestHeight = height
            }
        }
    })

    // Everything is above the target — take the smallest rather than nothing.
    if (best === -1) {
        best = instance.levels.reduce(
            (lo, level, index) => ((level.height ?? 0) < (instance.levels[lo]?.height ?? 0) ? index : lo),
            0
        )
    }

    instance.currentLevel = best
    console.debug(`[AAW] quality: wanted ${props.preferredQuality}, picked ${instance.levels[best]?.height}p`)
}

// ------------------------------------------------------------------ skipping

/**
 * Take whatever the site gave us, then ask AniSkip to fill the gaps.
 *
 * Site-supplied offsets are trusted over the crowd-sourced ones: they were
 * measured against the encode being served, not against whatever release a
 * contributor happened to have.
 */
function applySkips(stream: Stream) {
    skipped.value = new Set()
    skips.value = { ...stream.skips }
    inSkip.value = null

    if (skips.value.intro && skips.value.outro) return
    if (!trackedKey.value || !info.value) return

    void send("playback:skipTimes", {
        key: trackedKey.value,
        number: info.value.number,
        ...(video.value && Number.isFinite(video.value.duration) ? { durationSec: video.value.duration } : {})
    })
        .then(times => {
            if (!times) return
            skips.value = {
                intro: skips.value.intro ?? times.intro,
                outro: skips.value.outro ?? times.outro
            }
        })
        .catch(() => undefined)
}

/** Called on every timeupdate; keeps the button in sync and runs auto-skip. */
function checkSkip() {
    const element = video.value
    if (!element || embedded.value) return

    const at = element.currentTime
    const inside = (span?: { startSec: number; endSec: number }) =>
        Boolean(span && at >= span.startSec && at < span.endSec)

    const which = inside(skips.value.intro) ? "intro" : inside(skips.value.outro) ? "outro" : null
    inSkip.value = which
    if (!which) return

    const mode = which === "intro" ? props.skipIntro : props.skipOutro
    // Auto-skip once per span. Without this, seeking back into the opening on
    // purpose would be undone the moment the timer fired again.
    if (mode === "auto" && !skipped.value.has(which)) {
        doSkip(which)
    }
}

function doSkip(which: "intro" | "outro") {
    const span = skips.value[which]
    const element = video.value
    if (!span || !element) return
    skipped.value = new Set(skipped.value).add(which)
    element.currentTime = span.endSec
    inSkip.value = null
}

// ------------------------------------------------------------------ subtitles

/**
 * Extractor-supplied tracks. Ones declared inside an HLS manifest are handled by
 * hls.js itself and appear in its own track list, so they are not duplicated here.
 */
async function loadSubtitles(stream: Stream) {
    releaseTracks(subtitles.value)
    subtitles.value = []
    activeSubtitle.value = -1
    if (!stream.subtitles?.length) return

    const loaded = await Promise.all(stream.subtitles.map(loadTrack))
    subtitles.value = loaded.filter((track): track is LoadedTrack => track !== null)
}

function selectSubtitle(index: number) {
    activeSubtitle.value = index
    const element = video.value
    if (!element) return
    // Vue renders the <track> elements; the text-track mode is what actually
    // shows or hides them.
    for (let i = 0; i < element.textTracks.length; i++) {
        const track = element.textTracks[i]
        if (track) track.mode = i === index ? "showing" : "disabled"
    }
}

// ------------------------------------------------------------------ controls

function togglePlay() {
    const element = video.value
    if (!element) return
    if (element.paused) void element.play()
    else element.pause()
}

/** Native controls are for the mouse; a keypress is not a reason to show them. */
const controlsVisible = ref(true)

/**
 * Hide the control bar, by CSS as well as by attribute.
 *
 * The attribute alone did not do it. Rather than keep theorising about why,
 * this also sets a class whose rule is `display: none !important` on Chrome's
 * media-control pseudo-elements — there is no visibility state left for the
 * browser to decide. Both are applied here and now, synchronously: Vue patches
 * the binding on the next microtask, while the shortcut runs immediately, so a
 * seek would otherwise land while the bar is still there to be shown.
 */
function hideControls() {
    controlsVisible.value = false
    const element = video.value
    if (!element) return
    element.classList.add("no-native-controls")
    element.removeAttribute("controls")
}

/** The mouse is welcome to them back. */
function showControls() {
    controlsVisible.value = true
    video.value?.classList.remove("no-native-controls")
}

function seekBy(seconds: number) {
    const element = video.value
    if (!element) return
    element.currentTime = Math.max(0, element.currentTime + seconds)
}

function nudgeVolume(delta: number) {
    const element = video.value
    if (!element) return
    element.volume = Math.min(1, Math.max(0, element.volume + delta))
    element.muted = element.volume === 0
}

/**
 * Fullscreen the picture, not our chrome.
 *
 * This used to request it on `#aaw-root`, which is the whole player — header,
 * stage and control bar — so "fullscreen" produced a maximised *page* with a
 * title bar and a server picker still taking up room, and read like F11 rather
 * than like the video going fullscreen.
 *
 * `.stage` is the right element rather than the `<video>` itself: it is the
 * picture edge to edge either way, but the skip-intro button and the loading and
 * error overlays are positioned inside it, and fullscreening the video element
 * would leave them behind — losing skip intro at exactly the moment someone is
 * most likely to be sitting back. It also covers the embedded-iframe case, where
 * there is no video element of ours to ask.
 *
 * Exit is deliberately not element-specific: double-clicking the picture gives
 * the *video* fullscreen through the native controls, and F should still take
 * you out of that.
 */
async function toggleFullscreen() {
    if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => undefined)
        return
    }
    await stage.value?.requestFullscreen().catch(() => undefined)
}

async function togglePip() {
    const element = video.value
    if (!element || !pipSupported) return
    try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture()
        else await element.requestPictureInPicture()
    } catch {
        // Refused — a stream still buffering, or the browser said no.
    }
}

// ------------------------------------------------------------------ library

/**
 * The episode has a picture on screen, so an on-open mark may now be spent.
 *
 * This is the moment the background deliberately could not act on. When the page
 * was read, "an episode page was opened" was all that was known — whether it had
 * anything behind it took five server resolutions to find out, and on a site
 * that posts a countdown the answer was none of them. Recording the position
 * here instead costs the fraction of a second between the page load and the
 * first frame, and buys never recording an episode that did not exist.
 *
 * Never reached when every server fails: `tryNextServer` runs out, the error
 * shows, and nothing was marked — which is the whole point.
 */
function markOnScreen() {
    if (openMarkSpent.value) return
    if (current.value.markOnOpen === false) return
    openMarkSpent.value = true
    markWatchedHere()
}

/** What to say about an episode the site has posted but not released. */
function notYetMessage(identity: PageIdentity): string {
    return identity.pendingReason
        ? `This episode isn't out yet — ${identity.pendingReason}.`
        : "This episode isn't out yet: the page has a countdown where the player goes."
}

/** Record this episode as the viewer's position, without any progress signal. */
function markWatchedHere() {
    if (!trackedKey.value || !info.value) return
    void send("library:markWatched", {
        key: trackedKey.value,
        number: info.value.number,
        ...(info.value.variant ? { variant: info.value.variant } : {})
    }).catch(() => undefined)
}

/**
 * Follow this series from the player.
 *
 * The identity was already worked out by the background when the page was read,
 * so this passes it along rather than making the source derive it again from a
 * URL — which for a site whose episode URLs don't name their series would give a
 * different answer, or none.
 */
async function addToLibrary() {
    if (!info.value || !current.value.sourceId || adding.value) return
    adding.value = true
    try {
        const anime = await send("library:add", {
            sourceId: current.value.sourceId,
            seriesUrl: info.value.seriesUrl,
            seriesId: info.value.seriesId,
            title: info.value.title
        })
        if (!anime) return
        trackedKey.value = anime.key
        await loadEpisodeList()
        if (embedded.value && current.value.markOnEmbed !== false) markWatchedHere()
    } catch (error) {
        message.value = error instanceof Error ? error.message : String(error)
    } finally {
        adding.value = false
    }
}

// ------------------------------------------------------------------- shelves

/*
 * Shelving the series you are watching, without leaving the episode.
 *
 * The moment you know a show belongs on "dropped" or "rewatching" is usually
 * three minutes into an episode, not next time the library page is open — and
 * by then the thought is gone. This is the same edit the library page's row
 * offers, against the same `library:shelve`, so the two cannot drift.
 *
 * Everything is loaded on first open rather than at mount. Most sessions never
 * touch it, and the player already makes enough calls before the first frame.
 */
const shelvesOpen = ref(false)
const shelves = ref<Category[]>([])
const shelfClaims = ref<SourceCategories>({})
const shelfAnime = ref<TrackedAnime | null>(null)
const shelvesLoading = ref(false)
const shelfError = ref<string | null>(null)

async function toggleShelves() {
    if (!trackedKey.value) return
    shelvesOpen.value = !shelvesOpen.value
    if (shelvesOpen.value) await loadShelves()
}

async function loadShelves() {
    const key = trackedKey.value
    if (!key) return

    shelvesLoading.value = true
    shelfError.value = null
    try {
        const [settings, sources, anime] = await Promise.all([
            send("settings:get", {}),
            send("sources:list", {}),
            send("library:get", { key })
        ])
        shelves.value = settings.categories ?? []
        shelfClaims.value = Object.fromEntries(sources.map(source => [source.id, source.categories]))
        shelfAnime.value = anime
    } catch (error) {
        shelfError.value = error instanceof Error ? error.message : String(error)
    } finally {
        shelvesLoading.value = false
    }
}

/** Rules and the user's corrections together — what a tick actually reflects. */
const shelfMembership = computed(() =>
    shelfAnime.value ? categoriesOf(shelfAnime.value, shelves.value, shelfClaims.value) : []
)

/** Where the rules alone would file it, which is what the "auto" tag marks. */
const shelfAutomatic = computed(() =>
    shelfAnime.value ? automaticCategoriesOf(shelfAnime.value, shelves.value, shelfClaims.value) : []
)

/**
 * Stated rather than toggled, and the background decides what to store: ticking
 * a shelf whose rule already covers the series records nothing, so the entry
 * never carries a redundant tag that would outlive the rule.
 */
async function setShelf(categoryId: string, on: boolean) {
    const key = trackedKey.value
    if (!key) return

    shelfError.value = null
    try {
        const updated = await send("library:shelve", { key, categoryId, on })
        if (updated) shelfAnime.value = updated
    } catch (error) {
        shelfError.value = error instanceof Error ? error.message : String(error)
    }
}

// ------------------------------------------------------------------ progress

/** Resume where the viewer left off, if they were more than a few seconds in. */
async function restorePosition() {
    const element = video.value
    if (!element) return

    /*
     * A position carried over from the stream we just left wins. It is exact,
     * where the library's is up to a progress tick old, and it exists for an
     * unfollowed series, where the library's does not.
     */
    if (resumeAt !== null) {
        element.currentTime = resumeAt
        resumeAt = null
        return
    }

    if (!trackedKey.value || !info.value) return
    try {
        const anime = await send("library:get", { key: trackedKey.value })
        const saved = anime?.progress?.[progressKey(info.value.number, info.value.variant)]
        const at = resumePositionFor(saved)
        if (at !== null) element.currentTime = at
    } catch {
        // A failed resume is not worth interrupting playback over.
    }
}

function reportProgress() {
    const element = video.value
    if (!element || !trackedKey.value || !info.value) return
    if (element.paused || element.seeking) return

    const positionSec = Math.floor(element.currentTime)
    if (positionSec === lastReported) return
    lastReported = positionSec

    void send("progress:update", {
        key: trackedKey.value,
        number: info.value.number,
        ...(info.value.variant ? { variant: info.value.variant } : {}),
        positionSec,
        ...(Number.isFinite(element.duration) ? { durationSec: Math.floor(element.duration) } : {})
    }).catch(() => undefined)

    // Riding the progress tick rather than its own timer: it already runs at a
    // sensible cadence and only while something is actually playing.
    if (Number.isFinite(element.duration) && element.duration > 0) {
        if (element.currentTime / element.duration >= WARM_AT) prepareNext(true)
    }
}

// ------------------------------------------------------------------ lifecycle

onMounted(async () => {
    document.title = title.value

    // Once, on mount: an in-place swap to the next episode reuses this element,
    // so a volume changed while watching carries over instead of snapping back.
    if (video.value) video.value.volume = Math.min(1, Math.max(0, props.defaultVolume / 100))

    /*
     * The source recognised a countdown or a placeholder. Say so rather than
     * walking a server list that will resolve to nothing five times over — which
     * is what the viewer saw before this existed, ending in "No server would
     * play" for an episode that simply is not out.
     */
    if (props.identity.pending) {
        status.value = "error"
        message.value = notYetMessage(props.identity)
        void loadEpisodeList()
        return
    }

    if (servers.value.length === 0) {
        status.value = "error"
        message.value = "This page didn't offer any video servers."
        return
    }

    tickTimer = window.setInterval(reportProgress, Math.max(1, props.progressTickSec) * 1000)
    document.addEventListener("visibilitychange", reportProgress)
    // Capture, so nothing on the page gets the key first.
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("mousemove", onPointer, { passive: true })
    window.addEventListener("mousedown", onPointer, { passive: true })

    void loadEpisodeList()
    await playServer(0, true)
})

/**
 * Reaching the end is the strongest possible signal the episode was watched, so
 * report it before moving on — the completion threshold might not have been
 * crossed if the viewer skipped the credits.
 */
function onEnded() {
    reportProgress()
    if (props.autoAdvance) goTo(nextEp.value)
}

/** Ascending, so "next" is the following entry rather than the preceding one. */
async function loadEpisodeList() {
    if (!trackedKey.value) return
    try {
        const anime = await send("library:get", { key: trackedKey.value })
        episodes.value = [...(anime?.episodes ?? [])].sort((a, b) => a.number - b.number)
    } catch {
        // Navigation is a convenience; failing to build it shouldn't stop playback.
    }
}

/**
 * Keyboard control.
 *
 * N and B are AMR's episode bindings, so that muscle memory carries over; the
 * rest follow the conventions every web player shares, because those are the
 * ones already in your fingers. Ignored while typing and while a modifier is
 * held, so the browser's own shortcuts still work.
 */
const SHORTCUTS: { keys: string[]; label: string; run: () => void }[] = []

function onKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey) return

    // Escape closes the shelves panel wherever focus is — including on one of
    // its own checkboxes, which the input guard below would otherwise skip.
    if (event.key === "Escape" && shelvesOpen.value) {
        shelvesOpen.value = false
        event.preventDefault()
        event.stopPropagation()
        return
    }

    const target = event.target as HTMLElement | null
    if (target && /^(input|textarea|select)$/i.test(target.tagName)) return

    const key = event.key.toLowerCase()
    const match = SHORTCUTS.find(shortcut => shortcut.keys.includes(key))
    if (!match) return

    event.preventDefault()
    event.stopPropagation()

    /*
     * Driving with the keyboard puts the picture back the way mpv leaves it.
     *
     * Two separate things go wrong otherwise, and both are Chrome doing what it
     * is supposed to. The <video> element takes focus from a click or from
     * entering fullscreen, so the first arrow key draws a focus ring — in
     * fullscreen, a white box around the whole picture. And the native controls
     * do not auto-hide while the element has focus, so the darkened bar stays
     * put, over the bottom of the frame where a hardcoded subtitle lives.
     *
     * Neither is needed here: every shortcut is bound on the window, so the
     * element never has to hold focus. The mouse brings the controls back — see
     * onPointer.
     */
    hideControls()
    video.value?.blur()

    match.run()
}

/**
 * Moving or clicking the mouse brings the control bar back — that is wanted, and
 * it is the only thing that brings it back. "Whichever device you last used"
 * needs no explaining, where "hidden only in fullscreen" or "hidden on a timer"
 * would be state to reason about.
 */
function onPointer() {
    if (!controlsVisible.value) showControls()
}

SHORTCUTS.push(
    { keys: ["n"], label: "Next episode", run: () => goTo(nextEp.value) },
    { keys: ["b"], label: "Previous episode", run: () => goTo(previousEp.value) },
    { keys: [" ", "k"], label: "Play / pause", run: togglePlay },
    { keys: ["arrowright", "l"], label: `Forward ${props.seekStepSec}s`, run: () => seekBy(props.seekStepSec) },
    { keys: ["arrowleft", "j"], label: `Back ${props.seekStepSec}s`, run: () => seekBy(-props.seekStepSec) },
    { keys: ["arrowup"], label: "Volume up", run: () => nudgeVolume(0.1) },
    { keys: ["arrowdown"], label: "Volume down", run: () => nudgeVolume(-0.1) },
    {
        keys: ["m"],
        label: "Mute",
        run: () => {
            if (video.value) video.value.muted = !video.value.muted
        }
    },
    { keys: ["f"], label: "Fullscreen", run: () => void toggleFullscreen() },
    { keys: ["p"], label: "Picture-in-picture", run: () => void togglePip() },
    {
        keys: ["s"],
        label: "Skip the intro or ending",
        run: () => {
            if (inSkip.value) doSkip(inSkip.value)
        }
    },
    { keys: ["?"], label: "This list", run: () => (showHelp.value = !showHelp.value) }
)

onBeforeUnmount(() => {
    if (tickTimer) window.clearInterval(tickTimer)
    document.removeEventListener("visibilitychange", reportProgress)
    window.removeEventListener("keydown", onKey, true)
    window.removeEventListener("mousemove", onPointer)
    window.removeEventListener("mousedown", onPointer)
    reportProgress()
    releaseTracks(subtitles.value)
    teardown()
})
</script>

<template>
    <div class="aaw-player">
        <header>
            <span class="mark" aria-hidden="true"></span>
            <h1 :title="title">{{ title }}</h1>
            <span v-if="streamLabel" class="tag">{{ streamLabel }}</span>
            <span class="spacer"></span>

            <div v-if="episodes.length > 0" class="nav">
                <button
                    class="navbtn"
                    :disabled="!previousEp"
                    :title="previousEp ? `Previous — episode ${previousEp.number}  (B)` : 'This is the first episode'"
                    @click="goTo(previousEp)"
                >
                    ‹
                </button>

                <select
                    class="episodes"
                    aria-label="Jump to episode"
                    :value="info?.number"
                    @change="goTo(episodes.find(e => e.number === Number(($event.target as HTMLSelectElement).value)))"
                >
                    <option v-for="ep in episodes" :key="ep.number" :value="ep.number">
                        Episode {{ ep.number }}{{ ep.title ? ` — ${ep.title}` : "" }}
                    </option>
                </select>

                <button
                    class="navbtn"
                    :disabled="!nextEp"
                    :title="nextEp ? `Next — episode ${nextEp.number}  (N)` : 'This is the latest episode'"
                    @click="goTo(nextEp)"
                >
                    ›
                </button>
            </div>

            <button v-if="info && !trackedKey" class="follow" :disabled="adding" @click="addToLibrary">
                {{ adding ? "Adding…" : "+ Follow this series" }}
            </button>

            <div v-if="trackedKey" class="shelves">
                <button
                    class="chip"
                    :aria-expanded="shelvesOpen"
                    title="Put this series on a shelf"
                    @click="toggleShelves"
                >
                    Shelves ▾
                </button>

                <div v-if="shelvesOpen" class="shelf-backdrop" @click="shelvesOpen = false"></div>

                <div v-if="shelvesOpen" class="shelf-panel">
                    <p v-if="shelvesLoading" class="shelf-note">Loading…</p>
                    <p v-else-if="shelfError" class="shelf-note bad">{{ shelfError }}</p>

                    <template v-else>
                        <div v-if="shelves.length > 0" class="shelf-picks">
                            <label v-for="category in shelves" :key="category.id" class="shelf-pick">
                                <input
                                    type="checkbox"
                                    :checked="shelfMembership.includes(category.id)"
                                    @change="setShelf(category.id, ($event.target as HTMLInputElement).checked)"
                                />
                                <span class="shelf-name">{{ category.name }}</span>
                                <span v-if="shelfAutomatic.includes(category.id)" class="shelf-auto">auto</span>
                            </label>
                        </div>
                        <p v-else class="shelf-note">No shelves yet — make one on the library page.</p>

                        <p v-if="shelves.length > 0" class="shelf-note">
                            “auto” means a rule already files it there. Ticking or unticking overrules it.
                        </p>
                    </template>
                </div>
            </div>

            <a v-if="info" class="tag link" :href="info.seriesUrl">All episodes</a>
        </header>

        <div ref="stage" class="stage">
            <iframe
                v-if="embedded"
                :src="embedded"
                class="embed"
                allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                referrerpolicy="origin"
            ></iframe>
            <video
                v-show="!embedded"
                ref="video"
                :controls="controlsVisible"
                playsinline
                autoplay
                @ended="onEnded"
                @playing="onPlaying"
                @timeupdate="checkSkip"
            >
                <track
                    v-for="(track, index) in subtitles"
                    :key="track.objectUrl"
                    kind="subtitles"
                    :src="track.objectUrl"
                    :label="track.label"
                    :srclang="track.language ?? 'und'"
                    :default="index === activeSubtitle"
                />
            </video>

            <button
                v-if="inSkip && (inSkip === 'intro' ? skipIntro : skipOutro) !== 'off'"
                class="skip"
                @click="doSkip(inSkip)"
            >
                Skip {{ inSkip === "intro" ? "intro" : "ending" }} <span class="key">S</span>
            </button>

            <div v-if="status === 'resolving'" class="overlay">
                <div class="spinner" aria-hidden="true"></div>
                <p>{{ message }}</p>
            </div>

            <div v-else-if="status === 'error'" class="overlay error">
                <p class="headline">
                    {{ failedServers.size >= servers.length ? "No server would play" : "Couldn't play this server" }}
                </p>
                <p class="detail">{{ message }}</p>
                <p v-if="failedServers.size < servers.length" class="detail">Pick another server below.</p>
                <p v-else class="detail">Tried all {{ servers.length }}. The episode page may have changed.</p>
            </div>
        </div>

        <div v-if="showHelp" class="help" @click.self="showHelp = false">
            <div class="help-card">
                <h2>Keyboard</h2>
                <ul>
                    <li v-for="shortcut in SHORTCUTS" :key="shortcut.label">
                        <span class="keys">
                            <span v-for="key in shortcut.keys" :key="key" class="key">{{
                                key === " " ? "Space" : key
                            }}</span>
                        </span>
                        <span>{{ shortcut.label }}</span>
                    </li>
                </ul>
                <button class="chip" @click="showHelp = false">Close</button>
            </div>
        </div>

        <div class="controls">
            <div class="group">
                <span class="label">Server</span>
                <button
                    v-for="(server, index) in servers"
                    :key="`${server.name}-${index}`"
                    class="chip"
                    :class="{ on: index === activeServer, dead: failedServers.has(index) }"
                    :title="server.variant ? `${server.name} · ${server.variant}` : server.name"
                    @click="playServer(index)"
                >
                    {{ server.name }}
                </button>
            </div>

            <div v-if="subtitles.length > 0 && !embedded" class="group">
                <span class="label">Subtitles</span>
                <button class="chip" :class="{ on: activeSubtitle === -1 }" @click="selectSubtitle(-1)">Off</button>
                <button
                    v-for="(track, index) in subtitles"
                    :key="track.objectUrl"
                    class="chip"
                    :class="{ on: index === activeSubtitle }"
                    @click="selectSubtitle(index)"
                >
                    {{ track.label }}
                </button>
            </div>

            <div class="group right">
                <button v-if="pipSupported && !embedded" class="chip" title="Picture-in-picture (P)" @click="togglePip">
                    PiP
                </button>
                <button class="chip" title="Keyboard shortcuts (?)" @click="showHelp = !showHelp">?</button>
            </div>

            <span v-if="embedded" class="embed-note">
                Playing this host's own player — episode tracking still works, but not your position inside the episode.
            </span>

            <div v-if="levels.length > 1 && !embedded" class="group">
                <span class="label">Quality</span>
                <button class="chip" :class="{ on: currentLevel === -1 }" @click="selectLevel(-1)">Auto</button>
                <button
                    v-for="(level, index) in levels"
                    :key="index"
                    class="chip"
                    :class="{ on: currentLevel === index }"
                    @click="selectLevel(index)"
                >
                    {{ level.height ? `${level.height}p` : `${Math.round((level.bitrate || 0) / 1000)}k` }}
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.follow {
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    color: #04222a;
    background: #45cddb;
    border: none;
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
    white-space: nowrap;
}

.follow:disabled {
    opacity: 0.6;
    cursor: default;
}

/*
 * The shelves dropdown. Anchored to its button rather than centred like the help
 * overlay: it is an edit to the row you are already looking at, not a mode.
 */
.shelves {
    position: relative;
    flex: 0 0 auto;
}

/*
 * Catches the click that dismisses the panel. Fixed and transparent rather than
 * a document listener, which would have to know about the button that opened it
 * to avoid closing and reopening on the same click.
 */
.shelf-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1;
}

.shelf-panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 2;
    width: 240px;
    max-height: 320px;
    overflow-y: auto;
    padding: 10px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 6px;
    box-shadow: 0 10px 28px rgb(0 0 0 / 45%);
}

.shelf-picks {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.shelf-pick {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 2px;
    font-size: 12px;
    color: var(--ink);
    cursor: pointer;
}

.shelf-pick:hover {
    color: var(--accent);
}

.shelf-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.shelf-auto {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 9px;
    letter-spacing: 0.04em;
    color: var(--ink-3);
    border: 1px solid var(--rule);
    border-radius: 3px;
    padding: 1px 4px;
}

.shelf-note {
    margin: 8px 0 0;
    font-size: 11px;
    line-height: 1.45;
    color: var(--ink-3);
}

.shelf-picks + .shelf-note {
    border-top: 1px solid var(--rule);
    padding-top: 8px;
}

.shelf-note.bad {
    color: var(--danger);
}

/*
 * Self-contained: the host page's stylesheet is stripped before we mount, but
 * anything left behind must not be able to reach in, so every value is literal
 * and nothing inherits.
 */
.aaw-player {
    --bg: #0c1216;
    --surface: #131c21;
    --rule: #253239;
    --ink: #e3ecef;
    --ink-2: #a4b4bb;
    --ink-3: #71858e;
    --accent: #45cddb;
    --danger: #e58b7e;

    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--ink);
    font:
        400 13px/1.5 system-ui,
        -apple-system,
        "Segoe UI",
        Roboto,
        sans-serif;
    z-index: 2147483000;
}

header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: var(--surface);
    border-bottom: 1px solid var(--rule);
    flex: 0 0 auto;

    /*
     * Lifts the header, and with it the shelves dropdown, above the stage.
     * `.stage` is a later sibling, so without a stacking context here the panel
     * paints *behind* the video — and against a black frame that reads as the
     * menu simply not opening.
     */
    position: relative;
    z-index: 5;
}

.mark {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: var(--accent);
    flex: 0 0 auto;
}

h1 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.spacer {
    flex: 1 1 auto;
}

.tag {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10px;
    letter-spacing: 0.03em;
    color: var(--ink-3);
    padding: 2px 6px;
    border: 1px solid var(--rule);
    border-radius: 3px;
    white-space: nowrap;
}

.tag.link {
    color: var(--accent);
    text-decoration: none;
}

.nav {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 1 auto;
    min-width: 0;
}

.navbtn {
    font: inherit;
    font-size: 15px;
    line-height: 1;
    color: var(--ink-2);
    background: none;
    border: 1px solid var(--rule);
    border-radius: 4px;
    padding: 2px 9px;
    cursor: pointer;
}

.navbtn:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--accent);
}

.navbtn:disabled {
    opacity: 0.35;
    cursor: default;
}

.episodes {
    font: inherit;
    font-size: 11px;
    color: var(--ink-2);
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 4px;
    padding: 3px 4px;
    max-width: 220px;
}

.navbtn:focus-visible,
.episodes:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}

.stage {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    background: #000;
}

video,
.embed {
    width: 100%;
    height: 100%;
    display: block;
    background: #000;
    border: 0;
}

/*
 * No focus ring on the picture. Every shortcut is bound on the window, so the
 * element holding focus tells the viewer nothing — and in fullscreen the ring is
 * a white box drawn around the entire frame.
 */
video:focus,
video:focus-visible {
    outline: none;
}

/*
 * The control bar, gone — not asked to hide, made unrenderable.
 *
 * Removing the `controls` attribute is the polite way and it was not enough in
 * practice. These are Chrome's own control pseudo-elements; with `display: none`
 * there is no visibility state left for it to decide, whatever a seek would
 * otherwise make it do. The class comes off the moment the mouse moves.
 */
video.no-native-controls::-webkit-media-controls,
video.no-native-controls::-webkit-media-controls-enclosure,
video.no-native-controls::-webkit-media-controls-panel,
video.no-native-controls::-webkit-media-controls-panel-container,
video.no-native-controls::-webkit-media-controls-overlay-play-button {
    display: none !important;
    opacity: 0 !important;
    pointer-events: none !important;
}

.embed-note {
    font-size: 11px;
    color: var(--ink-3);
    align-self: center;
}

.overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: rgba(12, 18, 22, 0.86);
    text-align: center;
    padding: 24px;
}

.overlay p {
    margin: 0;
    color: var(--ink-2);
    max-width: 46ch;
}

.overlay .headline {
    color: var(--danger);
    font-weight: 600;
    font-size: 15px;
}

.overlay .detail {
    font-size: 12px;
    color: var(--ink-3);
    word-break: break-word;
}

.spinner {
    width: 26px;
    height: 26px;
    border: 2px solid var(--rule);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
}

@keyframes spin {
    to {
        transform: rotate(360deg);
    }
}

@media (prefers-reduced-motion: reduce) {
    .spinner {
        animation-duration: 2s;
    }
}

.skip {
    position: absolute;
    right: 22px;
    bottom: 74px;
    display: flex;
    align-items: center;
    gap: 7px;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    color: var(--bg);
    background: var(--accent);
    border: 0;
    border-radius: 5px;
    padding: 8px 14px;
    cursor: pointer;
    box-shadow: 0 6px 18px -6px rgba(0, 0, 0, 0.7);
}

.skip:hover {
    filter: brightness(1.08);
}

.key {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.22);
    text-transform: uppercase;
}

.help {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(12, 18, 22, 0.82);
}

.help-card {
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 8px;
    padding: 18px 20px;
    min-width: 300px;
    max-height: 80%;
    overflow-y: auto;
}

.help-card h2 {
    margin: 0 0 10px;
    font-size: 14px;
    font-weight: 600;
}

.help-card ul {
    list-style: none;
    margin: 0 0 14px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.help-card li {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: var(--ink-2);
}

.keys {
    display: flex;
    gap: 3px;
    flex: 0 0 108px;
}

.help-card .key {
    background: var(--bg);
    border: 1px solid var(--rule);
    color: var(--ink-2);
}

.group.right {
    margin-left: auto;
}

.controls {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    padding: 10px 14px;
    background: var(--surface);
    border-top: 1px solid var(--rule);
    flex: 0 0 auto;
}

.group {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
}

.label {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-3);
    margin-right: 3px;
}

.chip {
    font: inherit;
    font-size: 11px;
    color: var(--ink-2);
    background: none;
    border: 1px solid var(--rule);
    border-radius: 4px;
    padding: 3px 8px;
    cursor: pointer;
    white-space: nowrap;
}

.chip:hover {
    color: var(--ink);
    border-color: var(--accent);
}

.chip.dead {
    opacity: 0.45;
    text-decoration: line-through;
}

.chip.on {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
    font-weight: 600;
}

.chip:focus-visible,
.tag.link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}
</style>
