<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"
import SettingsPanel from "./SettingsPanel.vue"
import SourcesPanel from "./SourcesPanel.vue"
import BackupPanel from "./BackupPanel.vue"

const emit = defineEmits<{ close: [] }>()

/**
 * The sections, in the order they are worth reading.
 *
 * Two groups, split by what they are rather than by how many fit. Above the rule
 * are preferences — a form of toggles and numbers, all served by one
 * descriptor-driven panel. Below it are the three that are not: a live list of
 * sites, a data export, and a tool that opens its own tab. Running them together
 * was what made settings read as one undifferentiated slab, and a plain
 * alphabetical or arbitrary order would put them back.
 */
const SECTIONS = [
    { id: "tracking", label: "Tracking" },
    { id: "checking", label: "Checking for new episodes" },
    { id: "notifications", label: "Notifications" },
    { id: "playback", label: "Playback" },
    { id: "anilist", label: "AniList" },
    { id: "domains", label: "Domains" },
    { id: "interface", label: "Interface" },
    { id: "sources", label: "Sources", apart: true },
    { id: "backup", label: "Backup" },
    { id: "lab", label: "Lab" },
    { id: "database", label: "Database" }
] as const

type SectionId = (typeof SECTIONS)[number]["id"]

const active = ref<SectionId>("tracking")
const dialog = ref<HTMLElement | null>(null)

const labelFor = (id: SectionId) => SECTIONS.find(s => s.id === id)?.label ?? ""

function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
        event.stopPropagation()
        emit("close")
    }
}

/*
 * The page behind a modal must not scroll with it — otherwise closing returns
 * you somewhere else in a library that can be hundreds of rows long.
 */
let previousOverflow = ""

onMounted(() => {
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    window.addEventListener("keydown", onKey, true)
    dialog.value?.focus()
})

onBeforeUnmount(() => {
    document.body.style.overflow = previousOverflow
    window.removeEventListener("keydown", onKey, true)
})
</script>

<template>
    <!-- Clicking the backdrop closes; clicking inside must not, hence .self. -->
    <div class="backdrop" @click.self="emit('close')">
        <div ref="dialog" class="dialog" role="dialog" aria-modal="true" aria-label="Settings" tabindex="-1">
            <header class="bar">
                <h2>Settings</h2>
                <span class="crumb">{{ labelFor(active) }}</span>
                <span class="grow"></span>
                <button class="close" title="Close settings" aria-label="Close settings" @click="emit('close')">
                    ✕
                </button>
            </header>

            <div class="body">
                <nav class="nav" aria-label="Settings sections">
                    <template v-for="section in SECTIONS" :key="section.id">
                        <hr v-if="'apart' in section && section.apart" />
                        <button
                            class="nav-item"
                            :class="{ on: active === section.id }"
                            :aria-current="active === section.id ? 'true' : undefined"
                            @click="active = section.id"
                        >
                            {{ section.label }}
                        </button>
                    </template>
                </nav>

                <div class="content">
                    <SourcesPanel v-if="active === 'sources'" />
                    <BackupPanel v-else-if="active === 'backup'" />
                    <SettingsPanel v-else :section="active" />
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgb(0 0 0 / 45%);
}

.dialog {
    display: flex;
    flex-direction: column;
    width: min(860px, 100%);
    height: min(640px, 100%);
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    overflow: hidden;
}

.bar {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--rule);
}

h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
}

/* The section name, so the title bar says where you are as well as what this is. */
.crumb {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-3);
}

.grow {
    flex: 1;
}

.close {
    flex: none;
    padding: 2px 8px;
    font-size: 13px;
    color: var(--ink-3);
    background: none;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    cursor: pointer;
}

.close:hover {
    color: var(--ink);
    border-color: var(--ink-3);
}

.body {
    display: flex;
    flex: 1;
    min-height: 0;
}

.nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: none;
    width: 180px;
    padding: 10px 8px;
    overflow-y: auto;
    background: var(--ground);
    border-right: 1px solid var(--rule);
}

.nav hr {
    margin: 6px 6px;
    border: 0;
    border-top: 1px solid var(--rule);
}

.nav-item {
    padding: 6px 8px;
    font: inherit;
    font-size: 12px;
    text-align: left;
    color: var(--ink);
    background: none;
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
}

.nav-item:hover {
    background: var(--surface);
}

/*
 * The selected section carries weight and a rule as well as colour — this is
 * the only thing telling you which of ten panes you are looking at.
 */
.nav-item.on {
    font-weight: 600;
    color: var(--accent-ink);
    background: var(--accent-soft);
}

.content {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
}

/* Narrow windows: the rail becomes a wrapping strip above the content. */
@media (max-width: 640px) {
    .backdrop {
        padding: 0;
    }

    .dialog {
        width: 100%;
        height: 100%;
        border: 0;
        border-radius: 0;
    }

    .body {
        flex-direction: column;
    }

    .nav {
        flex-direction: row;
        flex-wrap: wrap;
        width: auto;
        border-right: 0;
        border-bottom: 1px solid var(--rule);
    }

    .nav hr {
        display: none;
    }
}
</style>
