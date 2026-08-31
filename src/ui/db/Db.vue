<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { send } from "~/shared/messages"
import {
    STORES,
    cellText,
    extraFields,
    filterRows,
    formatEpoch,
    isEpochField,
    parseRow,
    scaffold,
    sortRows,
    storeSpec,
    summarise,
    type Row,
    type StoreId
} from "~/model/inspect"
import type { TrackedAnime } from "~/model/types"
import ConfirmDialog from "~/ui/components/ConfirmDialog.vue"

/**
 * Everything the extension has stored, unformatted.
 *
 * The library page shows what a series *means*; this shows what is actually on
 * disk, which is a different question and the only one worth asking when the two
 * have drifted apart. Nearly every bug worth the name in this project has come
 * down to a stored value nobody could see: a `seriesId` derived two ways for the
 * same show, a `nextCheckAt` decades out, an `offeredCategories` default that
 * had written a lie about the profile's own history.
 *
 * Modelled on AMR's Database Manager, with one addition: `storage.local` is a
 * store here too. Half of AAW's state lives there — settings, per-source
 * settings, the download queue — and a page that showed only IndexedDB would
 * have shown the half that goes wrong least.
 */

const active = ref<StoreId>("anime")
const counts = ref<Partial<Record<StoreId, number>>>({})
const rows = ref<Row[]>([])
const loading = ref(false)
const failure = ref<string | null>(null)

const query = ref("")
const field = ref("*")
const sortField = ref("")
const sortDescending = ref(false)
const selected = ref<string[]>([])

type Mode = "view" | "edit" | "create"
const dialog = ref<{ mode: Mode; row: Row | null; text: string; error: string | null } | null>(null)
const saving = ref(false)
const pendingDelete = ref<string[] | null>(null)
const toast = ref<{ text: string; bad: boolean } | null>(null)
let toastTimer: number | undefined

const spec = computed(() => storeSpec(active.value))
const extras = computed(() => extraFields(spec.value, rows.value))

/** Filter, then sort — so the sort is over what you can see, not what you can't. */
const visible = computed(() => {
    const found = filterRows(rows.value, query.value, field.value)
    return sortField.value === "" ? found : sortRows(found, sortField.value, sortDescending.value)
})

const keyOf = (row: Row) => String(row[spec.value.keyPath] ?? "")
const allShown = computed(() => visible.value.length > 0 && visible.value.every(row => isSelected(row)))

function isSelected(row: Row): boolean {
    return selected.value.includes(keyOf(row))
}

function toggle(row: Row) {
    const key = keyOf(row)
    selected.value = isSelected(row) ? selected.value.filter(one => one !== key) : [...selected.value, key]
}

function toggleAll() {
    selected.value = allShown.value ? [] : visible.value.map(keyOf)
}

/** One line for one cell. Epochs are named by their field, never by their size. */
function cell(row: Row, name: string): string {
    const value = row[name]
    return isEpochField(name, value) ? formatEpoch(value as number) : cellText(value)
}

/** The plain-English header above a library row's raw fields. */
function seriesLines(row: Row): string[] {
    return summarise(row as unknown as TrackedAnime)
}

function sortBy(name: string) {
    if (sortField.value === name) sortDescending.value = !sortDescending.value
    else {
        sortField.value = name
        sortDescending.value = false
    }
}

// ---------------------------------------------------------------- loading

async function load() {
    loading.value = true
    failure.value = null
    try {
        const [stores, found] = await Promise.all([send("db:stores", {}), send("db:rows", { store: active.value })])
        counts.value = Object.fromEntries(stores.map(store => [store.id, store.count]))
        rows.value = found
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error)
    }
    loading.value = false
}

function pick(store: StoreId) {
    if (store === active.value) return
    active.value = store
    // Nothing here survives the switch: a query written for one store's fields
    // silently hides every row of the next, and a selection is a list of keys
    // that mean nothing in a store that doesn't have them.
    query.value = ""
    field.value = "*"
    sortField.value = ""
    selected.value = []
    void load()
}

// ---------------------------------------------------------------- editing

function openRow(row: Row, mode: Mode = "view") {
    dialog.value = { mode, row, text: JSON.stringify(row, null, 2), error: null }
}

function newRow() {
    dialog.value = { mode: "create", row: null, text: scaffold(spec.value), error: null }
}

function validate() {
    if (!dialog.value) return
    const parsed = parseRow(dialog.value.text, spec.value.keyPath)
    dialog.value.error = parsed.ok ? null : parsed.error
}

