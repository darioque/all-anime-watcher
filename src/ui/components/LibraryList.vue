<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { onLibraryChanged, send } from "~/shared/messages"
import type { SourceDescriptor } from "~/shared/messages"
import type { Episode, SchedulePolicy, TrackedAnime } from "~/model/types"
import type { GlobalSettings } from "~/settings/schema"
import {
    episodeProgressKey,
    latestEpisode,
    latestEpisodeNumber,
    nextEpisode,
    titleOf,
    unwatchedCount,
    watchState
} from "~/model/keys"
import { relativeFuture, relativePast } from "~/shared/time"
import SchedulePicker from "./SchedulePicker.vue"
import SettingsPanel from "./SettingsPanel.vue"
import SourcesPanel from "./SourcesPanel.vue"
import TrackerDialog from "./TrackerDialog.vue"
import RowMenu, { type MenuItem } from "./RowMenu.vue"
import ConfirmDialog from "./ConfirmDialog.vue"
import SearchPanel from "./SearchPanel.vue"
import { groupSeries, groupLatest, groupPosition, groupUnwatched, preferredEntry } from "~/library/grouping"
import type { SeriesGroup } from "~/library/grouping"

const props = withDefaults(defineProps<{ variant?: "popup" | "page" }>(), { variant: "popup" })

