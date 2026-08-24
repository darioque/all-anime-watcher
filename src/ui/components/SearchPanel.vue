<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { send } from "~/shared/messages"
import type { SourceDescriptor } from "~/shared/messages"
import type { TrackedAnime } from "~/model/types"
import { groupSeries, type Groupable } from "~/library/grouping"

/**
 * Find a series and follow it, without having to open an episode first.
 *
 * Every source is asked at once and results are shown as they land, because one
 * slow site should not hold up three fast ones — and rate-limited sites here are
 * the rule rather than the exception.
 *
 * Results are grouped by show rather than listed per source, using the same
 * rules the library groups by. A search for a popular donghua returns the same
 * thing from four sites, and four near-identical rows is a worse answer than one
 * row that says which four.
 */
const props = defineProps<{ library: TrackedAnime[]; sources: SourceDescriptor[] }>()
const emit = defineEmits<{ added: [TrackedAnime]; close: [] }>()

interface Hit extends Groupable {
    url: string
    seriesId: string
}

const query = ref("")
const hits = ref<Hit[]>([])
/** Per-source progress, so a site that is slow or broken says so by name. */
const state = ref<Record<string, "idle" | "searching" | "done" | "failed">>({})
const errors = ref<Record<string, string>>({})
const adding = ref(new Set<string>())
const searched = ref(false)

const enabledSources = computed(() => props.sources.filter(source => source.enabled))

const groups = computed(() => groupSeries(hits.value))

const trackedKeys = computed(() => new Set(props.library.map(anime => anime.key)))

const sourceName = (id: string) => props.sources.find(source => source.id === id)?.name ?? id

/** A search token, so results from an abandoned query are discarded. */
let run = 0

async function search() {
    const text = query.value.trim()
    if (text === "") return

    const mine = ++run
    hits.value = []
    errors.value = {}
    searched.value = true
    state.value = Object.fromEntries(enabledSources.value.map(source => [source.id, "searching" as const]))

    await Promise.all(
        enabledSources.value.map(async source => {
            try {
                const results = await send("sources:search", { sourceId: source.id, query: text })
                if (mine !== run) return
                hits.value = [
                    ...hits.value,
                    ...results.map(result => ({
                        key: `${source.id}/${result.seriesId}`,
                        sourceId: source.id,
                        title: result.title,
                        ...(result.poster ? { poster: result.poster } : {}),
                        episodes: [],
                        url: result.url,
                        seriesId: result.seriesId
                    }))
                ]
                state.value = { ...state.value, [source.id]: "done" }
            } catch (error) {
                if (mine !== run) return
                state.value = { ...state.value, [source.id]: "failed" }
                errors.value = {
                    ...errors.value,
                    [source.id]: error instanceof Error ? error.message : String(error)
                }
            }
        })
    )
}

async function add(hit: Hit) {
    if (adding.value.has(hit.key)) return
    adding.value = new Set(adding.value).add(hit.key)
    try {
        const anime = await send("library:add", {
            sourceId: hit.sourceId,
            seriesUrl: hit.url,
            seriesId: hit.seriesId,
            title: hit.title,
            ...(hit.poster ? { poster: hit.poster } : {})
        })
        if (anime) emit("added", anime)
    } catch (error) {
        errors.value = {
            ...errors.value,
            [hit.sourceId]: error instanceof Error ? error.message : String(error)
        }
    } finally {
        const done = new Set(adding.value)
        done.delete(hit.key)
        adding.value = done
    }
}

const searching = computed(() => Object.values(state.value).some(value => value === "searching"))
const failed = computed(() => enabledSources.value.filter(source => state.value[source.id] === "failed"))

// Typing a new query invalidates what is on screen; leaving it stale reads as a
// result for the new text.
watch(query, () => {
    if (query.value.trim() === "") {
        hits.value = []
        searched.value = false
    }
})

const input = ref<HTMLInputElement | null>(null)
onMounted(() => input.value?.focus())
</script>

