<script setup lang="ts">
import { onMounted, ref } from "vue"
import { send } from "~/shared/messages"
import type { SourceDescriptor } from "~/shared/messages"
import { relativePast } from "~/shared/time"

const sources = ref<SourceDescriptor[]>([])
const busy = ref<string | null>(null)
const notice = ref<string | null>(null)
const error = ref<string | null>(null)
const adding = ref<string | null>(null)
const newDomain = ref("")

async function load() {
    try {
        sources.value = await send("sources:list", {})
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
    }
}

function flash(message: string) {
    notice.value = message
    setTimeout(() => (notice.value = null), 8000)
}

async function checkDomains(sourceId?: string) {
    busy.value = sourceId ?? "*"
    error.value = null
    try {
        const results = await send("sources:resolveDomains", { ...(sourceId ? { sourceId } : {}), force: true })
        const moved = results.filter(r => r.moved)
        const dead = results.filter(r => r.error)

        if (moved.length > 0) {
            flash(moved.map(r => `${r.sourceId} moved to ${r.current} (${r.rewritten} entries updated)`).join(" · "))
        } else if (dead.length > 0) {
            flash(`${dead.map(r => r.sourceId).join(", ")}: nothing answered`)
        } else {
            flash("Every source is on a working domain")
        }
        await load()
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
    } finally {
        busy.value = null
    }
}

async function pin(sourceId: string, host?: string) {
    busy.value = sourceId
    try {
        await send("sources:pinDomain", { sourceId, ...(host ? { host } : {}) })
        flash(host ? `${sourceId} pinned to ${host}` : `${sourceId} unpinned — it can move again`)
        adding.value = null
        newDomain.value = ""
        await load()
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
    } finally {
        busy.value = null
    }
}

const activeHost = (s: SourceDescriptor) => s.pinnedDomain ?? s.preferredDomain ?? s.domains[0] ?? "—"

onMounted(load)
</script>

<template>
    <section class="sources">
        <header>
            <h2>Sources</h2>
            <button class="btn" :disabled="busy !== null" @click="checkDomains()">
                {{ busy === "*" ? "Checking…" : "Check all domains" }}
            </button>
        </header>

        <p class="note">
            These sites change domain often. Where a site publishes its current addresses, that page is checked
            automatically and your library follows along — nothing you've watched is affected, because a series is
            identified by the site and its own id rather than by a URL.
        </p>

        <p v-if="error" class="error">{{ error }}</p>
        <p v-if="notice" class="flash">{{ notice }}</p>

        <div v-for="source in sources" :key="source.id" class="source">
            <div class="head">
                <span class="name">{{ source.name }}</span>
                <span class="host" :class="{ pinned: source.pinnedDomain }">{{ activeHost(source) }}</span>
                <span v-if="source.pinnedDomain" class="badge">pinned</span>
                <span v-else-if="source.hasDomainSource" class="badge auto">auto</span>
                <span
                    v-if="source.lastDomainCheckResult === 'unreachable'"
                    class="badge bad"
                    title="No known domain answered at the last check"
                >
                    unreachable
                </span>
                <span class="spacer"></span>
                <span class="checked">
                    {{
                        source.lastDomainCheckAt ? `checked ${relativePast(source.lastDomainCheckAt)}` : "never checked"
                    }}
                </span>
            </div>

            <div class="known">
                <button
                    v-for="host in source.knownDomains ?? []"
                    :key="host"
                    class="hostchip"
                    :class="{ on: host === activeHost(source) }"
                    :disabled="busy === source.id"
                    :title="host === activeHost(source) ? 'In use' : `Pin ${host} and use it from now on`"
                    @click="pin(source.id, host)"
                >
                    {{ host }}
                </button>

                <button
                    v-if="adding !== source.id"
                    class="hostchip add"
                    :disabled="busy === source.id"
                    @click="adding = source.id"
                >
                    + add
                </button>
                <span v-else class="addrow">
                    <input
                        v-model="newDomain"
                        type="text"
                        placeholder="new-domain.example"
                        @keyup.enter="pin(source.id, newDomain)"
                    />
                    <button class="btn" :disabled="!newDomain.trim()" @click="pin(source.id, newDomain)">Use</button>
                    <button class="btn" @click="((adding = null), (newDomain = ''))">Cancel</button>
                </span>
            </div>

            <div class="actions">
                <button class="btn" :disabled="busy === source.id" @click="checkDomains(source.id)">
                    {{ busy === source.id ? "Checking…" : "Check now" }}
                </button>
                <button v-if="source.pinnedDomain" class="btn" :disabled="busy === source.id" @click="pin(source.id)">
                    Unpin
                </button>
            </div>
        </div>
    </section>
</template>

<style scoped>
.sources {
    padding: 0 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
}

h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
}

.note {
    margin: 0;
    font-size: 11px;
    color: var(--ink-3);
    max-width: 68ch;
    line-height: 1.5;
}

.source {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}

.head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.name {
    font-weight: 600;
    font-size: 13px;
}

.host {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--accent-ink);
}

.host.pinned {
    color: var(--ink-2);
}

.badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--surface-2);
    color: var(--ink-3);
}

.badge.auto {
    background: var(--accent-soft);
    color: var(--accent-ink);
}

.badge.bad {
    background: var(--danger-soft);
    color: var(--danger);
}

.spacer {
    flex: 1 1 auto;
}

.checked {
    font-size: 11px;
    color: var(--ink-3);
}

.known {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
}

.hostchip {
    font-family: var(--mono);
    font-size: 10px;
    padding: 2px 7px;
    border: 1px solid var(--rule);
    border-radius: 3px;
    color: var(--ink-3);
    background: none;
    cursor: pointer;
}

.hostchip:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--accent);
}

.hostchip.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
}

.hostchip.add {
    font-family: var(--font);
    color: var(--ink-3);
    border-style: dashed;
}

.addrow {
    display: inline-flex;
    gap: 4px;
    align-items: center;
}

.addrow input {
    font: inherit;
    font-size: 11px;
    padding: 2px 6px;
    color: var(--ink);
    background: var(--ground);
    border: 1px solid var(--rule);
    border-radius: 3px;
    width: 190px;
}

.actions {
    display: flex;
    gap: 5px;
}

.actions .btn {
    font-size: 11px;
    padding: 3px 8px;
}

.error {
    margin: 0;
    color: var(--danger);
    background: var(--danger-soft);
    padding: 8px 10px;
    border-radius: var(--radius);
    font-size: 12px;
}

.flash {
    margin: 0;
    font-size: 11px;
    color: var(--accent-ink);
}
</style>