const library = ref<TrackedAnime[]>([])
const sources = ref<SourceDescriptor[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const busy = ref(new Set<string>())

type Sort = GlobalSettings["listSort"]

/**
 * Text filter is deliberately *not* persisted: it is how you find one series
 * right now, and finding the list still filtered tomorrow reads as an empty
 * library. Everything else here is a preference and is stored.
 */
const filter = ref("")
const sort = ref<Sort>("recent")
const onlyUnwatched = ref(false)
const sourceFilter = ref("")
/** False until settings have loaded, so restoring them doesn't look like a change. */
const controlsReady = ref(false)

const scheduleFor = ref<string | null>(null)
const episodesFor = ref<string | null>(null)
const showSettings = ref(false)
const showSearch = ref(false)
/** Groups the viewer has opened. Collapsed is the default — the point is fewer rows. */
const expanded = ref(new Set<string>())
const grouping = ref(true)
const checking = ref(false)
const pendingRemoval = ref<TrackedAnime | null>(null)
const trackerFor = ref<TrackedAnime | null>(null)

const sourceName = (id: string) => sources.value.find(s => s.id === id)?.name ?? id

/** Sources that actually have something in the library — the rest are noise. */
const usedSources = computed(() => {
    const ids = new Set(library.value.map(a => a.sourceId))
    return sources.value.filter(source => ids.has(source.id))
})

const visible = computed(() => {
    const needle = filter.value.trim().toLowerCase()
    let list = library.value
    if (needle !== "") list = list.filter(a => titleOf(a).toLowerCase().includes(needle))
    if (onlyUnwatched.value) list = list.filter(a => watchState(a) === "new")
    if (sourceFilter.value !== "") list = list.filter(a => a.sourceId === sourceFilter.value)

    const sorted = [...list]
    switch (sort.value) {
        case "title":
            return sorted.sort((a, b) => titleOf(a).localeCompare(titleOf(b)))
        case "unwatched":
            return sorted.sort((a, b) => unwatchedCount(b) - unwatchedCount(a))
        case "next-check":
            return sorted.sort((a, b) => a.nextCheckAt - b.nextCheckAt)
        case "added":
            return sorted.sort((a, b) => b.addedAt - a.addedAt)
        default:
            return sorted.sort((a, b) => b.lastEpisodeFoundAt - a.lastEpisodeFoundAt || b.addedAt - a.addedAt)
    }
})

/**
 * One row per show rather than per source.
 *
 * Sorting happens on entries first so the group order follows it — grouping
 * preserves the order it was handed, so a group sits where its best entry would
 * have.
 */
const groups = computed(() => groupSeries(visible.value, { enabled: grouping.value }))

const isExpanded = (id: string) => expanded.value.has(id)

function toggleGroup(id: string) {
    const next = new Set(expanded.value)
    if (!next.delete(id)) next.add(id)
    expanded.value = next
}

/** Which entries of a group to draw: all of them unless it is a collapsed group. */
function rowsOf(group: SeriesGroup<TrackedAnime>): TrackedAnime[] {
    if (group.entries.length === 1) return group.entries
    return isExpanded(group.id) ? group.entries : []
}

/**
 * What the group header's watch button does: open the next episode from
 * whichever source actually carries it.
 */
function groupWatch(group: SeriesGroup<TrackedAnime>): { label: string; url?: string; title: string } {
    const entry = preferredEntry(group)
    if (!entry) return { label: "No episodes", title: "No source returned any episodes yet" }

    const from = groupPosition(group)
    const next = [...entry.episodes]
        .filter(episode => from === null || episode.number > from)
        .sort((a, b) => a.number - b.number)[0]

    if (!next) {
        const latest = groupLatest(group)
        return { label: "Up to date", title: latest === null ? "Caught up" : `Caught up at episode ${latest}` }
    }
    return {
        label: from === null ? `Start at E${next.number}` : `Watch E${next.number}`,
        title: `On ${sourceName(entry.sourceId)}${from === null ? "" : ` — furthest watched is episode ${from}`}`,
        url: next.url
    }
}

/** Descending, so the newest episode is the first thing in the picker. */
function episodesOf(anime: TrackedAnime): Episode[] {
    return [...anime.episodes].sort((a, b) => b.number - a.number)
}

function episodeState(anime: TrackedAnime, episode: Episode): "watched" | "current" | "new" {
    if (anime.progress[episodeProgressKey(episode)]?.completed) return "watched"
    const from = anime.lastWatched?.number
    if (from === undefined) return "new"
    if (episode.number === from) return "current"
    return episode.number > from ? "new" : "watched"
}

/**
 * How much of a series this source carries, said so it cannot be misread.
 *
 * "121 ep" sitting next to "at E476" reads as a contradiction, and it is the
 * kind that makes you distrust the whole row. Both numbers are correct and they
 * are answers to different questions: myanime.live publishes episodes 356 to 476
 * of Wan Jie Du Zun and nothing earlier, so the count is 121 and the newest is
 * 476. A row showing only the count looks like it lost four hundred episodes.
 *
 * When the list really does run 1..n the two agree and the short form is used,
 * which is the common case and stays short.
 */
function episodeSpan(anime: TrackedAnime): { label: string; heading: string; title: string } {
    const newest = latestEpisodeNumber(anime)
    if (newest === null) {
        return {
            label: "no episodes",
            heading: "No episodes",
            title: "This source has not returned an episode list yet"
        }
    }

    const count = anime.episodes.length
    const earliest = anime.episodes.reduce((lo, ep) => Math.min(lo, ep.number), newest)

    if (count === newest && earliest === 1) {
        return { label: `${count} ep`, heading: `${count} episodes`, title: `Episodes 1 to ${newest}` }
    }

    return {
        label: `${count} ep, newest E${newest}`,
        heading: `${count} episodes, E${earliest} to E${newest}`,
        title:
            `${count} episodes listed, E${earliest} to E${newest}. That is everything this source ` +
            `carries for the series — the missing ones are not published here.`
    }
}

const newEpisodes = computed(() => library.value.reduce((n, a) => (a.follow ? n + unwatchedCount(a) : n), 0))
const seriesWithNew = computed(() => library.value.filter(a => watchState(a) === "new").length)

async function load() {
    loading.value = true
    error.value = null
    try {
        const [list, srcs] = await Promise.all([send("library:list", {}), send("sources:list", {})])
        library.value = list
        sources.value = srcs
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
    } finally {
        loading.value = false
    }
}

/** Quiet reload: no spinner, for refreshes the user did not ask for. */
async function reload() {
    try {
        library.value = await send("library:list", {})
    } catch {
        // A failed background refresh should leave what is on screen alone.
    }
}

/** Restore the list controls, then keep them saved as they change. */
async function restoreControls() {
    try {
        const settings = await send("settings:get", {})
        sort.value = settings.listSort
        onlyUnwatched.value = settings.listOnlyUnwatched
        sourceFilter.value = settings.listSourceFilter
        grouping.value = settings.groupBySeries
    } catch {
        // Defaults are fine; this is a convenience, not state that matters.
    } finally {
        controlsReady.value = true
    }
}

watch([sort, onlyUnwatched, sourceFilter, grouping], () => {
    if (!controlsReady.value) return
    void send("settings:patch", {
        patch: {
            listSort: sort.value,
            listOnlyUnwatched: onlyUnwatched.value,
            listSourceFilter: sourceFilter.value,
            groupBySeries: grouping.value
        }
    }).catch(() => undefined)
})

const isBusy = (key: string) => busy.value.has(key)

async function withBusy(key: string, fn: () => Promise<void>) {
    busy.value = new Set(busy.value).add(key)
    try {
        await fn()
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
    } finally {
        const done = new Set(busy.value)
        done.delete(key)
        busy.value = done
    }
}

function replace(updated: TrackedAnime | null) {
    if (updated) library.value = library.value.map(a => (a.key === updated.key ? updated : a))
}

function flash(message: string) {
    notice.value = message
    setTimeout(() => (notice.value = null), 6000)
}

// ---------------------------------------------------------------- actions

const refresh = (a: TrackedAnime) => withBusy(a.key, async () => replace(await send("library:refresh", { key: a.key })))

const toggleFollow = (a: TrackedAnime) =>
    withBusy(a.key, async () => replace(await send("library:setFlags", { key: a.key, follow: !a.follow })))

const togglePoll = (a: TrackedAnime) =>
    withBusy(a.key, async () => replace(await send("library:setFlags", { key: a.key, poll: !a.poll })))

const setSchedule = (a: TrackedAnime, schedule: SchedulePolicy) =>
    withBusy(a.key, async () => replace(await send("library:setSchedule", { key: a.key, schedule })))

const catchUp = (a: TrackedAnime) =>
    withBusy(a.key, async () => {
        const latest = latestEpisode(a)
        if (!latest) return
        replace(
            await send("library:markWatched", {
                key: a.key,
                number: latest.number,
                ...(latest.variant ? { variant: latest.variant } : {})
            })
        )
    })

/** Open one episode from the picker. */
function watchEpisode(a: TrackedAnime, number: number) {
    const episode = a.episodes.find(ep => ep.number === number)
    if (episode) open(episode.url)
}

/**
 * Move the pointer deliberately, in either direction.
 *
 * Distinct from opening an episode, which only ever moves forward — the two are
 * different intentions and conflating them is what made watching episode 157 of
 * a series you were caught up at 160 on look like losing your place.
 */
const setPosition = (a: TrackedAnime, number: number) =>
    withBusy(a.key, async () => {
        const episode = a.episodes.find(ep => ep.number === number)
        replace(
            await send("library:markWatched", {
                key: a.key,
                number,
                ...(episode?.variant ? { variant: episode.variant } : {}),
                force: true
            })
        )
        flash(`${titleOf(a)} — position set to episode ${number}`)
    })

const resetWatch = (a: TrackedAnime) =>
    withBusy(a.key, async () => {
        replace(await send("library:resetWatch", { key: a.key }))
        flash(`${titleOf(a)} is back to unstarted`)
    })

async function confirmRemoval() {
    const target = pendingRemoval.value
    pendingRemoval.value = null
    if (!target) return
    await withBusy(target.key, async () => {
        await send("library:remove", { key: target.key })
        library.value = library.value.filter(x => x.key !== target.key)
        flash(`Removed ${titleOf(target)}`)
    })
}

async function checkAll() {
    checking.value = true
    error.value = null
    try {
        const found = await send("library:checkAll", { force: true })
        flash(found === 0 ? "Checked everything — nothing new" : `${found} series updated`)
        await load()
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
    } finally {
        checking.value = false
    }
}

const open = (url: string) => void send("tab:open", { url })

/** The full library owns the search panel; the popup is too narrow for results. */
function openSearch() {
    if (props.variant !== "page") {
        void send("tab:openLibrary", {})
        return
    }
    showSearch.value = !showSearch.value
    if (showSearch.value) {
        showSettings.value = false
        window.scrollTo({ top: 0, behavior: "smooth" })
    }
}

function onAdded(anime: TrackedAnime) {
    // Insert rather than reload: a search result added while three sources are
    // still returning should not take the results away.
    if (!library.value.some(existing => existing.key === anime.key)) {
        library.value = [anime, ...library.value]
    }
    flash(`Following ${titleOf(anime)}`)
}

function openSettings() {
    if (props.variant !== "page") {
        void send("tab:openLibrary", {})
        return
    }
    showSettings.value = !showSettings.value
    if (showSettings.value) showSearch.value = false
    // Settings open above the list. Opening them from halfway down a long
    // library otherwise puts you in the middle of a panel you have not seen the
    // top of.
    if (showSettings.value) window.scrollTo({ top: 0, behavior: "smooth" })
}

/** States the viewer needs to see even when they aren't acting on them. */
function stateTags(a: TrackedAnime): { label: string; tone: "warn" | "muted" }[] {
    const tags: { label: string; tone: "warn" | "muted" }[] = []
    if (!a.follow) tags.push({ label: "not followed", tone: "muted" })
    if (!a.poll) tags.push({ label: "not checking", tone: "muted" })
    if (a.overrides.schedule) tags.push({ label: "custom schedule", tone: "muted" })
    if (a.failCount > 0) tags.push({ label: `${a.failCount} failed check${a.failCount > 1 ? "s" : ""}`, tone: "warn" })
    if (a.airing) tags.push({ label: `ep ${a.airing.episode} ${relativeFuture(a.airing.at)}`, tone: "muted" })
    return tags
}

/**
 * Everything that isn't the one thing you came to do. Kept in a menu because a
 * row of six buttons stops being scannable the moment the library is real, and
 * destructive actions should not sit next to routine ones.
 */
function menuFor(a: TrackedAnime): MenuItem[] {
    return [
        { label: "Refresh episode list", action: () => void refresh(a) },
        {
            label: "Mark as caught up",
            disabled: watchState(a) !== "new",
            hint: "Move your position to the newest episode",
            action: () => void catchUp(a)
        },
        { label: "Following", checked: a.follow, separated: true, action: () => void toggleFollow(a) },
        { label: "Checking for new episodes", checked: a.poll, action: () => void togglePoll(a) },
        {
            label: "Episodes…",
            disabled: a.episodes.length === 0,
            hint: "Pick one to watch, or set where you are",
            action: () => (episodesFor.value = episodesFor.value === a.key ? null : a.key)
        },
        {
            label: "Schedule…",
            checked: Boolean(a.overrides.schedule),
            action: () => (scheduleFor.value = scheduleFor.value === a.key ? null : a.key)
        },
        {
            label: a.anilistId ? "Change AniList match…" : "Match on AniList…",
            checked: Boolean(a.anilistId),
            separated: true,
            hint: a.anilistId ? undefined : "Poster, canonical title and air times",
            action: () => (trackerFor.value = a)
        },
        { label: "Open series page", action: () => open(a.url) },
        {
            label: "Reset watch status",
            disabled: !a.lastWatched,
            hint: "Back to unstarted — keeps the series and its settings",
            action: () => void resetWatch(a)
        },
        { label: "Remove from library…", danger: true, separated: true, action: () => (pendingRemoval.value = a) }
    ]
}

function watchAction(a: TrackedAnime): { label: string; title: string; url?: string } {
    const state = watchState(a)
    if (state === "unstarted") return { label: "No episodes", title: "The source returned no episodes yet" }

    const next = nextEpisode(a)
    if (!next) {
        const latest = latestEpisode(a)
        return {
            label: "Up to date",
            title: latest ? `Caught up at episode ${latest.number}` : "Caught up",
            ...(latest ? { url: latest.url } : {})
        }
    }
    return {
        label: a.lastWatched ? `Watch E${next.number}` : `Start at E${next.number}`,
        title: a.lastWatched
            ? `Last watched episode ${a.lastWatched.number}`
            : "Never opened — this starts at the earliest episode",
        url: next.url
    }
}

/*
 * Anything can change the library while this is open: a series added by opening
 * an episode on a site, a scheduled check finding something, the player moving
 * the watch position. The background says so and the list re-reads itself —
 * without this, a library tab left open shows yesterday's state until reloaded
 * by hand.
 */
let unsubscribe: (() => void) | null = null

onMounted(async () => {
    if (props.variant === "page" && window.location.hash === "#settings") showSettings.value = true
    unsubscribe = onLibraryChanged(() => void reload())
    // A popup is destroyed and rebuilt constantly, so it always arrives fresh;
    // a long-lived tab can miss a broadcast while the worker was asleep.
    if (props.variant === "page") {
        document.addEventListener("visibilitychange", onVisible)
    }
    await Promise.all([load(), restoreControls()])
})

function onVisible() {
    if (document.visibilityState === "visible") void reload()
}

onBeforeUnmount(() => {
    unsubscribe?.()
    document.removeEventListener("visibilitychange", onVisible)
})

defineExpose({ load })
</script>

<template>
    <div class="library" :class="variant">
        <header>
            <div class="brand">
                <span class="mark" aria-hidden="true"></span>
                <h1>All Anime Watcher</h1>
            </div>
            <div class="head-meta">
                <span v-if="newEpisodes > 0" class="pill accent">{{ newEpisodes }} new in {{ seriesWithNew }}</span>
                <span class="pill">{{ library.length }} tracked</span>

                <button
                    class="btn icon"
                    :disabled="checking || library.length === 0"
                    :title="checking ? 'Checking…' : 'Check every series now'"
                    @click="checkAll"
                >
                    <span :class="{ spin: checking }">⟳</span>
                </button>
                <button
                    class="btn icon"
                    :class="{ primary: showSearch }"
                    :title="variant === 'page' ? 'Find a series to follow' : 'Find a series (opens the full library)'"
                    @click="openSearch"
                >
                    ⌕
                </button>
                <button class="btn icon" title="Reload the list" @click="load">↻</button>
                <button
                    v-if="variant === 'popup'"
                    class="btn icon"
                    title="Open the full library"
                    @click="send('tab:openLibrary', {})"
                >
                    ⤢
                </button>
                <button
                    class="btn icon"
                    :class="{ primary: showSettings }"
                    :title="variant === 'page' ? 'Settings' : 'Settings (opens the full library)'"
                    @click="openSettings"
                >
                    ⚙
                </button>
            </div>
        </header>

        <SearchPanel
            v-if="showSearch && variant === 'page'"
            :library="library"
            :sources="sources"
            @added="onAdded"
            @close="showSearch = false"
        />

        <SettingsPanel v-if="showSettings && variant === 'page'" />
        <SourcesPanel v-if="showSettings && variant === 'page'" />

        <div v-if="library.length > 1" class="controls-row">
            <input v-model="filter" type="search" placeholder="Filter by title" aria-label="Filter by title" />
            <select v-if="usedSources.length > 1" v-model="sourceFilter" aria-label="Filter by source">
                <option value="">All sources</option>
                <option v-for="source in usedSources" :key="source.id" :value="source.id">{{ source.name }}</option>
            </select>
            <select v-model="sort" aria-label="Sort by">
                <option value="recent">Newest episode</option>
                <option value="title">Title</option>
                <option value="unwatched">Most unwatched</option>
                <option value="next-check">Next check</option>
                <option value="added">Recently added</option>
            </select>
            <button
                class="btn"
                :class="{ primary: onlyUnwatched }"
                title="Show only series with something new"
                @click="onlyUnwatched = !onlyUnwatched"
            >
                Unwatched
            </button>
        </div>

        <p v-if="error" class="banner error">{{ error }}</p>
        <p v-if="notice" class="banner subtle">{{ notice }}</p>
        <p v-if="loading" class="banner">Loading…</p>

        <div v-else-if="library.length === 0" class="empty">
            <p class="empty-title">Nothing tracked yet</p>
            <p>
                Open an episode on a supported site and it gets added automatically. Right now that means
                <template v-for="(s, i) in sources" :key="s.id"
                    ><a href="#" @click.prevent="open(s.home)">{{ s.name }}</a
                    ><span v-if="i < sources.length - 1">, </span></template
                >.
            </p>
        </div>

        <ul v-else class="list">
            <template v-for="group in groups" :key="group.id">
                <li v-if="group.entries.length > 1" class="row group" :data-open="isExpanded(group.id)">
                    <span class="stripe" aria-hidden="true"></span>

                    <div class="poster">
                        <img v-if="group.poster" :src="group.poster" alt="" loading="lazy" />
                    </div>

                    <div class="body">
                        <div class="title-row">
                            <button class="title" :title="group.title" @click="toggleGroup(group.id)">
                                {{ group.title }}
                            </button>
                            <span v-if="groupUnwatched(group) > 0" class="pill accent tight">
                                +{{ groupUnwatched(group) }}
                            </span>
                        </div>

                        <div class="meta">
                            <span>{{ group.entries.map(e => sourceName(e.sourceId)).join(" · ") }}</span>
                            <span class="sep">·</span>
                            <span v-if="groupLatest(group) !== null">newest E{{ groupLatest(group) }}</span>
                            <span class="sep">·</span>
                            <span v-if="groupPosition(group) !== null">at E{{ groupPosition(group) }}</span>
                            <span v-else class="faint">not started</span>
                        </div>

                        <div class="actions">
                            <button
                                class="btn"
                                :class="{ primary: groupUnwatched(group) > 0 }"
                                :disabled="!groupWatch(group).url"
                                :title="groupWatch(group).title"
                                @click="open(groupWatch(group).url!)"
                            >
                                {{ groupWatch(group).label }}
                            </button>
                            <span class="grow"></span>
                            <button class="btn expander" @click="toggleGroup(group.id)">
                                {{ isExpanded(group.id) ? "Hide" : "Show" }} {{ group.entries.length }} sources
                                <span class="caret">{{ isExpanded(group.id) ? "▴" : "▾" }}</span>
                            </button>
                        </div>
                    </div>
                </li>

                <li
                    v-for="a in rowsOf(group)"
                    :key="a.key"
                    class="row"
                    :class="{ nested: group.entries.length > 1 }"
                    :data-state="watchState(a)"
                >
                    <span class="stripe" aria-hidden="true"></span>

                    <div class="poster">
                        <img v-if="a.poster" :src="a.poster" alt="" loading="lazy" />
                    </div>

                    <div class="body">
                        <div class="title-row">
                            <button class="title" :title="titleOf(a)" @click="open(a.url)">{{ titleOf(a) }}</button>
                            <span v-if="watchState(a) === 'new'" class="pill accent tight"
                                >+{{ unwatchedCount(a) }}</span
                            >
                        </div>

                        <div class="meta">
                            <span>{{ sourceName(a.sourceId) }}</span>
                            <span class="sep">·</span>
                            <span :title="episodeSpan(a).title">{{ episodeSpan(a).label }}</span>
                            <span class="sep">·</span>
                            <span v-if="a.lastWatched">at E{{ a.lastWatched.number }}</span>
                            <span v-else class="faint">not started</span>
                            <span class="sep">·</span>
                            <span :title="a.lastCheckedAt ? new Date(a.lastCheckedAt).toLocaleString() : ''">
                                checked {{ relativePast(a.lastCheckedAt) }}
                            </span>
                            <span class="sep">·</span>
                            <span :title="a.nextCheckAt ? new Date(a.nextCheckAt).toLocaleString() : ''">
                                next {{ relativeFuture(a.nextCheckAt) }}
                            </span>
                        </div>

                        <div v-if="stateTags(a).length > 0" class="tags">
                            <span v-for="tag in stateTags(a)" :key="tag.label" class="tag" :class="tag.tone">
                                {{ tag.label }}
                            </span>
                        </div>

                        <p v-if="a.lastError" class="row-error" :title="a.lastError">Last check failed</p>

                        <div class="actions">
                            <button
                                class="btn"
                                :class="{ primary: watchState(a) === 'new' }"
                                :disabled="isBusy(a.key) || !watchAction(a).url"
                                :title="watchAction(a).title"
                                @click="open(watchAction(a).url!)"
                            >
                                {{ watchAction(a).label }}
                            </button>
                            <span v-if="isBusy(a.key)" class="working">working…</span>
                            <span class="grow"></span>
                            <RowMenu :items="menuFor(a)" :label="`Actions for ${titleOf(a)}`" />
                        </div>

                        <div v-if="episodesFor === a.key" class="episodes-panel">
                            <div class="panel-head">
                                <span class="panel-title" :title="episodeSpan(a).title">{{ episodeSpan(a).heading }}</span>
                                <button class="btn tiny" @click="episodesFor = null">Close</button>
                            </div>
                            <div class="episode-grid">
                                <button
                                    v-for="ep in episodesOf(a)"
                                    :key="`${ep.number}-${ep.variant ?? ''}`"
                                    class="ep"
                                    :data-state="episodeState(a, ep)"
                                    :title="`${ep.title ?? `Episode ${ep.number}`}${ep.variant ? ` · ${ep.variant}` : ''} — click to watch`"
                                    @click="watchEpisode(a, ep.number)"
                                >
                                    {{ ep.number }}
                                </button>
                            </div>
                            <label class="set-position">
                                <span>I'm at episode</span>
                                <select
                                    :value="a.lastWatched?.number ?? ''"
                                    @change="setPosition(a, Number(($event.target as HTMLSelectElement).value))"
                                >
                                    <option value="" disabled>not started</option>
                                    <option v-for="ep in episodesOf(a)" :key="ep.number" :value="ep.number">
                                        Episode {{ ep.number }}
                                    </option>
                                </select>
                            </label>
                        </div>

                        <div v-if="scheduleFor === a.key" class="schedule">
                            <SchedulePicker
                                allow-inherit
                                inherited-label="global default"
                                :model-value="a.overrides.schedule ?? { mode: 'inherit' }"
                                @update:model-value="value => setSchedule(a, value)"
                            />
                        </div>
                    </div>
                </li>
            </template>
        </ul>

        <TrackerDialog
            :anime="trackerFor"
            @close="trackerFor = null"
            @updated="
                value => {
                    replace(value)
                    trackerFor = null
                }
            "
        />

        <ConfirmDialog
            :open="pendingRemoval !== null"
            danger
            confirm-label="Remove"
            :title="`Remove ${pendingRemoval ? titleOf(pendingRemoval) : ''}?`"
            body="This forgets the series, your position in it, and its watch history. Opening an episode again will re-add it from scratch."
            @cancel="pendingRemoval = null"
            @confirm="confirmRemoval"
        />
    </div>
</template>

<style scoped>
.library {
    display: flex;
    flex-direction: column;
}

.library.popup {
    width: 440px;
    max-height: 580px;
    overflow-y: auto;
}

.library.page {
    max-width: 900px;
    margin: 0 auto;
    min-height: 100vh;
}

header {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap);
    padding: 12px 14px;
    background: var(--surface);
    border-bottom: 1px solid var(--rule);
}

