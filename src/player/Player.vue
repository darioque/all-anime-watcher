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

const props = defineProps<{
    identity: PageIdentity
    progressTickSec: number
    preferredQuality: string
    autoAdvance: boolean
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
    // The host's own player, in a frame. Nothing to attach and nothing to
    // measure — progress stays wherever the library already had it.
    if (stream.kind === "iframe") {
        embedded.value = stream.url
        status.value = "ready"
        message.value = ""
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

// ------------------------------------------------------------------ progress

/** Resume where the viewer left off, if they were more than a few seconds in. */
async function restorePosition() {
    if (!props.identity.key || !info.value || !video.value) return
    try {
        const anime = await send("library:get", { key: props.identity.key })
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
    if (!element || !props.identity.key || !info.value) return
    if (element.paused || element.seeking) return

    const positionSec = Math.floor(element.currentTime)
    if (positionSec === lastReported) return
    lastReported = positionSec

    void send("progress:update", {
        key: props.identity.key,
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
    if (!props.identity.key) return
    try {
        const anime = await send("library:get", { key: props.identity.key })
        episodes.value = [...(anime?.episodes ?? [])].sort((a, b) => a.number - b.number)
    } catch {
        // Navigation is a convenience; failing to build it shouldn't stop playback.
    }
}

/**
 * AMR's bindings, so the muscle memory carries over: N and B move between
 * episodes. Ignored while typing, and while a modifier is held so the browser's
 * own shortcuts still work.
 */
function onKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey) return
    const target = event.target as HTMLElement | null
    if (target && /^(input|textarea|select)$/i.test(target.tagName)) return

    if (event.key === "n" || event.key === "N") {
        event.preventDefault()
        goTo(nextEp.value)
    }
    if (event.key === "b" || event.key === "B") {
        event.preventDefault()
        goTo(previousEp.value)
    }
}

onBeforeUnmount(() => {
    if (tickTimer) window.clearInterval(tickTimer)
    document.removeEventListener("visibilitychange", reportProgress)
    window.removeEventListener("keydown", onKey)
    reportProgress()
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

            <a v-if="info" class="tag link" :href="info.seriesUrl">All episodes</a>
        </header>

        <div class="stage">
            <iframe
                v-if="embedded"
                :src="embedded"
                class="embed"
                allowfullscreen
                allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                referrerpolicy="origin"
            ></iframe>
            <video v-show="!embedded" ref="video" controls playsinline autoplay @ended="onEnded"></video>

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
