<script setup lang="ts">
import { computed, ref } from "vue"
import { send } from "~/shared/messages"
import type { ImportMode } from "~/model/backup"

/**
 * Move the library to another machine, or back from a file.
 *
 * This is the only data-transfer path the extension has — device sync was
 * dropped deliberately — so the panel is built to be readable under stress: it
 * says what an import will do *before* doing it, names the file it is about to
 * apply, and never treats "replace" as the obvious choice.
 */
const emit = defineEmits<{ imported: [] }>()

type Preview = {
    added: number
    updated: number
    unchanged: number
    localOnly: number
    mode: ImportMode
    exportedAt: number
    appVersion?: string
    applied: boolean
}

const mode = ref<ImportMode>("merge")
const withSettings = ref(true)
const busy = ref<"export" | "preview" | "import" | null>(null)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

/** Held in memory between the preview and the apply, so the file is read once. */
const staged = ref<{ name: string; text: string } | null>(null)
const preview = ref<Preview | null>(null)

const fileInput = ref<HTMLInputElement | null>(null)

async function exportLibrary() {
    busy.value = "export"
    error.value = null
    notice.value = null
    try {
        const { filename, text } = await send("backup:export", {})

        /*
         * Built here rather than in the background on purpose: a service worker
         * has no URL.createObjectURL, and the alternatives (a data: URL through
         * the downloads API, an offscreen document) are more moving parts for
         * something an extension page can do in four lines.
         */
        const url = URL.createObjectURL(new Blob([text], { type: "application/json" }))
        const link = document.createElement("a")
        link.href = url
        link.download = filename
        link.click()
        // Revoked on a later turn: revoking synchronously races the download in
        // Chrome and produces an empty file.
        setTimeout(() => URL.revokeObjectURL(url), 60_000)

        notice.value = `Saved ${filename} — ${Math.max(1, Math.round(text.length / 1024))} KB.`
    } catch (caught) {
        error.value = message(caught)
    } finally {
        busy.value = null
    }
}

async function choose(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0]
    if (!file) return

    error.value = null
    notice.value = null
    preview.value = null
    busy.value = "preview"

    try {
        const text = await file.text()
        staged.value = { name: file.name, text }
        await refreshPreview()
    } catch (caught) {
        staged.value = null
        error.value = message(caught)
    } finally {
        busy.value = null
        // Let the same file be picked again after a failure.
        if (fileInput.value) fileInput.value.value = ""
    }
}

/** Re-run the dry run whenever the choice of mode changes what would happen. */
async function refreshPreview() {
    if (!staged.value) return
    busy.value = "preview"
    error.value = null
    try {
        preview.value = await send("backup:import", {
            text: staged.value.text,
            mode: mode.value,
            settings: withSettings.value,
            dryRun: true
        })
    } catch (caught) {
        preview.value = null
        error.value = message(caught)
    } finally {
        busy.value = null
    }
}

async function apply() {
    if (!staged.value) return
    busy.value = "import"
    error.value = null
    try {
        const result = await send("backup:import", {
            text: staged.value.text,
            mode: mode.value,
            settings: withSettings.value
        })
        notice.value =
            `Imported ${staged.value.name}: ${result.added} added, ${result.updated} updated` +
            (result.mode === "replace" && result.localOnly > 0 ? `, ${result.localOnly} removed` : "") +
            "."
        staged.value = null
        preview.value = null
        emit("imported")
    } catch (caught) {
        error.value = message(caught)
    } finally {
        busy.value = null
    }
}

function cancel() {
    staged.value = null
    preview.value = null
    error.value = null
}

const exportedOn = computed(() =>
    preview.value?.exportedAt ? new Date(preview.value.exportedAt).toLocaleString() : "an unknown date"
)

/** Replace is destructive in exactly one visible way; say so with the number. */
const willRemove = computed(() => (mode.value === "replace" ? (preview.value?.localOnly ?? 0) : 0))

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
</script>

