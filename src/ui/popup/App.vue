<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { send } from "~/shared/messages"
import type { SourceDescriptor } from "~/shared/messages"
import type { TrackedAnime } from "~/model/types"
import { nextEpisode, titleOf, unwatchedCount } from "~/model/keys"

const library = ref<TrackedAnime[]>([])
const sources = ref<SourceDescriptor[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const busy = ref<Set<string>>(new Set())
const filter = ref("")

const sourceName = (id: string) => sources.value.find(s => s.id === id)?.name ?? id

const visible = computed(() => {
    const needle = filter.value.trim().toLowerCase()
    if (needle === "") return library.value
    return library.value.filter(a => titleOf(a).toLowerCase().includes(needle))
})

const newCount = computed(() => library.value.reduce((n, a) => (a.follow ? n + unwatchedCount(a) : n), 0))

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

function isBusy(key: string) {
    return busy.value.has(key)
}

async function withBusy(key: string, fn: () => Promise<void>) {
    const next = new Set(busy.value)
    next.add(key)
    busy.value = next
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
    if (!updated) return
    library.value = library.value.map(a => (a.key === updated.key ? updated : a))
}

const refresh = (a: TrackedAnime) => withBusy(a.key, async () => replace(await send("library:refresh", { key: a.key })))

const toggleFollow = (a: TrackedAnime) =>
    withBusy(a.key, async () => replace(await send("library:setFlags", { key: a.key, follow: !a.follow })))

const togglePoll = (a: TrackedAnime) =>
    withBusy(a.key, async () => replace(await send("library:setFlags", { key: a.key, poll: !a.poll })))

const remove = (a: TrackedAnime) =>
    withBusy(a.key, async () => {
        await send("library:remove", { key: a.key })
        library.value = library.value.filter(x => x.key !== a.key)
    })

const open = (url: string) => void send("tab:open", { url })

function openNext(a: TrackedAnime) {
    const ep = nextEpisode(a)
    open(ep?.url ?? a.url)
}

function relative(ts: number): string {
    if (!ts) return "never"
    const seconds = Math.floor((Date.now() - ts) / 1000)
    if (seconds < 60) return "just now"
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return days < 30 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`
}

onMounted(load)
</script>

<template>
    <div class="popup">
        <header>
            <div class="brand">
                <span class="mark" aria-hidden="true"></span>
                <h1>All Anime Watcher</h1>
            </div>
            <div class="head-meta">
                <span v-if="newCount > 0" class="pill accent">{{ newCount }} new</span>
                <span class="pill">{{ library.length }} tracked</span>
                <button class="btn icon" title="Reload list" @click="load">↻</button>
            </div>
        </header>

        <div v-if="library.length > 4" class="filter">
            <input v-model="filter" type="search" placeholder="Filter by title" aria-label="Filter by title" />
        </div>

        <p v-if="error" class="banner error">{{ error }}</p>

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
            <li v-for="a in visible" :key="a.key" class="row" :class="{ dim: !a.follow }">
                <div class="poster" :class="{ ph: !a.poster }">
                    <img v-if="a.poster" :src="a.poster" alt="" loading="lazy" />
                </div>

                <div class="body">
                    <div class="title-row">
                        <button class="title" :title="titleOf(a)" @click="open(a.url)">{{ titleOf(a) }}</button>
                        <span v-if="unwatchedCount(a) > 0 && a.follow" class="pill accent tight">
                            +{{ unwatchedCount(a) }}
                        </span>
                    </div>

                    <div class="meta">
                        <span>{{ sourceName(a.sourceId) }}</span>
                        <span class="sep">·</span>
                        <span>{{ a.episodes.length }} ep</span>
                        <span class="sep">·</span>
                        <span :title="a.lastCheckedAt ? new Date(a.lastCheckedAt).toLocaleString() : ''">
                            checked {{ relative(a.lastCheckedAt) }}
                        </span>
                    </div>

                    <p v-if="a.lastError" class="row-error" :title="a.lastError">
                        Last check failed{{ a.failCount > 1 ? ` (${a.failCount}×)` : "" }}
                    </p>

                    <div class="actions">
                        <button class="btn" :disabled="isBusy(a.key)" @click="openNext(a)">Watch next</button>
                        <button class="btn" :disabled="isBusy(a.key)" @click="refresh(a)">
                            {{ isBusy(a.key) ? "…" : "Refresh" }}
                        </button>
                        <button
                            class="btn"
                            :class="{ primary: a.follow }"
                            :disabled="isBusy(a.key)"
                            :title="a.follow ? 'Following — click to unfollow' : 'Not followed'"
                            @click="toggleFollow(a)"
                        >
                            {{ a.follow ? "Following" : "Follow" }}
                        </button>
                        <button
                            class="btn"
                            :class="{ primary: a.poll }"
                            :disabled="isBusy(a.key)"
                            :title="a.poll ? 'Checking for new episodes' : 'Not checking'"
                            @click="togglePoll(a)"
                        >
                            {{ a.poll ? "Checking" : "Paused" }}
                        </button>
                        <button class="btn danger icon" title="Remove" :disabled="isBusy(a.key)" @click="remove(a)">
                            ✕
                        </button>
                    </div>
                </div>
            </li>
        </ul>
    </div>
</template>

<style scoped>
.popup {
    width: 420px;
    max-height: 580px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
}

header {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap);
    padding: 12px 14px;
    background: var(--surface);
    border-bottom: 1px solid var(--rule);
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

.head-meta {
    display: flex;
    align-items: center;
    gap: 6px;
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

.pill.tight {
    flex: 0 0 auto;
}

.filter {
    padding: 10px 14px 0;
}

.filter input {
    width: 100%;
    padding: 6px 9px;
    font: inherit;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
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
    display: grid;
    grid-template-columns: 46px minmax(0, 1fr);
    gap: 10px;
    padding: 10px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
}

.row.dim {
    opacity: 0.62;
}

.poster {
    width: 46px;
    height: 62px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--surface-2);
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

.row-error {
    margin: 2px 0 0;
    font-size: 11px;
    color: var(--danger);
}

.actions {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 4px;
}

.actions .btn {
    font-size: 11px;
    padding: 3px 7px;
}
</style>
