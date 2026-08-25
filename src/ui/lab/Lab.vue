<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { send } from "~/shared/messages"
import type { SourceDescriptor } from "~/shared/messages"
import type { Server } from "~/sources/types"
import Outcome from "./Outcome.vue"

/**
 * Run one piece of a source or extractor, from inside the extension.
 *
 * `npm run probe` does most of this from a terminal and iterates faster, so this
 * is not a replacement for it. It exists for the one thing the CLI structurally
 * cannot do: Node's fetch can set Referer and Origin, and a browser's cannot.
 * A site that demands either therefore passes every CLI probe and fails in the
 * extension — which is exactly how MegaPlay hid, answering HTTP 200 with an
 * error page while the probe reported the extractor healthy.
 *
 * So every button here runs through the real fetch context, the real
 * declarativeNetRequest rules and the real registry. If it works here, it works.
 */

type Panel = "search" | "series" | "page" | "extract" | "rules"

interface Outcome {
    ok: boolean
    ms?: number
    body: string
}

const sources = ref<SourceDescriptor[]>([])
const sourceId = ref("")
const query = ref("")
const seriesUrl = ref("")
const pageUrl = ref("")
const embedUrl = ref("")
const embedReferer = ref("")

const busy = ref<Panel | null>(null)
const results = ref<Partial<Record<Panel, Outcome>>>({})

/** Servers found by the page probe, so the next step is one click rather than a paste. */
const servers = ref<Server[]>([])
const pageSource = ref("")
const probedUrl = ref("")

const enabled = computed(() => sources.value.filter(source => source.enabled))

async function run(panel: Panel, work: () => Promise<{ ms: number; result: unknown } | unknown>) {
    busy.value = panel
    try {
        const answer = (await work()) as { ms?: number; result?: unknown }
        const hasTiming = typeof answer?.ms === "number"
        results.value = {
            ...results.value,
            [panel]: {
                ok: true,
                ...(hasTiming ? { ms: answer.ms } : {}),
                body: pretty(hasTiming ? answer.result : answer)
            }
        }
        return hasTiming ? answer.result : answer
    } catch (error) {
        results.value = {
            ...results.value,
            [panel]: { ok: false, body: error instanceof Error ? error.message : String(error) }
        }
        return null
    } finally {
        busy.value = null
    }
}

const searchIt = () => run("search", () => send("lab:search", { sourceId: sourceId.value, query: query.value.trim() }))
const seriesIt = () => run("series", () => send("lab:series", { sourceId: sourceId.value, url: seriesUrl.value.trim() }))

async function pageIt() {
    servers.value = []
    const result = (await run("page", () => send("lab:page", { url: pageUrl.value.trim() }))) as {
        identity?: { servers?: Server[]; sourceId?: string | null }
    } | null

    if (result?.identity?.servers) {
        servers.value = result.identity.servers
        pageSource.value = result.identity.sourceId ?? ""
        probedUrl.value = pageUrl.value.trim()
    }
}

const streamsFor = (server: Server) =>
    run("page", () =>
        send("lab:streams", { sourceId: pageSource.value, episodeUrl: probedUrl.value, server })
    )

const extractIt = () =>
    run("extract", () =>
        send("lab:extract", {
            embedUrl: embedUrl.value.trim(),
            ...(embedReferer.value.trim() ? { referer: embedReferer.value.trim() } : {})
        })
    )

const rulesIt = () => run("rules", () => send("lab:rules", {}))

function pretty(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2) ?? String(value)
    } catch {
        return String(value)
    }
}

onMounted(async () => {
    try {
        sources.value = await send("sources:list", {})
        sourceId.value = enabled.value[0]?.id ?? sources.value[0]?.id ?? ""
    } catch (error) {
        results.value = { search: { ok: false, body: String(error) } }
    }
    void rulesIt()
})
</script>

