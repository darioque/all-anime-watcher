<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { onDownloadsChanged, send } from "~/shared/messages"
import type { DownloadJob } from "~/downloads/types"

/**
 * What the download queue is doing.
 *
 * Progress arrives as a broadcast rather than being polled: a download runs for
 * minutes in an offscreen document that outlives the service worker, and a panel
 * that asked every second would wake the worker every second to answer.
 */
const emit = defineEmits<{ close: [] }>()

const jobs = ref<DownloadJob[]>([])
const error = ref<string | null>(null)

const running = computed(() => jobs.value.filter(job => !finished(job)))
const past = computed(() => jobs.value.filter(job => finished(job)))

function finished(job: DownloadJob): boolean {
    return job.status === "done" || job.status === "failed" || job.status === "cancelled"
}

async function load() {
    try {
        jobs.value = await send("downloads:list", {})
    } catch (caught) {
        error.value = caught instanceof Error ? caught.message : String(caught)
    }
}

async function act(fn: () => Promise<unknown>) {
    error.value = null
    try {
        await fn()
        await load()
    } catch (caught) {
        error.value = caught instanceof Error ? caught.message : String(caught)
    }
}

const cancel = (job: DownloadJob) => act(() => send("downloads:cancel", { id: job.id }))
const retry = (job: DownloadJob) => act(() => send("downloads:retry", { id: job.id }))
const clearFinished = () => act(() => send("downloads:clearFinished", {}))

/** Bytes as a person reads them. Unknown until the first segment lands. */
function size(bytes: number): string {
    if (bytes <= 0) return ""
    const mb = bytes / 1024 / 1024
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`
}

function line(job: DownloadJob): string {
    switch (job.status) {
        case "queued":
            return "Waiting for a slot"
        case "resolving":
            // Worth naming: it is the slow, silent part, and it looks like a hang.
            return "Finding a server — same work as opening the episode"
        case "downloading":
            return job.segmentsTotal > 0
                ? `${job.segmentsDone} of ${job.segmentsTotal} segments${job.bytes ? ` · ${size(job.bytes)}` : ""}`
                : "Starting"
        case "saving":
            return `Handing ${size(job.bytes)} to the browser`
        case "done":
            return job.filename ?? "Saved"
        case "cancelled":
            return "Cancelled"
        case "failed":
            return job.error ?? "Failed"
    }
}

let unsubscribe: (() => void) | null = null

onMounted(() => {
    unsubscribe = onDownloadsChanged(event => {
        jobs.value = event.jobs
    })
    void load()
})

onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
    <section class="downloads">
        <header>
            <h2>Downloads</h2>
            <div class="head-actions">
                <button v-if="past.length > 0" class="btn tiny" @click="clearFinished">Clear finished</button>
                <button class="btn" @click="emit('close')">Close</button>
            </div>
        </header>

        <p v-if="error" class="error">{{ error }}</p>

        <p v-if="jobs.length === 0" class="note">
            Nothing queued. Open a series' episode list and switch it to Download.
        </p>

        <ul v-else class="list">
            <li v-for="job in [...running, ...past]" :key="job.id" class="job" :data-state="job.status">
                <div class="body">
                    <p class="title">
                        {{ job.title }} <span class="faint">E{{ job.number }}</span>
                    </p>
                    <p class="detail">{{ line(job) }}</p>
                    <p v-if="job.detail && !finished(job)" class="faint small">{{ job.detail }}</p>

                    <div v-if="job.status === 'downloading'" class="bar">
                        <span class="fill" :style="{ width: `${Math.round(job.progress * 100)}%` }"></span>
                    </div>
                </div>

                <div class="controls">
                    <span v-if="job.status === 'downloading'" class="pct"> {{ Math.round(job.progress * 100) }}% </span>
                    <button v-if="!finished(job)" class="btn tiny" @click="cancel(job)">Cancel</button>
                    <button v-else-if="job.status !== 'done'" class="btn tiny" @click="retry(job)">Retry</button>
                </div>
            </li>
        </ul>

        <p class="note foot">
            Streams arrive as hundreds of separate pieces. They are joined back together here, but nothing is re-encoded
            — where a site ships MPEG-TS pieces the result is a <code>.ts</code> file, which desktop players open and
            most browsers do not.
        </p>
    </section>
</template>

<style scoped>
.downloads {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.head-actions {
    display: flex;
    gap: 6px;
}

h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
}

.note,
.error {
    margin: 0;
    font-size: 12px;
    color: var(--ink-3);
}

.error {
    color: var(--danger);
}

.foot {
    border-top: 1px solid var(--rule);
    padding-top: 10px;
}

.list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.job {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 8px 10px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}

.job[data-state="failed"] {
    border-color: var(--danger);
}

.job[data-state="done"],
.job[data-state="cancelled"] {
    opacity: 0.7;
}

.body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
}

.detail {
    margin: 0;
    font-size: 11px;
    color: var(--ink-2);
    overflow-wrap: anywhere;
}

.faint {
    color: var(--ink-3);
    font-weight: 400;
}

.small {
    margin: 0;
    font-size: 11px;
}

.bar {
    margin-top: 4px;
    height: 4px;
    border-radius: 2px;
    background: var(--surface-2);
    overflow: hidden;
}

.fill {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.25s linear;
}

.controls {
    display: flex;
    align-items: center;
    gap: 6px;
}

.pct {
    font-size: 11px;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
}

code {
    font-size: 11px;
}
</style>
