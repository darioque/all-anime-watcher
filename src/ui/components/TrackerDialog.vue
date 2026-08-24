<script setup lang="ts">
import { ref, watch } from "vue"
import { send } from "~/shared/messages"
import type { TrackedAnime } from "~/model/types"
import { titleOf } from "~/model/keys"

const props = defineProps<{ anime: TrackedAnime | null }>()
const emit = defineEmits<{ close: []; updated: [TrackedAnime] }>()

interface Candidate {
    id: number
    title: string
    year?: number
    format?: string
    episodes?: number
    cover?: string
    score: number
}

const candidates = ref<Candidate[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

/**
 * Reload whenever the dialog opens on a different series. Matching is a network
 * round trip, so it happens on open rather than eagerly for every row.
 */
watch(
    () => props.anime?.key,
    async key => {
        if (!key) return
        loading.value = true
        error.value = null
        candidates.value = []
        try {
            candidates.value = await send("tracker:matches", { key })
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e)
        } finally {
            loading.value = false
        }
    },
    { immediate: true }
)

async function choose(id: number) {
    if (!props.anime) return
    loading.value = true
    try {
        const updated = await send("tracker:link", { key: props.anime.key, anilistId: id })
        if (updated) emit("updated", updated)
        emit("close")
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
    } finally {
        loading.value = false
    }
}

async function clear() {
    if (!props.anime) return
    loading.value = true
    try {
        const updated = await send("tracker:unlink", { key: props.anime.key })
        if (updated) emit("updated", updated)
        emit("close")
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
    } finally {
        loading.value = false
    }
}

/** Wording rather than a bare number — 0.93 means nothing to a reader. */
function confidence(score: number): string {
    if (score >= 0.9) return "near-certain"
    if (score >= 0.7) return "likely"
    if (score >= 0.45) return "possible"
    return "unlikely"
}
</script>

<template>
    <div v-if="anime" class="scrim" role="dialog" aria-modal="true" @click.self="emit('close')">
        <div class="dialog">
            <header>
                <h3>Match “{{ titleOf(anime) }}” on AniList</h3>
                <button class="btn icon" title="Close" @click="emit('close')">✕</button>
            </header>

            <p class="note">
                Linking pulls in a poster, the canonical title and — if you use the air-time schedule — when the next
                episode is due. Nothing is sent to AniList.
            </p>

            <p v-if="anime.anilistId" class="linked">
                Currently linked to AniList
                <a :href="`https://anilist.co/anime/${anime.anilistId}`" target="_blank" rel="noreferrer">
                    #{{ anime.anilistId }}</a
                >{{ anime.trackerConfirmed ? " (confirmed by you)" : " (matched automatically)" }}.
            </p>

            <p v-if="error" class="error">{{ error }}</p>
            <p v-if="loading" class="muted">Searching…</p>

            <ul v-else-if="candidates.length > 0" class="list">
                <li v-for="candidate in candidates" :key="candidate.id">
                    <button
                        class="row"
                        :class="{ current: candidate.id === anime.anilistId }"
                        @click="choose(candidate.id)"
                    >
                        <span class="cover">
                            <img v-if="candidate.cover" :src="candidate.cover" alt="" loading="lazy" />
                        </span>
                        <span class="body">
                            <span class="title">{{ candidate.title }}</span>
                            <span class="meta">
                                <span v-if="candidate.format">{{ candidate.format }}</span>
                                <span v-if="candidate.year">· {{ candidate.year }}</span>
                                <span v-if="candidate.episodes">· {{ candidate.episodes }} ep</span>
                                <span class="sep">·</span>
                                <span :data-confidence="confidence(candidate.score)">{{
                                    confidence(candidate.score)
                                }}</span>
                            </span>
                        </span>
                    </button>
                </li>
            </ul>

            <p v-else-if="!loading" class="muted">
                No matches. This is common for donghua, which AniList often lists under a different romanisation.
            </p>

            <footer>
                <button v-if="anime.anilistId" class="btn danger" @click="clear">Unlink</button>
                <span class="spacer"></span>
                <button class="btn" @click="emit('close')">Close</button>
            </footer>
        </div>
    </div>
</template>

<style scoped>
.scrim {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    background: rgba(8, 12, 15, 0.55);
}

.dialog {
    width: 100%;
    max-width: 520px;
    max-height: 80vh;
    overflow-y: auto;
    padding: 16px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    box-shadow: 0 18px 44px -16px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    gap: 10px;
}

header {
    display: flex;
    align-items: flex-start;
    gap: 10px;
}

h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    flex: 1 1 auto;
}

.note,
.linked,
.muted {
    margin: 0;
    font-size: 11px;
    color: var(--ink-3);
    line-height: 1.5;
}

.linked {
    color: var(--ink-2);
}

.error {
    margin: 0;
    color: var(--danger);
    background: var(--danger-soft);
    padding: 8px 10px;
    border-radius: var(--radius);
    font-size: 12px;
}

.list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.row {
    display: flex;
    gap: 10px;
    width: 100%;
    padding: 6px;
    border: 1px solid transparent;
    border-radius: var(--radius);
    background: none;
    cursor: pointer;
    text-align: left;
}

.row:hover {
    background: var(--surface-2);
    border-color: var(--rule);
}

.row.current {
    border-color: var(--accent);
    background: var(--accent-soft);
}

.cover {
    width: 38px;
    height: 52px;
    flex: 0 0 auto;
    border-radius: 3px;
    overflow: hidden;
    background: var(--surface-2);
}

.cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
}

.body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    justify-content: center;
}

.title {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
}

.meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    font-size: 11px;
    color: var(--ink-3);
}

[data-confidence="near-certain"] {
    color: var(--accent-ink);
    font-weight: 600;
}

[data-confidence="unlikely"] {
    color: var(--state-warn);
}

.sep {
    opacity: 0.5;
}

footer {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 4px;
}

.spacer {
    flex: 1 1 auto;
}

.btn.danger {
    color: var(--danger);
    border-color: var(--rule);
}
</style>
