<script setup lang="ts">
import { computed, ref } from "vue"
import type { TrackedAnime } from "~/model/types"
import { titleOf } from "~/model/keys"
import type { SourceDescriptor } from "~/shared/messages"
import {
    categoriesOf,
    categoryCounts,
    cycleFilter,
    genresInLibrary,
    newCategory,
    type Category,
    type CategoryFilter
} from "~/library/categories"

/**
 * Shelves, as a row of chips.
 *
 * Each chip has three states rather than two, because "everything except films"
 * is as ordinary a thing to want as "only films" and a two-state chip cannot say
 * it. Ticked narrows and crossed removes; the counts are there so a shelf that
 * turns out to hold nothing is visibly empty rather than mysteriously unhelpful.
 */
const props = defineProps<{
    library: TrackedAnime[]
    /** What survives every other filter — what bulk actions would apply to. */
    shown: TrackedAnime[]
    categories: Category[]
    filter: CategoryFilter
    sources: SourceDescriptor[]
}>()

const emit = defineEmits<{
    "update:filter": [CategoryFilter]
    "update:categories": [Category[]]
    bulk: [{ action: "add" | "remove"; categoryId: string }]
    /** One series on or off one shelf, by hand. */
    assign: [{ key: string; categoryId: string; on: boolean }]
}>()

const managing = ref(false)
const draft = ref("")
const genreDraft = ref("")
const bulkTarget = ref("")
/**
 * Which shelf's contents are open.
 *
 * The bulk control below fills a shelf from whatever the list is currently
 * showing, which is the fast way to put forty series somewhere and no way at all
 * to put one. This is the other half: pick the shelf, find the series, tick it.
 */
const editing = ref<string | null>(null)
const memberQuery = ref("")

/** How many candidates to show at once — a library is longer than a panel. */
const CANDIDATE_LIMIT = 25

const sourceClaims = computed(() => Object.fromEntries(props.sources.map(source => [source.id, source.categories])))

const counts = computed(() => categoryCounts(props.library, props.categories, sourceClaims.value))

/**
 * Every shelf can be filled by hand, automatic ones included.
 *
 * A rule is evidence, not a verdict: "Donghua" comes from AniList's
 * `countryOfOrigin`, which is missing for everything unmatched — including
 * every series added before tracker matching existed.
 */
const fillable = computed(() => props.categories)

const genres = computed(() => {
    const taken = new Set(
        props.categories
            .filter(category => category.rule.kind === "genre")
            .map(category => (category.rule as { value: string }).value.toLowerCase())
    )
    return genresInLibrary(props.library).filter(entry => !taken.has(entry.genre.toLowerCase()))
})

function toggle(id: string) {
    emit("update:filter", cycleFilter(props.filter, id))
}

function addShelf() {
    const name = draft.value.trim()
    if (name === "") return
    emit("update:categories", [...props.categories, newCategory(name)])
    draft.value = ""
}

function addGenre() {
    const genre = genreDraft.value
    if (genre === "") return
    emit("update:categories", [...props.categories, newCategory(genre, { kind: "genre", value: genre })])
    genreDraft.value = ""
}

function removeShelf(category: Category) {
    emit(
        "update:categories",
        props.categories.filter(candidate => candidate.id !== category.id)
    )
}

function editShelf(category: Category) {
    editing.value = editing.value === category.id ? null : category.id
    memberQuery.value = ""
}

/** What is on a shelf: put there by a rule, by hand, or both. */
function membersOf(categoryId: string): TrackedAnime[] {
    return props.library
        .filter(anime => categoriesOf(anime, props.categories, sourceClaims.value).includes(categoryId))
        .sort((a, b) => titleOf(a).localeCompare(titleOf(b)))
}

/** Whether the user put it there themselves, which is what the ✕ undoes. */
function byHand(anime: TrackedAnime, categoryId: string): boolean {
    return (anime.categories ?? []).includes(categoryId)
}

const matches = computed(() => {
    const id = editing.value
    if (id === null) return []
    const needle = memberQuery.value.trim().toLowerCase()
    const already = new Set(membersOf(id).map(anime => anime.key))

    return props.library
        .filter(anime => !already.has(anime.key))
        .filter(anime => needle === "" || titleOf(anime).toLowerCase().includes(needle))
        .sort((a, b) => titleOf(a).localeCompare(titleOf(b)))
})

const candidates = computed(() => matches.value.slice(0, CANDIDATE_LIMIT))

