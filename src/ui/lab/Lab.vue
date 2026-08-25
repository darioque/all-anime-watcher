<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { send } from "~/shared/messages"
import type { SourceDescriptor } from "~/shared/messages"
import type { Episode } from "~/model/types"
import type { SearchResult, Server } from "~/sources/types"
import { checkAttributes, checkFetch, checkPage, checkSearch, checkSeries, checkStreams } from "~/lab/checks"
import type { Verdict } from "~/lab/checks"
import Outcome from "./Outcome.vue"

/**
 * Test a source end to end, from inside the extension.
 *
 * `npm run probe` does most of this from a terminal and iterates faster, so this
 * is not a replacement for it. It exists for the one thing the CLI structurally
 * cannot do: Node's fetch can set Referer and Origin, and a browser's cannot.
 * A site that demands either therefore passes every CLI probe and fails in the
 * extension — which is exactly how MegaPlay hid, answering HTTP 200 with an
 * error page while the probe reported the extractor healthy.
 *
 * Shaped as a course rather than a set of URL boxes: each step hands its result
 * to the next, so picking a source and pressing Run is the whole interaction.
 * Having to paste a series URL to test a series meant already knowing the URL
 * was right, which is half of what was being tested. Where a step has a choice
 * to make — which search hit, which episode, which server — it takes the
 * obvious one and offers a picker to run it again with another.
 */

type StepId = "source" | "search" | "series" | "page" | "streams" | "fetch"

interface Step {
    id: StepId
    name: string
    hint: string
    state: "idle" | "running" | "ok" | "bad" | "skipped"
    note?: string
    warnings?: string[]
    ms?: number
    detail?: unknown
}

const PLAN: { id: StepId; name: string; hint: string }[] = [
    { id: "source", name: "Attributes", hint: "What the source declares about itself, before any request." },
    { id: "search", name: "Search", hint: "Results, and whether each could become a library entry." },
    { id: "series", name: "Series and episodes", hint: "Order, numbering, and whether the URLs route back here." },
    { id: "page", name: "Episode page", hint: "Read as the content script reads it, but never as a watch signal." },
    { id: "streams", name: "Server → stream", hint: "The extractor, and the header rules it needs installed." },
    { id: "fetch", name: "Stream reachable", hint: "The fetch a browser makes, with the rules the step above set." }
]

const sources = ref<SourceDescriptor[]>([])
const sourceId = ref("")
const query = ref("")
const running = ref(false)
const steps = ref<Step[]>(blank())

/** Series already followed on each source, used to pre-fill the search box. */
const known = ref<Map<string, string>>(new Map())

/** The chain's forks: what each step handed the next, and what was picked. */
const hits = ref<SearchResult[]>([])
const chosenHit = ref("")
const episodes = ref<Episode[]>([])
const chosenEpisode = ref("")
const servers = ref<Server[]>([])
const chosenServer = ref("")
const seriesId = ref("")

const currentSource = computed(() => sources.value.find(source => source.id === sourceId.value))
const failures = computed(() => steps.value.filter(step => step.state === "bad").length)
const finished = computed(() => steps.value.filter(step => step.state !== "idle").length)
const verdictLine = computed(() => {
    if (running.value) return `running — step ${finished.value} of ${PLAN.length}`
    if (finished.value === 0) return ""
    if (failures.value > 0) return `${failures.value} of ${finished.value} step(s) failed`
    return finished.value === PLAN.length ? "all steps passed" : `${finished.value} step(s), none failed`
})

function blank(): Step[] {
    return PLAN.map(step => ({ ...step, state: "idle" as const }))
}

function stepAt(id: StepId): Step {
    return steps.value.find(step => step.id === id)!
}

/** Clear this step and everything downstream of it, so a re-run reads honestly. */
function resetFrom(id: StepId) {
    const from = PLAN.findIndex(step => step.id === id)
    steps.value = steps.value.map((step, index) => (index >= from ? { ...PLAN[index]!, state: "idle" as const } : step))
}

/**
 * Run one step: judge what came back, record it, and hand it on.
 *
 * Returns null on a failed verdict as well as on a thrown error — a step that
 * failed has nothing trustworthy to give the next one, and continuing would
 * report a cascade of failures that all have one cause.
 */