<template>
    <main class="lab">
        <header>
            <h1>Lab</h1>
            <p class="lede">
                Everything here runs inside the extension — same fetch context, same header rules, same registry as real
                playback. <code>npm run probe</code> is faster to iterate with, but it cannot reproduce a site that
                demands a <code>Referer</code>: Node can set that header and a browser cannot.
            </p>
        </header>

        <section>
            <h2>Search a source</h2>
            <div class="row">
                <select v-model="sourceId" aria-label="Source">
                    <option v-for="source in sources" :key="source.id" :value="source.id">
                        {{ source.name }}{{ source.enabled ? "" : " (off)" }}
                    </option>
                </select>
                <input v-model="query" placeholder="Title to search for" @keyup.enter="searchIt" />
                <button class="btn" :disabled="busy !== null || query.trim() === ''" @click="searchIt">Run</button>
            </div>
            <Outcome :outcome="results.search" />
        </section>

        <section>
            <h2>Series and episode list</h2>
            <div class="row">
                <select v-model="sourceId" aria-label="Source">
                    <option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }}</option>
                </select>
                <input v-model="seriesUrl" placeholder="Series URL" @keyup.enter="seriesIt" />
                <button class="btn" :disabled="busy !== null || seriesUrl.trim() === ''" @click="seriesIt">Run</button>
            </div>
            <p class="hint">
                Shows the derived series id, what <code>getSeries</code> returned, and the first and last few episodes —
                the ends are what tell you the numbering is right.
            </p>
            <Outcome :outcome="results.series" />
        </section>

        <section>
            <h2>Episode page</h2>
            <div class="row">
                <input v-model="pageUrl" placeholder="Episode URL" @keyup.enter="pageIt" />
                <button class="btn" :disabled="busy !== null || pageUrl.trim() === ''" @click="pageIt">Read</button>
            </div>
            <p class="hint">Read exactly as the content script would, but never as a tracking signal.</p>

            <div v-if="servers.length > 0" class="servers">
                <span class="label">{{ servers.length }} server(s):</span>
                <button
                    v-for="(server, index) in servers"
                    :key="`${server.name}-${index}`"
                    class="btn tiny"
                    :disabled="busy !== null"
                    :title="`Resolve ${server.name} to a stream`"
                    @click="streamsFor(server)"
                >
                    {{ server.name }}
                </button>
            </div>

            <Outcome :outcome="results.page" />
        </section>

        <section>
            <h2>Extractor</h2>
            <div class="row">
                <input v-model="embedUrl" placeholder="Embed URL" @keyup.enter="extractIt" />
                <input v-model="embedReferer" placeholder="Referer (optional — an episode URL)" />
                <button class="btn" :disabled="busy !== null || embedUrl.trim() === ''" @click="extractIt">Run</button>
            </div>
            <p class="hint">
                The most useful button here. A dead server is nearly always an extractor that stopped matching the
                host's markup, and this isolates that from everything upstream of it.
            </p>
            <Outcome :outcome="results.extract" />
        </section>

        <section>
            <h2>Header rules in force</h2>
            <div class="row">
                <button class="btn" :disabled="busy !== null" @click="rulesIt">Refresh</button>
            </div>
            <p class="hint">
                Three separate playback bugs came down to a rule that existed but was scoped to the wrong initiator or
                the wrong host, with nothing in the extension showing what was actually installed.
            </p>
            <Outcome :outcome="results.rules" />
        </section>
    </main>
</template>

<style scoped>
.lab {
    max-width: 880px;
    margin: 0 auto;
    padding: 24px 20px 60px;
    display: flex;
    flex-direction: column;
    gap: 22px;
}

h1 {
    margin: 0 0 6px;
    font-size: 18px;
}

h2 {
    margin: 0 0 8px;
    font-size: 14px;
    font-weight: 600;
}

.lede,
.hint {
    margin: 0;
    font-size: 12px;
    color: var(--ink-3);
    line-height: 1.5;
}

.hint {
    margin-top: 6px;
}

section {
    padding: 14px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}

.row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.row input,
.row select {
    flex: 1 1 200px;
    min-width: 0;
    font: inherit;
    font-size: 13px;
    color: var(--ink);
    background: var(--surface-2);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    padding: 6px 9px;
}

.servers {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
    margin-top: 10px;
}

.label {
    font-size: 11px;
    color: var(--ink-3);
}

code {
    font-family: var(--mono);
    font-size: 11px;
}
</style>