<template>
    <div class="group">
        <h3>Backup</h3>
        <p class="lede">
            There is no device sync — on purpose. A file is how the library moves between machines, and the only copy
            there will ever be if something goes wrong here.
        </p>

        <div class="actions">
            <button class="btn" :disabled="busy !== null" @click="exportLibrary">
                {{ busy === "export" ? "Exporting…" : "Export to a file" }}
            </button>
            <button class="btn" :disabled="busy !== null" @click="fileInput?.click()">Import from a file…</button>
            <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="choose" />
        </div>

        <p v-if="error" class="error">{{ error }}</p>
        <p v-else-if="notice" class="notice">{{ notice }}</p>

        <div v-if="staged" class="staged">
            <p class="filename">
                <strong>{{ staged.name }}</strong>
                <span v-if="preview" class="faint">
                    — exported {{ exportedOn }}<span v-if="preview.appVersion"> by v{{ preview.appVersion }}</span>
                </span>
            </p>

            <div class="modes">
                <label>
                    <input v-model="mode" type="radio" value="merge" @change="refreshPreview" />
                    <span>
                        <strong>Merge</strong> — keep everything already here, add what the file has. Where both know a
                        series, the more recently changed one wins, but a watched episode never becomes unwatched.
                    </span>
                </label>
                <label>
                    <input v-model="mode" type="radio" value="replace" @change="refreshPreview" />
                    <span>
                        <strong>Replace</strong> — the library becomes the file. Anything not in it is removed.
                    </span>
                </label>
            </div>

            <label class="inline">
                <input v-model="withSettings" type="checkbox" @change="refreshPreview" />
                <span>Restore settings and per-source settings too</span>
            </label>

            <p v-if="busy === 'preview'" class="faint">Reading…</p>
            <template v-else-if="preview">
                <ul class="summary">
                    <li><strong>{{ preview.added }}</strong> series would be added</li>
                    <li><strong>{{ preview.updated }}</strong> already here would be updated</li>
                    <li v-if="preview.unchanged > 0"><strong>{{ preview.unchanged }}</strong> are already identical</li>
                    <li v-if="mode === 'merge' && preview.localOnly > 0">
                        <strong>{{ preview.localOnly }}</strong> here but not in the file would be left alone
                    </li>
                </ul>
                <p v-if="willRemove > 0" class="warn">
                    {{ willRemove }} series in your library {{ willRemove === 1 ? "is" : "are" }} not in this file and
                    would be removed, along with {{ willRemove === 1 ? "its" : "their" }} watch history. Merge keeps
                    {{ willRemove === 1 ? "it" : "them" }}.
                </p>
            </template>

            <div class="actions">
                <button
                    class="btn primary"
                    :disabled="busy !== null || !preview"
                    @click="apply"
                >
                    {{ busy === "import" ? "Importing…" : willRemove > 0 ? `Replace, removing ${willRemove}` : "Import" }}
                </button>
                <button class="btn" :disabled="busy !== null" @click="cancel">Cancel</button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.lede {
    margin: 0 0 10px;
    font-size: 12px;
    color: var(--ink-3);
}

.actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.staged {
    margin-top: 12px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--surface-2);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}

.filename {
    margin: 0;
    font-size: 12px;
}

.faint {
    color: var(--ink-3);
    font-weight: 400;
}

.modes {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.modes label {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 8px;
    align-items: start;
    font-size: 12px;
    line-height: 1.45;
    color: var(--ink-2);
}

.modes strong {
    color: var(--ink);
}

.inline {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--ink-2);
}

.summary {
    margin: 0;
    padding-left: 18px;
    font-size: 12px;
    color: var(--ink-2);
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.error,
.warn,
.notice {
    margin: 8px 0 0;
    font-size: 12px;
}

.error {
    color: var(--danger);
}

.warn {
    color: var(--state-warn);
}

.notice {
    color: var(--ink-2);
}
</style>