async function attempt<T>(
    id: StepId,
    work: () => Promise<{ ms: number; result: T }>,
    judge: (result: T) => Verdict
): Promise<T | null> {
    const step = stepAt(id)
    step.state = "running"

    try {
        const { ms, result } = await work()
        const verdict = judge(result)
        Object.assign(step, {
            ms,
            note: verdict.note,
            warnings: verdict.warnings,
            detail: result,
            state: verdict.ok ? "ok" : "bad"
        })
        return verdict.ok ? result : null
    } catch (error) {
        Object.assign(step, { state: "bad", note: error instanceof Error ? error.message : String(error) })
        return null
    }
}

async function guard(work: () => Promise<void>) {
    if (running.value) return
    running.value = true
    try {
        await work()
    } finally {
        running.value = false
    }
}

const runAll = () =>
    guard(async () => {
        steps.value = blank()
        hits.value = []
        episodes.value = []
        servers.value = []

        const source = currentSource.value
        const step = stepAt("source")
        if (!source) {
            Object.assign(step, { state: "bad", note: "no source selected" })
            return
        }

        const attributes = checkAttributes(source)
        Object.assign(step, {
            state: attributes.ok ? "ok" : "bad",
            note: attributes.note,
            warnings: attributes.warnings,
            detail: source
        })
        if (!attributes.ok) return

        const phrase = query.value.trim()
        const results = await attempt(
            "search",
            () => send("lab:search", { sourceId: source.id, query: phrase }),
            found => checkSearch(phrase, found, source)
        )
        if (!results) return

        hits.value = results
        chosenHit.value = results[0]!.url
        await fromSeries()
    })

/** Steps 3–6, against whichever search hit is selected. */
async function fromSeries() {
    resetFrom("series")
    const hit = hits.value.find(result => result.url === chosenHit.value)
    if (!hit) return

    const report = await attempt(
        "series",
        () => send("lab:series", { sourceId: sourceId.value, url: hit.url }),
        result => checkSeries(result, { seriesId: hit.seriesId })
    )
    if (!report) return

    seriesId.value = report.seriesId ?? hit.seriesId
    // The ends of the list: the newest episode is what everything else reads,
    // and the oldest is where numbering schemes tend to come apart.
    const ends = [...report.first, ...report.last]
    episodes.value = ends.filter((episode, index) => ends.findIndex(other => other.url === episode.url) === index)
    chosenEpisode.value = episodes.value[0]?.url ?? ""
    await fromPage()
}

/** Steps 4–6, against whichever episode is selected. */
async function fromPage() {
    resetFrom("page")
    const episode = episodes.value.find(candidate => candidate.url === chosenEpisode.value)
    if (!episode) return

    const page = await attempt(
        "page",
        async () => {
            const answer = await send("lab:page", { url: episode.url })
            return { ms: answer.ms, result: answer.result }
        },
        result => checkPage(result.identity, { seriesId: seriesId.value, number: episode.number })
    )
    if (!page) return

    servers.value = page.identity.servers ?? []
    chosenServer.value = servers.value[0]?.name ?? ""
    await fromStreams()
}

/** Steps 5–6, against whichever server is selected. */
async function fromStreams() {
    resetFrom("streams")
    const server = servers.value.find(candidate => candidate.name === chosenServer.value)
    const episode = episodes.value.find(candidate => candidate.url === chosenEpisode.value)
    if (!server || !episode) return

    const resolved = await attempt(
        "streams",
        () => send("lab:streams", { sourceId: sourceId.value, episodeUrl: episode.url, server }),
        checkStreams
    )
    if (!resolved) return

    const stream = resolved.streams.find(candidate => candidate.kind !== "iframe")
    if (!stream) return

    const playlist = stream.kind === "hls" || stream.kind === "dash"
    await attempt(
        "fetch",
        () => send("lab:fetch", { url: stream.url }),
        report => checkFetch(report, { playlist })
    )
}

const runFromSeries = () => guard(fromSeries)
const runFromPage = () => guard(fromPage)
const runFromStreams = () => guard(fromStreams)

// ------------------------------------------------------- manual instruments

