<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { send } from "~/shared/messages"
import type { SourceDescriptor } from "~/shared/messages"
import type { SchedulePolicy, TrackedAnime } from "~/model/types"
import { latestEpisode, nextEpisode, titleOf, unwatchedCount, watchState } from "~/model/keys"
import { relativeFuture, relativePast } from "~/shared/time"
import SchedulePicker from "./SchedulePicker.vue"
import SettingsPanel from "./SettingsPanel.vue"
import RowMenu, { type MenuItem } from "./RowMenu.vue"
import ConfirmDialog from "./ConfirmDialog.vue"

const props = withDefaults(defineProps<{ variant?: "popup" | "page" }>(), { variant: "popup" })

const library = ref<TrackedAnime[]>([])
const sources = ref<SourceDescriptor[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const busy = ref(new Set<string>())

const filter = ref("")
const sort = ref<"recent" | "title" | "unwatched" | "next-check">("recent")
const onlyUnwatched = ref(false)
const scheduleFor = ref<string | null>(null)
const showSettings = ref(false)
const checking = ref(false)
const pendingRemoval = ref<TrackedAnime | null>(null)

const sourceName = (id: string) => sources.value.find(s => s.id === id)?.name ?? id

const visible = computed(() => {
    const needle = filter.value.trim().toLowerCase()
    let list = library.value
    if (needle !== "") list = list.filter(a => titleOf(a).toLowerCase().includes(needle))
    if (onlyUnwatched.value) list = list.filter(a => watchState(a) === "new")

    const sorted = [...list]
    switch (sort.value) {
        case "title":
            return sorted.sort((a, b) => titleOf(a).localeCompare(titleOf(b)))
        case "unwatched":
            return sorted.sort((a, b) => unwatchedCount(b) - unwatchedCount(a))
        case "next-check":
            return sorted.sort((a, b) => a.nextCheckAt - b.nextCheckAt)
        default:
            return sorted.sort((a, b) => b.lastEpisodeFoundAt - a.lastEpisodeFoundAt || b.addedAt - a.addedAt)
    }
})

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

const forgetNewest = (a: TrackedAnime) =>
    withBusy(a.key, async () => {
        replace(await send("library:forgetNewest", { key: a.key, count: 1 }))
        flash(`Forgot the newest episode of ${titleOf(a)} — run “Check all now” to rediscover it`)
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

function openSettings() {
    if (props.variant === "page") showSettings.value = !showSettings.value
    else void send("tab:openLibrary", {})
}

/** States the viewer needs to see even when they aren't acting on them. */
function stateTags(a: TrackedAnime): { label: string; tone: "warn" | "muted" }[] {
    const tags: { label: string; tone: "warn" | "muted" }[] = []
    if (!a.follow) tags.push({ label: "not followed", tone: "muted" })
    if (!a.poll) tags.push({ label: "not checking", tone: "muted" })
    if (a.overrides.schedule) tags.push({ label: "custom schedule", tone: "muted" })
    if (a.failCount > 0) tags.push({ label: `${a.failCount} failed check${a.failCount > 1 ? "s" : ""}`, tone: "warn" })
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
            label: "Schedule…",
            checked: Boolean(a.overrides.schedule),
            action: () => (scheduleFor.value = scheduleFor.value === a.key ? null : a.key)
        },
        { label: "Open series page", separated: true, action: () => open(a.url) },
        {
            label: "Forget newest episode",
            hint: "Developer aid for testing notifications",
            action: () => void forgetNewest(a)
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

onMounted(async () => {
    if (props.variant === "page" && window.location.hash === "#settings") showSettings.value = true
    await load()
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

        <SettingsPanel v-if="showSettings && variant === 'page'" />

        <div v-if="library.length > 1" class="controls-row">
            <input v-model="filter" type="search" placeholder="Filter by title" aria-label="Filter by title" />
            <select v-model="sort" aria-label="Sort by">
                <option value="recent">Newest episode</option>
                <option value="title">Title</option>
                <option value="unwatched">Most unwatched</option>
                <option value="next-check">Next check</option>
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
            <li v-for="a in visible" :key="a.key" class="row" :data-state="watchState(a)">
                <span class="stripe" aria-hidden="true"></span>

                <div class="poster">
                    <img v-if="a.poster" :src="a.poster" alt="" loading="lazy" />
                </div>

                <div class="body">
                    <div class="title-row">
                        <button class="title" :title="titleOf(a)" @click="open(a.url)">{{ titleOf(a) }}</button>
                        <span v-if="watchState(a) === 'new'" class="pill accent tight">+{{ unwatchedCount(a) }}</span>
                    </div>

                    <div class="meta">
                        <span>{{ sourceName(a.sourceId) }}</span>
                        <span class="sep">·</span>
                        <span>{{ a.episodes.length }} ep</span>
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
        </ul>

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

.row[data-state="new"] .stripe {
    background: var(--accent);
}

.row[data-state="current"] .stripe {
    background: var(--state-current);
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