<template>
    <section class="search">
        <header>
            <h2>Add a series</h2>
            <button class="btn" @click="emit('close')">Close</button>
        </header>

        <form class="bar" @submit.prevent="search">
            <input
                ref="input"
                v-model="query"
                type="search"
                placeholder="Title — searched on every enabled source"
                aria-label="Search for a series"
            />
            <button class="btn primary" :disabled="searching || query.trim() === ''" type="submit">
                {{ searching ? "Searching…" : "Search" }}
            </button>
        </form>

        <p v-if="enabledSources.length === 0" class="note">
            Every source is switched off. Turn one on below the settings panel.
        </p>

        <div v-if="searching || failed.length > 0" class="progress">
            <span v-for="source in enabledSources" :key="source.id" class="chip" :data-state="state[source.id]">
                {{ sourceName(source.id) }}
                <template v-if="state[source.id] === 'searching'">…</template>
                <template v-else-if="state[source.id] === 'failed'">✕</template>
            </span>
        </div>

        <p v-for="source in failed" :key="source.id" class="failed">
            {{ sourceName(source.id) }}: {{ errors[source.id] }}
        </p>

        <p v-if="searched && !searching && groups.length === 0" class="note">
            Nothing found. These sites index by their own spelling of a title — a Chinese donghua is often only findable
            under its pinyin name.
        </p>

        <ul v-if="groups.length > 0" class="results">
            <li v-for="group in groups" :key="group.id" class="result">
                <div class="poster">
                    <img v-if="group.poster" :src="group.poster" alt="" loading="lazy" />
                </div>
                <div class="body">
                    <p class="title">{{ group.title }}</p>
                    <div class="sources">
                        <template v-for="hit in group.entries" :key="hit.key">
                            <span v-if="trackedKeys.has(hit.key)" class="chip tracked" :title="`Already following`">
                                {{ sourceName(hit.sourceId) }} ✓
                            </span>
                            <button
                                v-else
                                class="chip add"
                                :disabled="adding.has(hit.key)"
                                :title="`Follow on ${sourceName(hit.sourceId)}`"
                                @click="add(hit as Hit)"
                            >
                                {{ adding.has(hit.key) ? "Adding…" : `+ ${sourceName(hit.sourceId)}` }}
                            </button>
                        </template>
                    </div>
                    <p v-if="group.entries.length > 1" class="alt">
                        Also listed as
                        <template v-for="(hit, index) in group.entries" :key="hit.key">
                            <span v-if="hit.title !== group.title">
                                “{{ hit.title }}”<span v-if="index < group.entries.length - 1">, </span>
                            </span>
                        </template>
                    </p>
                </div>
            </li>
        </ul>
    </section>
</template>

<style scoped>
.search {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

header {
    display: flex;
    align-items: center;
    justify-content: space-between;
}

h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
}

.bar {
    display: flex;
    gap: 6px;
}

.bar input {
    flex: 1 1 auto;
    min-width: 0;
    font: inherit;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    padding: 7px 10px;
}

.note,
.failed {
    margin: 0;
    font-size: 12px;
    color: var(--ink-3);
}

.failed {
    color: var(--state-warn);
}

.progress {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}

.chip {
    font-size: 11px;
    padding: 3px 8px;
    border: 1px solid var(--rule);
    border-radius: 4px;
    background: var(--surface);
    color: var(--ink-3);
    white-space: nowrap;
}

.chip[data-state="done"] {
    color: var(--ink-2);
}

.chip[data-state="failed"] {
    color: var(--state-warn);
    border-color: var(--state-warn);
}

.chip.add {
    color: var(--accent-ink);
    border-color: var(--accent);
    background: var(--accent-soft);
    font-weight: 600;
    cursor: pointer;
}

.chip.add:disabled {
    opacity: 0.6;
    cursor: default;
}

.chip.tracked {
    color: var(--state-new);
    border-color: var(--state-new-rule);
    background: var(--state-new-soft);
}

.results {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.result {
    display: grid;
    grid-template-columns: 46px minmax(0, 1fr);
    gap: 10px;
    padding: 8px 10px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
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
    gap: 5px;
}

.title {
    margin: 0;
    font-weight: 600;
    font-size: 13px;
}

.sources {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}

.alt {
    margin: 0;
    font-size: 11px;
    color: var(--ink-3);
}
</style>