function assign(anime: TrackedAnime, categoryId: string, on: boolean) {
    emit("assign", { key: anime.key, categoryId, on })
}

function describe(category: Category): string {
    switch (category.rule.kind) {
        case "manual":
            return "yours to fill"
        case "country":
            return `made in ${category.rule.value}`
        case "genre":
            return `genre: ${category.rule.value}`
        case "format":
            return `format: ${category.rule.value}`
        case "status":
            return category.rule.value.toLowerCase().replace(/_/g, " ")
        case "source":
            return `everything from ${category.rule.value}`
        case "state":
            return STATE_WORDS[category.rule.value]
    }
}

const STATE_WORDS = {
    failing: "the last check failed",
    unfollowed: "not followed",
    unchecked: "not checked for new episodes",
    unwatched: "something new to watch"
} as const

const active = computed(() => Object.keys(props.filter).length > 0)
</script>

<template>
    <div v-if="categories.length > 0 || library.length > 0" class="bar">
        <div class="chips">
            <button
                v-for="category in categories"
                :key="category.id"
                class="chip"
                :data-state="filter[category.id] ?? 'neutral'"
                :title="`${describe(category)} — click to tick, again to cross, again to clear`"
                @click="toggle(category.id)"
            >
                <span v-if="filter[category.id] === 'exclude'" class="mark">✕</span>
                <span v-else-if="filter[category.id] === 'include'" class="mark">✓</span>
                {{ category.name }}
                <span class="count">{{ counts[category.id] ?? 0 }}</span>
            </button>

            <button v-if="active" class="chip clear" @click="emit('update:filter', {})">Clear</button>
            <button class="chip manage" :class="{ open: managing }" @click="managing = !managing">
                {{ managing ? "Done" : "Shelves…" }}
            </button>
        </div>

        <div v-if="managing" class="manage-panel">
            <ul class="shelves">
                <li v-for="category in categories" :key="category.id" class="shelf">
                    <div class="shelf-head">
                        <span class="name">{{ category.name }}</span>
                        <span class="rule">{{ describe(category) }}</span>
                        <button
                            class="link"
                            :title="`Choose which series sit on ${category.name}`"
                            @click="editShelf(category)"
                        >
                            {{ editing === category.id ? "Done" : `Series (${counts[category.id] ?? 0})` }}
                        </button>
                        <button class="link" title="Delete this shelf" @click="removeShelf(category)">Delete</button>
                    </div>

                    <!--
                        Hand-picking, as the counterpart to the bulk control below:
                        that one fills a shelf from whatever the list is showing,
                        which cannot put a single series anywhere.
                    -->
                    <div v-if="editing === category.id" class="members">
                        <p v-if="category.rule.kind !== 'manual'" class="hint">
                            This shelf fills itself from {{ describe(category) }} — adding and removing here overrules
                            that, which is what an unmatched series needs.
                        </p>

                        <ul v-if="membersOf(category.id).length > 0" class="picked">
                            <li v-for="anime in membersOf(category.id)" :key="anime.key">
                                <span class="member-title">{{ titleOf(anime) }}</span>
                                <span class="how">{{ byHand(anime, category.id) ? "by hand" : "automatic" }}</span>
                                <button
                                    class="link"
                                    :title="`Take ${titleOf(anime)} off ${category.name}`"
                                    @click="assign(anime, category.id, false)"
                                >
                                    ✕
                                </button>
                            </li>
                        </ul>
                        <p v-else class="hint">Nothing on this shelf yet.</p>

                        <input
                            v-model="memberQuery"
                            type="search"
                            placeholder="Find a series to add…"
                            :aria-label="`Find a series to add to ${category.name}`"
                        />

                        <ul v-if="candidates.length > 0" class="picked candidates">
                            <li v-for="anime in candidates" :key="anime.key">
                                <span class="member-title">{{ titleOf(anime) }}</span>
                                <button
                                    class="link add"
                                    :title="`Put ${titleOf(anime)} on ${category.name}`"
                                    @click="assign(anime, category.id, true)"
                                >
                                    Add
                                </button>
                            </li>
                        </ul>
                        <p v-else class="hint">
                            {{
                                memberQuery.trim() === "" ? "Every series is already here." : "No series matches that."
                            }}
                        </p>
                        <p v-if="matches.length > candidates.length" class="hint">
                            {{ matches.length - candidates.length }} more — keep typing to narrow it.
                        </p>
                    </div>
                </li>
            </ul>

            <div class="add">
                <input
                    v-model="draft"
                    type="text"
                    placeholder="New shelf — you fill this one"
                    @keyup.enter="addShelf"
                />
                <button class="btn tiny" :disabled="draft.trim() === ''" @click="addShelf">Add</button>
            </div>

            <div v-if="genres.length > 0" class="add">
                <select v-model="genreDraft" aria-label="Add a shelf for a genre">
                    <option value="">Add a shelf for a genre…</option>
                    <option v-for="entry in genres" :key="entry.genre" :value="entry.genre">
                        {{ entry.genre }} ({{ entry.count }})
                    </option>
                </select>
                <button class="btn tiny" :disabled="genreDraft === ''" @click="addGenre">Add</button>
            </div>
            <p v-else-if="library.length > 0" class="hint">
                Genres come from AniList, so they appear as series get matched.
            </p>

            <div v-if="fillable.length > 0" class="add">
                <select v-model="bulkTarget" aria-label="Shelf to put the shown series on">
                    <option value="">Put the {{ shown.length }} shown series on…</option>
                    <option v-for="category in fillable" :key="category.id" :value="category.id">
                        {{ category.name }}
                    </option>
                </select>
                <button
                    class="btn tiny"
                    :disabled="bulkTarget === '' || shown.length === 0"
                    @click="emit('bulk', { action: 'add', categoryId: bulkTarget })"
                >
                    Add
                </button>
                <button
                    class="btn tiny"
                    :disabled="bulkTarget === '' || shown.length === 0"
                    @click="emit('bulk', { action: 'remove', categoryId: bulkTarget })"
                >
                    Remove
                </button>
            </div>
            <p v-else class="hint">Make a shelf first and this fills it from whatever the list is showing.</p>
        </div>
    </div>