async function save() {
    const editor = dialog.value
    if (!editor) return
    const parsed = parseRow(editor.text, spec.value.keyPath)
    if (!parsed.ok) {
        editor.error = parsed.error
        return
    }
    saving.value = true
    try {
        await send("db:put", { store: active.value, row: parsed.row })
        dialog.value = null
        await load()
        say(`Saved ${parsed.row[spec.value.keyPath]}`)
    } catch (error) {
        // Held onto rather than re-read: the dialog can only be closed by
        // succeeding, so the editor the failure belongs to is still this one.
        editor.error = error instanceof Error ? error.message : String(error)
    }
    saving.value = false
}

async function runDelete() {
    const keys = pendingDelete.value ?? []
    pendingDelete.value = null
    try {
        const gone = await send("db:delete", { store: active.value, keys })
        selected.value = []
        await load()
        say(`Deleted ${gone} row(s)`)
    } catch (error) {
        say(error instanceof Error ? error.message : String(error), true)
    }
}

// ---------------------------------------------------------------- clipboard

async function copy(text: string, what: string) {
    try {
        await navigator.clipboard.writeText(text)
        say(`${what} copied — ${text.length.toLocaleString()} characters`)
    } catch (error) {
        // A clipboard write can be refused when the page isn't focused. The
        // console is a worse answer than the clipboard but a much better one
        // than losing the payload.
        console.info(text)
        say(`${error instanceof Error ? error.message : String(error)} — written to the console instead`, true)
    }
}

/**
 * Not the row: the row plus the three levels of settings that decide what it
 * does. See `debug:report` — a library entry on its own cannot explain its own
 * behaviour, and a report that looks complete while omitting the chain is worse
 * than no report.
 */
async function copyDebugReport(key: string) {
    try {
        await copy(JSON.stringify(await send("debug:report", { key }), null, 2), "Debug report")
    } catch (error) {
        say(error instanceof Error ? error.message : String(error), true)
    }
}

/**
 * Escape closes the editor. It has to be handled here rather than left to the
 * scrim's click: the editor is a textarea you can be several minutes into, and
 * Escape is what everything else in this extension already does.
 */
function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && dialog.value) dialog.value = null
}

function say(text: string, bad = false) {
    toast.value = { text, bad }
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => (toast.value = null), 4000)
}

onMounted(() => {
    document.addEventListener("keydown", onKey)
    void load()
})

onBeforeUnmount(() => document.removeEventListener("keydown", onKey))
</script>