const embedUrl = ref("")
const embedReferer = ref("")
const manual = ref<Partial<Record<"extract" | "rules", { ok: boolean; ms?: number; body: string }>>>({})
const manualBusy = ref(false)

async function manualRun(slot: "extract" | "rules", work: () => Promise<unknown>) {
    manualBusy.value = true
    try {
        const answer = (await work()) as { ms?: number; result?: unknown }
        const timed = typeof answer?.ms === "number"
        manual.value = {
            ...manual.value,
            [slot]: { ok: true, ...(timed ? { ms: answer.ms } : {}), body: pretty(timed ? answer.result : answer) }
        }
    } catch (error) {
        manual.value = {
            ...manual.value,
            [slot]: { ok: false, body: error instanceof Error ? error.message : String(error) }
        }
    } finally {
        manualBusy.value = false
    }
}

const extractIt = () =>
    manualRun("extract", () =>
        send("lab:extract", {
            embedUrl: embedUrl.value.trim(),
            ...(embedReferer.value.trim() ? { referer: embedReferer.value.trim() } : {})
        })
    )

const rulesIt = () => manualRun("rules", () => send("lab:rules", {}))

function pretty(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2) ?? String(value)
    } catch {
        return String(value)
    }
}

function pickSource(id: string) {
    sourceId.value = id
    // A followed series is a better search phrase than anything invented here:
    // it is known to exist on this site, and it is one the viewer cares about.
    query.value = known.value.get(id) ?? ""
    steps.value = blank()
}

onMounted(async () => {
    try {
        sources.value = await send("sources:list", {})
        const library = await send("library:list", {})
        const first = new Map<string, string>()
        for (const anime of library) {
            if (!first.has(anime.sourceId)) first.set(anime.sourceId, anime.displayTitle ?? anime.title)
        }
        known.value = first
        pickSource(sources.value.find(source => source.enabled)?.id ?? sources.value[0]?.id ?? "")
    } catch (error) {
        Object.assign(stepAt("source"), { state: "bad", note: String(error) })
    }
    void rulesIt()
})
</script>