</template>

<style scoped>
.bar {
    display: flex;
    flex-direction: column;
    gap: 8px;
    /* Matches the controls row underneath, and keeps the first row of chips off
       the header's bottom rule — flush against it they read as part of the title
       bar rather than as the top of the list. */
    padding: 12px 14px 2px;
}

.chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}

.chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: inherit;
    font-size: 11px;
    padding: 3px 9px;
    border: 1px solid var(--rule);
    border-radius: 999px;
    background: var(--surface);
    color: var(--ink-3);
    cursor: pointer;
    white-space: nowrap;
}

.chip:hover {
    color: var(--ink);
}

.chip[data-state="include"] {
    color: var(--accent-ink);
    border-color: var(--accent);
    background: var(--accent-soft);
    font-weight: 600;
}

.chip[data-state="exclude"] {
    color: var(--danger);
    border-color: var(--danger);
    text-decoration: line-through;
}

.mark {
    font-size: 10px;
}

.count {
    font-variant-numeric: tabular-nums;
    opacity: 0.65;
}

.chip.manage.open,
.chip.clear {
    color: var(--ink-2);
}

.manage-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    background: var(--surface-2);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}

.shelves {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.shelves li {
    font-size: 12px;
}

.shelf-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    gap: 8px;
    align-items: baseline;
}

.members {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin: 5px 0 9px;
    padding: 8px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}

.members input {
    font: inherit;
    font-size: 12px;
    color: var(--ink);
    background: var(--surface-2);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    padding: 5px 8px;
}

.picked {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.picked.candidates li {
    grid-template-columns: minmax(0, 1fr) auto;
}

/* Bounded: the candidate list is the whole library until something is typed. */
.picked.candidates {
    max-height: 168px;
    overflow-y: auto;
}

.picked li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 8px;
    align-items: baseline;
}

.how {
    font-size: 10px;
    color: var(--ink-3);
    opacity: 0.8;
}

.member-title {
    color: var(--ink-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.link.add:hover {
    color: var(--accent-ink);
}

.rule.auto {
    opacity: 0.7;
}

.name {
    font-weight: 600;
    color: var(--ink);
}

.rule {
    font-size: 11px;
    color: var(--ink-3);
}

.link {
    font: inherit;
    font-size: 11px;
    color: var(--ink-3);
    background: none;
    border: 0;
    padding: 0;
    text-decoration: underline;
    cursor: pointer;
}

.link:hover {
    color: var(--danger);
}

.add {
    display: flex;
    gap: 6px;
    align-items: center;
}

.add input,
.add select {
    flex: 1 1 auto;
    min-width: 0;
    font: inherit;
    font-size: 12px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    padding: 5px 8px;
}

.hint {
    margin: 0;
    font-size: 11px;
    color: var(--ink-3);
}
</style>