.page header {
    padding: 18px 16px;
}

.brand {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
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
    letter-spacing: -0.01em;
    white-space: nowrap;
}

.page h1 {
    font-size: 17px;
}

.head-meta {
    display: flex;
    align-items: center;
    gap: 5px;
}

.pill {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.03em;
    padding: 2px 6px;
    border-radius: 3px;
    background: var(--surface-2);
    color: var(--ink-3);
    white-space: nowrap;
}

.pill.accent {
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-weight: 700;
}

.spin {
    display: inline-block;
    animation: spin 1s linear infinite;
}

@keyframes spin {
    to {
        transform: rotate(360deg);
    }
}

@media (prefers-reduced-motion: reduce) {
    .spin {
        animation: none;
    }
}

.controls-row {
    display: flex;
    gap: 6px;
    padding: 10px 14px 0;
}

.controls-row input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 6px 9px;
    font: inherit;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}

.controls-row select {
    font: inherit;
    font-size: 12px;
    color: var(--ink-2);
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    padding: 0 4px;
}

.controls-row .btn {
    font-size: 11px;
}

.banner {
    margin: 12px 14px;
    color: var(--ink-3);
}

.banner.error {
    color: var(--danger);
    background: var(--danger-soft);
    padding: 8px 10px;
    border-radius: var(--radius);
}