<template>
    <main class="db">
        <header>
            <h1>Database</h1>
            <p class="lede">
                Everything the extension has stored, as it is stored. Rows are editable JSON — this writes straight into
                the library, so an open library tab is told to re-read itself when you save.
            </p>
        </header>

        <nav class="tabs" aria-label="Stores">
            <button
                v-for="store in STORES"
                :key="store.id"
                class="tab"
                :class="{ on: store.id === active }"
                @click="pick(store.id)"
            >
                {{ store.label }}
                <span class="count">{{ counts[store.id] ?? "…" }}</span>
            </button>
        </nav>

        <section class="control">
            <p class="hint store-note">{{ spec.note }}</p>
            <div class="row">
                <input v-model="query" placeholder="Search rows" aria-label="Search rows" />
                <select v-model="field" aria-label="Field to search">
                    <option value="*">Every field</option>
                    <option v-for="name in spec.columns" :key="name" :value="name">{{ name }}</option>
                </select>
                <button class="btn" :disabled="loading" @click="load">{{ loading ? "Loading…" : "Reload" }}</button>
                <button class="btn" @click="newRow">New row</button>
                <button
                    class="btn"
                    :disabled="rows.length === 0"
                    @click="copy(JSON.stringify(rows, null, 2), spec.label)"
                >
                    Copy store
                </button>
                <button class="btn danger" :disabled="selected.length === 0" @click="pendingDelete = [...selected]">
                    Delete ({{ selected.length }})
                </button>
            </div>
            <p v-if="failure" class="bad">{{ failure }}</p>
            <p v-else class="hint">
                {{ visible.length }} of {{ rows.length }} row(s)<template v-if="extras.length > 0">
                    · {{ extras.length }} field(s) no column shows: <code>{{ extras.join(", ") }}</code></template
                >
            </p>
        </section>

        <div class="sheet">
            <table>
                <thead>
                    <tr>
                        <th class="tick">
                            <input
                                type="checkbox"
                                :checked="allShown"
                                aria-label="Select every row shown"
                                @change="toggleAll"
                            />
                        </th>
                        <th v-for="name in spec.columns" :key="name" :class="{ sorted: sortField === name }">
                            <button class="sort" @click="sortBy(name)">
                                {{ name }}
                                <span v-if="sortField === name" aria-hidden="true">{{
                                    sortDescending ? "▾" : "▴"
                                }}</span>
                            </button>
                        </th>
                        <th class="acts">actions</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="row in visible" :key="keyOf(row)" :class="{ picked: isSelected(row) }">
                        <td class="tick">
                            <input
                                type="checkbox"
                                :checked="isSelected(row)"
                                :aria-label="`Select ${keyOf(row)}`"
                                @change="toggle(row)"
                            />
                        </td>
                        <td v-for="name in spec.columns" :key="name" :title="cell(row, name)">
                            {{ cell(row, name) }}
                        </td>
                        <td class="acts">
                            <div class="btns">
                                <button class="btn tiny" @click="openRow(row)">View</button>
                                <button class="btn tiny" @click="openRow(row, 'edit')">Edit</button>
                                <button
                                    v-if="active === 'anime'"
                                    class="btn tiny"
                                    title="The entry plus every setting that decides how it behaves"
                                    @click="copyDebugReport(keyOf(row))"
                                >
                                    Debug
                                </button>
                                <button class="btn tiny danger" @click="pendingDelete = [keyOf(row)]">Delete</button>
                            </div>
                        </td>
                    </tr>
                    <tr v-if="visible.length === 0">
                        <td class="empty" :colspan="spec.columns.length + 2">
                            {{ loading ? "Loading…" : rows.length === 0 ? "This store is empty." : "Nothing matches." }}
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <!-- ---------------------------------------------------------- detail -->
        <div v-if="dialog" class="scrim" role="dialog" aria-modal="true" @click.self="dialog = null">
            <div class="panel">
                <div class="panel-head">
                    <h2>
                        {{ dialog.mode === "create" ? "New row" : dialog.mode === "edit" ? "Edit row" : "Row" }}
                        <span v-if="dialog.row" class="mono key">{{ keyOf(dialog.row) }}</span>
                    </h2>
                    <button class="btn icon" aria-label="Close" @click="dialog = null">✕</button>
                </div>

                <div class="panel-body">
                    <template v-if="dialog.mode === 'view' && dialog.row">
                        <ul v-if="active === 'anime'" class="summary">
                            <li v-for="(line, index) in seriesLines(dialog.row)" :key="index">{{ line }}</li>
                        </ul>
                        <table class="fields">
                            <tbody>
                                <tr v-for="(value, name) in dialog.row" :key="name">
                                    <th>{{ name }}</th>
                                    <td>
                                        <template v-if="isEpochField(String(name), value)">
                                            {{ formatEpoch(value as number) }}
                                            <span class="raw">{{ value }}</span>
                                        </template>
                                        <a
                                            v-else-if="typeof value === 'string' && value.startsWith('http')"
                                            :href="value"
                                            target="_blank"
                                            rel="noreferrer"
                                            >{{ value }}</a
                                        >
                                        <pre v-else-if="value !== null && typeof value === 'object'">{{
                                            JSON.stringify(value, null, 2)
                                        }}</pre>
                                        <template v-else>{{ cellText(value, 400) }}</template>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </template>

                    <template v-else>
                        <p v-if="dialog.error" class="bad">{{ dialog.error }}</p>
                        <textarea
                            v-model="dialog.text"
                            spellcheck="false"
                            aria-label="Row as JSON"
                            @input="validate"
                        ></textarea>
                        <p class="hint">
                            <code>{{ spec.keyPath }}</code> identifies the row. Changing it writes a new row and leaves
                            the old one where it is.
                        </p>
                    </template>
                </div>

                <div class="panel-foot">
                    <button v-if="dialog.row" class="btn" @click="copy(JSON.stringify(dialog.row, null, 2), 'Row')">
                        Copy JSON
                    </button>
                    <button
                        v-if="dialog.row && active === 'anime'"
                        class="btn"
                        @click="copyDebugReport(keyOf(dialog.row))"
                    >
                        Copy debug report
                    </button>
                    <span class="spacer"></span>
                    <button v-if="dialog.mode === 'view'" class="btn" @click="dialog.mode = 'edit'">Edit</button>
                    <button v-else class="btn primary" :disabled="saving || dialog.error !== null" @click="save">
                        {{ saving ? "Saving…" : "Save" }}
                    </button>
                </div>
            </div>
        </div>

        <ConfirmDialog
            :open="pendingDelete !== null"
            title="Delete these rows?"
            :body="`${(pendingDelete ?? []).length} row(s) from ${spec.label}: ${(pendingDelete ?? []).join(', ')}. There is no undo — export a backup first if this matters.`"
            confirm-label="Delete"
            danger
            @cancel="pendingDelete = null"
            @confirm="runDelete"
        />

        <p v-if="toast" class="toast" :class="{ bad: toast.bad }" role="status">{{ toast.text }}</p>
    </main>
