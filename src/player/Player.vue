<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue"
import Hls from "hls.js"
import type { Level } from "hls.js"
import { send } from "~/shared/messages"
import type { PageIdentity } from "~/shared/messages"
import type { Server } from "~/sources/types"
import type { Episode } from "~/model/types"
import type { Stream } from "~/extractors/types"
import { BackgroundLoader } from "./backgroundLoader"
import { loadTrack, releaseTracks, type LoadedTrack } from "./subtitles"

const props = defineProps<{
    identity: PageIdentity
    progressTickSec: number
    preferredQuality: string
    autoAdvance: boolean
    skipIntro: "off" | "button" | "auto"
    skipOutro: "off" | "button" | "auto"
}>()

const video = ref<HTMLVideoElement | null>(null)
const hls = shallowRef<Hls | null>(null)

const status = ref<"idle" | "resolving" | "ready" | "error">("idle")
const message = ref("")
const servers = ref<Server[]>(props.identity.servers ?? [])
const activeServer = ref<number>(-1)
/** Servers that already failed this session, so fallback doesn't loop over them. */
const failedServers = ref(new Set<number>())
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
const adding = ref(false)

const info = computed(() => props.identity.pageInfo)
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
 * Navigate by loading the episode's own page.
 *
 * The background re-injects on arrival, so this is a full round trip rather than
 * AMR's in-place chapter swap. It is the honest version for now: each episode
 * page carries its own server list, so staying put would mean re-fetching and
 * re-parsing that page anyway. Loading it in place is an optimisation, not a
 * shortcut.
 */
function goTo(episode: Episode | undefined) {
    if (!episode) return
    reportProgress()
    window.location.href = episode.url
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
    if (!server || !info.value || !props.identity.sourceId) return

    activeServer.value = index
    status.value = "resolving"
    message.value = auto ? `Trying ${server.name}…` : `Resolving ${server.name}…`
    teardown()

    try {
        const result = await send("playback:streams", {
            sourceId: props.identity.sourceId,
            server,
            episodeUrl: info.value.episodeUrl
        })

        const stream = result.streams[0]
        if (!stream) throw new Error("the extractor returned no streams")

        // An embed is a last resort, not a result: remember it and keep looking
        // for a server we can actually extract, so we don't settle for a host's
        // own player (and lose progress tracking) while a real stream exists.
        if (stream.kind === "iframe" && auto) {
            if (!embedFallback.value) embedFallback.value = { stream, index }
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

async function attach(stream: Stream, index: number) {
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
        if (props.identity.markOnEmbed !== false) markWatchedHere()
        return
    }

    embedded.value = null

    const element = video.value
    if (!element) return

    if (stream.kind !== "hls") {
        // A progressive file plays straight from the element; a DNR rule
        // supplies whatever Referer the file host insists on.
        element.onerror = () => {
            failedServers.value = new Set(failedServers.value).add(index)
            void tryNextServer(`media error on ${stream.url}`).then(moved => {
                if (moved) return
                status.value = "error"
                message.value = "The video file wouldn't load."
            })
        }
        element.src = stream.url
        status.value = "ready"
        message.value = ""
        void restorePosition()
        return
    }

    if (!Hls.isSupported()) {
        status.value = "error"
        message.value = "This browser can't play HLS through Media Source Extensions."
        return
    }

    const instance = new Hls({
        // Route every manifest and segment through the background when the
        // extractor says the CDN won't serve the page directly.
        ...(stream.fetchVia === "background" ? { loader: BackgroundLoader } : {}),
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
        void restorePosition()
    })

    instance.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        currentLevel.value = data.level
    })

    instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        const detail = `${data.details}${data.response?.code ? ` (HTTP ${data.response.code})` : ""}`
        failedServers.value = new Set(failedServers.value).add(index)
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

async function toggleFullscreen() {
    const root = document.getElementById("aaw-root")
    if (!root) return
    if (document.fullscreenElement) await document.exitFullscreen()
    else await root.requestFullscreen().catch(() => undefined)
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
    if (!info.value || !props.identity.sourceId || adding.value) return
    adding.value = true
    try {
        const anime = await send("library:add", {
            sourceId: props.identity.sourceId,
            seriesUrl: info.value.seriesUrl,
            seriesId: info.value.seriesId,
            title: info.value.title
        })
        if (!anime) return
        trackedKey.value = anime.key
        await loadEpisodeList()
        if (embedded.value && props.identity.markOnEmbed !== false) markWatchedHere()
    } catch (error) {
        message.value = error instanceof Error ? error.message : String(error)
    } finally {
        adding.value = false
    }
}

// ------------------------------------------------------------------ progress

/** Resume where the viewer left off, if they were more than a few seconds in. */
async function restorePosition() {
    if (!trackedKey.value || !info.value || !video.value) return
    try {
        const anime = await send("library:get", { key: trackedKey.value })
        const key = `${info.value.number}:${info.value.variant ?? ""}`
        const saved = anime?.progress?.[key]
        if (saved && !saved.completed && saved.positionSec > 5) {
            video.value.currentTime = saved.positionSec
        }
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
}

// ------------------------------------------------------------------ lifecycle

onMounted(async () => {
    document.title = title.value

    if (servers.value.length === 0) {
        status.value = "error"
        message.value = "This page didn't offer any video servers."
        return
    }

    tickTimer = window.setInterval(reportProgress, Math.max(1, props.progressTickSec) * 1000)
    document.addEventListener("visibilitychange", reportProgress)
    window.addEventListener("keydown", onKey)

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
    const target = event.target as HTMLElement | null
    if (target && /^(input|textarea|select)$/i.test(target.tagName)) return

    const key = event.key.toLowerCase()
    const match = SHORTCUTS.find(shortcut => shortcut.keys.includes(key))
    if (!match) return

    event.preventDefault()
    event.stopPropagation()
    match.run()
}

SHORTCUTS.push(
    { keys: ["n"], label: "Next episode", run: () => goTo(nextEp.value) },
    { keys: ["b"], label: "Previous episode", run: () => goTo(previousEp.value) },
    { keys: [" ", "k"], label: "Play / pause", run: togglePlay },
    { keys: ["arrowright", "l"], label: "Forward 10s", run: () => seekBy(10) },
    { keys: ["arrowleft", "j"], label: "Back 10s", run: () => seekBy(-10) },
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
    window.removeEventListener("keydown", onKey)
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

            <a v-if="info" class="tag link" :href="info.seriesUrl">All episodes</a>
        </header>

        <div class="stage">
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
                controls
                playsinline
                autoplay
                @ended="onEnded"
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