.banner.subtle {
    margin: 10px 14px 0;
    font-size: 11px;
    color: var(--accent-ink);
}

.empty {
    padding: 28px 20px;
    color: var(--ink-2);
}

.empty-title {
    margin: 0 0 6px;
    font-weight: 600;
    color: var(--ink);
}

.empty p {
    margin: 0 0 8px;
}

.list {
    list-style: none;
    margin: 0;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.row {
    position: relative;
    display: grid;
    grid-template-columns: 46px minmax(0, 1fr);
    gap: 10px;
    padding: 10px 10px 10px 13px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
}

.stripe {
    position: absolute;
    inset: 0 auto 0 0;
    width: 3px;
    border-radius: var(--radius) 0 0 var(--radius);
}

/*
 * The three states have to be separable at a glance across a long list, and a
 * 3px stripe in two shades of blue-green was not: "has new episodes" and "caught
 * up" read as the same row. So they differ in more than hue — the one that wants
 * attention is green, wider and tinted; the one that wants none is quiet.
 */
.row[data-state="new"] {
    background: var(--state-new-soft);
    border-color: var(--state-new-rule);
}

.row[data-state="new"] .stripe {
    background: var(--state-new);
    width: 4px;
}

.row[data-state="current"] .stripe {
    background: var(--state-current);
    opacity: 0.55;
}

.row[data-state="unstarted"] .stripe {
    background: var(--state-warn);
}

.row[data-state="paused"] {
    opacity: 0.66;
}

.row[data-state="paused"] .stripe {
    background: var(--ink-3);
}

/*
 * A group header is a row that stands for several. It reads as one thing with
 * the sources tucked under it, rather than as a heading floating above unrelated
 * rows — which is what an unindented list of the same entries looked like.
 */
.row.group[data-open="true"] {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
}

.row.nested {
    margin-left: 22px;
    box-shadow: none;
}

.expander {
    font-size: 10px;
    color: var(--ink-3);
}

.caret {
    margin-left: 3px;
}

.episodes-panel {
    margin-top: 8px;
    padding: 10px;
    background: var(--ground);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}

.panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
}