</template>

<style scoped>
.db {
    max-width: 1180px;
    margin: 0 auto;
    padding: 24px 20px 60px;
    display: flex;
    flex-direction: column;
    gap: 14px;
}

h1 {
    margin: 0 0 6px;
    font-size: 18px;
}

.lede,
.hint {
    margin: 0;
    font-size: 12px;
    color: var(--ink-3);
    line-height: 1.5;
}

.bad {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--danger);
}

code {
    font-family: var(--mono);
    font-size: 11px;
}

/* ---------------------------------------------------------------- tabs */

.tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--rule);
}

.tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    font-size: 13px;
    color: var(--ink-3);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
}

.tab:hover {
    color: var(--ink);
}

.tab.on {
    color: var(--ink);
    border-bottom-color: var(--accent);
    font-weight: 600;
}

.count {
    font-family: var(--mono);
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 8px;
    background: var(--surface-2);
    color: var(--ink-3);
}

/* ---------------------------------------------------------------- controls */

.control {
    padding: 12px 14px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}

.store-note {
    margin-bottom: 10px;
}

.row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.row input,
.row select {
    font: inherit;
    font-size: 13px;
    color: var(--ink);
    background: var(--surface-2);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    padding: 6px 9px;
}

.row input {
    flex: 1 1 220px;
    min-width: 0;
}

.control .hint {
    margin-top: 8px;
}

/* ---------------------------------------------------------------- table */

.sheet {
    overflow-x: auto;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}

table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
}

th,
td {
    text-align: left;
    padding: 6px 10px;
    border-bottom: 1px solid var(--rule);
    /* Every cell is one line: a table that reflows on a 400-character URL stops
       being scannable, and the full value is one click away in the row. */
    white-space: nowrap;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
}

thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--surface-2);
    font-family: var(--mono);
    font-size: 10.5px;
    font-weight: 500;
    color: var(--ink-3);
    text-transform: lowercase;
}

th.sorted {
    color: var(--ink);
}

.sort {
    font: inherit;
    color: inherit;
    display: inline-flex;
    gap: 4px;
}

tbody tr:hover {
    background: var(--surface-2);
}

tbody tr.picked {
    background: var(--accent-soft);
}

td {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-2);
}

.tick {
    width: 28px;
    white-space: nowrap;
}

.acts {
    width: 1%;
    white-space: nowrap;
}

.btns {
    display: flex;
    gap: 4px;
}

.empty {
    color: var(--ink-3);
    font-family: var(--font);
    text-align: center;
    padding: 24px;
}

.btn.tiny {
    font-size: 10.5px;
    padding: 2px 7px;
}

/* ---------------------------------------------------------------- detail */

.scrim {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(8, 12, 15, 0.55);
}

.panel {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 860px;
    max-height: 100%;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    box-shadow: 0 18px 44px -16px rgba(0, 0, 0, 0.6);
}

.panel-head,
.panel-foot {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
}

.panel-head {
    border-bottom: 1px solid var(--rule);
}

.panel-foot {
    border-top: 1px solid var(--rule);
}

.panel-head h2 {
    margin: 0;
    flex: 1;
    min-width: 0;
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: baseline;
    gap: 8px;
}

.key {
    font-size: 11px;
    font-weight: 400;
    color: var(--ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
}

.spacer {
    flex: 1;
}

.panel-body {
    overflow: auto;
    padding: 14px;
}

.summary {
    margin: 0 0 12px;
    padding: 10px 12px 10px 26px;
    background: var(--surface-2);
    border-radius: var(--radius);
    font-size: 12px;
    color: var(--ink-2);
    line-height: 1.6;
}

.fields th {
    width: 150px;
    vertical-align: top;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-3);
    font-weight: 500;
    white-space: nowrap;
}

.fields td {
    max-width: none;
    white-space: normal;
    overflow-wrap: anywhere;
    font-family: var(--font);
    font-size: 12px;
    color: var(--ink);
}

.raw {
    margin-left: 8px;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-3);
}

.fields pre {
    margin: 0;
    max-height: 260px;
    overflow: auto;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.45;
    color: var(--ink-2);
    background: var(--surface-2);
    border-radius: var(--radius);
    padding: 8px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

textarea {
    width: 100%;
    min-height: 46vh;
    resize: vertical;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--ink);
    background: var(--surface-2);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    padding: 10px;
}

.panel-body .hint {
    margin-top: 8px;
}

/* ---------------------------------------------------------------- toast */

.toast {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    z-index: 120;
    margin: 0;
    max-width: 80vw;
    padding: 8px 14px;
    font-size: 12px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
}

.toast.bad {
    color: var(--danger);
    border-color: var(--danger);
}
</style>