<template>
    <main class="lab">
        <header>
            <h1>Lab</h1>
            <p class="lede">
                Pick a source and run the course. Every step runs inside the extension — same fetch context, same header
                rules, same registry as real playback. <code>npm run probe</code> is faster to iterate with, but it
                cannot reproduce a site that demands a <code>Referer</code>: Node can set that header and a browser
                cannot, so the last step here is the one the terminal can never do.
            </p>
        </header>

        <section class="control">
            <div class="row">
                <select
                    :value="sourceId"
                    aria-label="Source"
                    @change="pickSource(($event.target as HTMLSelectElement).value)"
                >
                    <option v-for="source in sources" :key="source.id" :value="source.id">
                        {{ source.name }}{{ source.enabled ? "" : " (off)" }}
                    </option>
                </select>
                <input v-model="query" placeholder="A series to look for" @keyup.enter="runAll" />
                <button class="btn primary" :disabled="running || query.trim() === ''" @click="runAll">
                    {{ running ? "Running…" : "Run the course" }}
                </button>
            </div>
            <p v-if="verdictLine" class="verdict" :class="{ bad: failures > 0 }">{{ verdictLine }}</p>
        </section>

        <ol class="steps">
            <li v-for="step in steps" :key="step.id" class="step" :data-state="step.state">
                <div class="head">
                    <span class="mark">{{
                        step.state === "ok"
                            ? "✓"
                            : step.state === "bad"
                              ? "✗"
                              : step.state === "running"
                                ? "…"
                                : step.state === "skipped"
                                  ? "–"
                                  : "·"
                    }}</span>
                    <span class="name">{{ step.name }}</span>
                    <span v-if="step.ms !== undefined" class="ms">{{ step.ms }} ms</span>
                </div>

                <p class="note">{{ step.note ?? step.hint }}</p>
                <p v-for="(warning, index) in step.warnings" :key="index" class="warn">{{ warning }}</p>

                <!-- Where the chain had a choice, offer to run it again with another. -->
                <div v-if="step.id === 'search' && hits.length > 0" class="fork">
                    <select v-model="chosenHit" aria-label="Series">
                        <option v-for="hit in hits" :key="hit.url" :value="hit.url">{{ hit.title }}</option>
                    </select>
                    <button class="btn tiny" :disabled="running" @click="runFromSeries">Run from here</button>
                </div>

                <div v-if="step.id === 'series' && episodes.length > 0" class="fork">
                    <select v-model="chosenEpisode" aria-label="Episode">
                        <option v-for="episode in episodes" :key="episode.url" :value="episode.url">
                            Episode {{ episode.number }}{{ episode.variant ? ` · ${episode.variant}` : "" }}
                        </option>
                    </select>
                    <button class="btn tiny" :disabled="running" @click="runFromPage">Run from here</button>
                </div>

                <div v-if="step.id === 'page' && servers.length > 0" class="fork">
                    <select v-model="chosenServer" aria-label="Server">
                        <option v-for="server in servers" :key="server.name" :value="server.name">
                            {{ server.name }}
                        </option>
                    </select>
                    <button class="btn tiny" :disabled="running" @click="runFromStreams">Run from here</button>
                </div>

                <details v-if="step.detail !== undefined" class="detail">
                    <summary>What came back</summary>
                    <pre>{{ pretty(step.detail) }}</pre>
                </details>
            </li>
        </ol>

        <section>
            <h2>Extractor, on its own</h2>
            <div class="row">
                <input v-model="embedUrl" placeholder="Embed URL" @keyup.enter="extractIt" />
                <input v-model="embedReferer" placeholder="Referer (optional — an episode URL)" />
                <button class="btn" :disabled="manualBusy || embedUrl.trim() === ''" @click="extractIt">Run</button>
            </div>
            <p class="hint">
                The course reaches an extractor through five steps that all have to work first. When you already know
                which host is broken, this goes straight at it — a dead server is nearly always an extractor that
                stopped matching the host's markup.
            </p>
            <Outcome :outcome="manual.extract" />
        </section>

        <section>
            <h2>Header rules in force</h2>
            <div class="row">
                <button class="btn" :disabled="manualBusy" @click="rulesIt">Refresh</button>
            </div>
            <p class="hint">
                Three separate playback bugs came down to a rule that existed but was scoped to the wrong initiator or
                the wrong host, with nothing in the extension showing what was actually installed.
            </p>
            <Outcome :outcome="manual.rules" />
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
.row select,
.fork select {
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

.verdict {
    margin: 10px 0 0;
    font-size: 12px;
    color: var(--accent);
}

.btn.tiny {
    font-size: 11px;
    padding: 3px 8px;
}

.verdict.bad {
    color: var(--danger);
}

/* ---------------------------------------------------------------- the course */

.steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.step {
    padding: 12px 14px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-left: 3px solid var(--rule);
    border-radius: var(--radius);
}

.step[data-state="ok"] {
    border-left-color: var(--accent);
}

.step[data-state="bad"] {
    border-left-color: var(--danger);
}

.step[data-state="running"] {
    border-left-color: var(--ink-3);
}

.head {
    display: flex;
    align-items: baseline;
    gap: 8px;
}

.mark {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink-3);
    width: 12px;
    flex: 0 0 auto;
}

.step[data-state="ok"] .mark {
    color: var(--accent);
}

.step[data-state="bad"] .mark {
    color: var(--danger);
}

.name {
    font-size: 13px;
    font-weight: 600;
}

.ms {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-3);
}

.note {
    margin: 4px 0 0 20px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--ink-2);
}

.step[data-state="idle"] .note {
    color: var(--ink-3);
}

.step[data-state="bad"] .note {
    color: var(--danger);
}

.warn {
    margin: 3px 0 0 20px;
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--ink-3);
}

.warn::before {
    content: "! ";
    font-family: var(--mono);
}

.fork {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 8px 0 0 20px;
}

.detail {
    margin: 8px 0 0 20px;
}

summary {
    font-size: 11px;
    color: var(--ink-3);
    cursor: pointer;
}

.detail pre {
    margin: 6px 0 0;
    max-height: 320px;
    overflow: auto;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.45;
    color: var(--ink-2);
    background: var(--surface-2);
    border-radius: var(--radius);
    padding: 10px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

code {
    font-family: var(--mono);
    font-size: 11px;
}
</style>