.panel-title {
    font-size: 11px;
    color: var(--ink-3);
}

.btn.tiny {
    font-size: 10px;
    padding: 2px 6px;
}

.episode-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-height: 168px;
    overflow-y: auto;
}

.ep {
    font-family: var(--mono);
    font-size: 11px;
    min-width: 34px;
    padding: 3px 5px;
    border: 1px solid var(--rule);
    border-radius: 4px;
    background: var(--surface);
    color: var(--ink-2);
    cursor: pointer;
}

.ep:hover {
    border-color: var(--accent);
    color: var(--accent-ink);
}

.ep[data-state="watched"] {
    color: var(--ink-3);
    opacity: 0.6;
}

.ep[data-state="current"] {
    border-color: var(--state-current);
    color: var(--ink);
    font-weight: 700;
}

.ep[data-state="new"] {
    border-color: var(--state-new-rule);
    color: var(--ink);
}

.set-position {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--rule);
    font-size: 11px;
    color: var(--ink-3);
}

.set-position select {
    font: inherit;
    font-size: 11px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 4px;
    padding: 2px 4px;
}

.poster {
    width: 46px;
    height: 62px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--surface-2);
}

.page .poster {
    width: 60px;
    height: 82px;
}

.page .row {
    grid-template-columns: 60px minmax(0, 1fr);
}

.poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
}

.body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.title-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
}

.title {
    font-weight: 600;
    text-align: left;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.page .title {
    font-size: 14px;
}

.title:hover {
    color: var(--accent-ink);
}

.meta {
    font-size: 11px;
    color: var(--ink-3);
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}

.sep {
    opacity: 0.5;
}

.faint {
    font-style: italic;
}

.tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}

.tag {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--surface-2);
    color: var(--ink-3);
}

.tag.warn {
    color: var(--state-warn);
}

.row-error {
    margin: 2px 0 0;
    font-size: 11px;
    color: var(--danger);
}

.actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
}

.actions .btn {
    font-size: 11px;
    padding: 3px 8px;
}

.grow {
    flex: 1 1 auto;
}

.working {
    font-size: 10px;
    color: var(--ink-3);
}

.schedule {
    margin-top: 8px;
    padding: 10px;
    background: var(--ground);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}
</style>
