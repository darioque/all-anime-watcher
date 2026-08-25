<script setup lang="ts">
import browser from "webextension-polyfill"
import { onMounted, ref } from "vue"
import { send } from "~/shared/messages"
import type { GlobalSettings } from "~/settings/schema"
import SchedulePicker from "./SchedulePicker.vue"
import BackupPanel from "./BackupPanel.vue"

/** Its own tab: probing a source is a sit-down job, not a settings toggle. */
function openLab() {
    void send("tab:open", { url: browser.runtime.getURL("src/ui/lab/index.html"), active: true })
}

const settings = ref<GlobalSettings | null>(null)
const saving = ref(false)
const error = ref<string | null>(null)

/**
 * Descriptor-driven rather than a hand-written form: every setting has to be
 * reachable from the UI or "nothing hardcoded" is only true in the type system,
 * and a table is the only way that stays true as settings are added.
 */
interface Field {
    key: keyof GlobalSettings
    label: string
    help?: string
    type: "toggle" | "number" | "text" | "list" | "select"
    options?: { value: string; label: string }[]
    min?: number
    max?: number
    step?: number
}

const GROUPS: { title: string; note?: string; fields: Field[] }[] = [
    {
        title: "Tracking",
        fields: [
            { key: "autoAddOnWatch", label: "Add a series when I open an episode", type: "toggle" },
            { key: "followOnAdd", label: "Follow newly added series", type: "toggle" },
            { key: "pollOnAdd", label: "Check newly added series for new episodes", type: "toggle" },
            {
                key: "markWatchedOnOpen",
                label: "Opening an episode moves my position to it",
                help: "Only ever forward — opening an earlier episode is a rewatch and leaves your position alone.",
                type: "toggle"
            },
            {
                key: "markWatchedOnEmbed",
                label: "Count an embedded episode as watched on open",
                help: "For hosts we can't extract, where the site's own player runs in a frame. Nothing can see inside one, so opening it is the only signal there will ever be.",
                type: "toggle"
            },
            {
                key: "completionThreshold",
                label: "Count an episode as watched at",
                help: "A fraction of its length. 0.85 means 85% in.",
                type: "number",
                min: 0.1,
                max: 1,
                step: 0.05
            }
        ]
    },
    {
        title: "Checking for new episodes",
        note: "Any series can override the schedule from its own row in the list.",
        fields: [
            {
                key: "sourceRequestDelaySec",
                label: "Wait between requests to one site",
                help: "Seconds. Politeness to a single site, not overall speed.",
                type: "number",
                min: 0,
                max: 60
            },
            { key: "maxParallelSources", label: "Sites checked at once", type: "number", min: 1, max: 10 },
            {
                key: "releaseDelayMin",
                label: "Sites are usually behind the broadcast by",
                help: "Minutes. Used by the “Air time” schedule — no site has an episode subtitled the minute it airs, and checking then just wastes the window. A series can state its own.",
                type: "number",
                min: 0,
                max: 10080,
                step: 15
            },
            { key: "maxChecksPerRun", label: "Most series checked per wake-up", type: "number", min: 1, max: 500 },
            {
                key: "checkTimeoutSec",
                label: "Give up on one series after",
                help: "Seconds.",
                type: "number",
                min: 5,
                max: 300
            }
        ]
    },
    {
        title: "Notifications",
        fields: [
            { key: "notifyNewEpisode", label: "Notify me about new episodes", type: "toggle" },
            {
                key: "notificationTimeoutMs",
                label: "Dismiss a notification after",
                help: "Milliseconds. 0 keeps it until you dismiss it.",
                type: "number",
                min: 0,
                max: 120000,
                step: 1000
            }
        ]
    },
    {
        title: "Playback",
        fields: [
            { key: "takeOverPage", label: "Replace the site's player with ours", type: "toggle" },
            {
                key: "preferredServers",
                label: "Preferred servers, best first",
                help: "Matched loosely against the site's own labels. Comma separated; empty means the page's order.",
                type: "list"
            },
            { key: "preferredQuality", label: "Preferred quality", type: "text" },
            {
                key: "variantPref",
                label: "Preferred track",
                type: "select",
                options: [
                    { value: "sub", label: "Subtitled" },
                    { value: "dub", label: "Dubbed" },
                    { value: "raw", label: "Raw" }
                ]
            },
            { key: "autoAdvance", label: "Play the next episode automatically", type: "toggle" },
            {
                key: "skipIntro",
                label: "Opening",
                help: "Timings come from the site when it publishes them, otherwise from AniSkip — which needs the series matched on AniList.",
                type: "select",
                options: [
                    { value: "off", label: "Do nothing" },
                    { value: "button", label: "Show a skip button" },
                    { value: "auto", label: "Skip automatically" }
                ]
            },
            {
                key: "skipOutro",
                label: "Ending",
                type: "select",
                options: [
                    { value: "off", label: "Do nothing" },
                    { value: "button", label: "Show a skip button" },
                    { value: "auto", label: "Skip automatically" }
                ]
            },
            {
                key: "progressTickSec",
                label: "Save my position every",
                help: "Seconds.",
                type: "number",
                min: 1,
                max: 60
            }
        ]
    },
    {
        title: "AniList",
        note: "Read-only. Nothing is sent to AniList, and no sign-in is needed for either of these.",
        fields: [
            {
                key: "anilistMetadata",
                label: "Fill in posters and titles from AniList",
                help: "Only fills gaps — never replaces a poster or title the site already gave.",
                type: "toggle"
            },
            {
                key: "anilistSchedule",
                label: "Use real air times for scheduling",
                help: "Lets the “Air time” schedule check a series when its episode is actually due.",
                type: "toggle"
            }
        ]
    },
    {
        title: "Domains",
        note: "Sites here change address often; see the Sources section below to check or pin one.",
        fields: [
            {
                key: "domainCheckIntervalHours",
                label: "Re-check announced domains every",
                help: "Hours.",
                type: "number",
                min: 1,
                max: 168
            },
            {
                key: "autoPromoteDomain",
                label: "Follow a site automatically when it moves",
                help: "Rewrites stored links. Your watch history is never affected.",
                type: "toggle"
            }
        ]
    },
    {
        title: "Interface",
        fields: [
            { key: "openInTab", label: "Toolbar button opens the full library", type: "toggle" },
            {
                key: "groupBySeries",
                label: "One row per show, not per source",
                help: "Collapses a series carried by several sites into one row. Matching on AniList is what makes this reliable — titles alone only catch near-identical spellings.",
                type: "toggle"
            },
            {
                key: "logLevel",
                label: "Console detail",
                type: "select",
                options: [
                    { value: "silent", label: "Silent" },
                    { value: "error", label: "Errors" },
                    { value: "warn", label: "Warnings" },
                    { value: "info", label: "Info" },
                    { value: "debug", label: "Debug" }
                ]
            }
        ]
    }
]

async function load() {
    try {
        settings.value = await send("settings:get", {})
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
    }
}

async function patch(key: keyof GlobalSettings, value: unknown) {
    if (!settings.value) return
    saving.value = true
    error.value = null
    try {
        settings.value = await send("settings:patch", { patch: { [key]: value } as Partial<GlobalSettings> })
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
    } finally {
        saving.value = false
    }
}

const notificationResult = ref<string | null>(null)

async function testNotification() {
    try {
        const ok = await send("debug:testNotification", {})
        notificationResult.value = ok
            ? "Sent — if nothing appeared, notifications are blocked at the OS or browser level."
            : "The browser refused to raise it."
    } catch (e) {
        notificationResult.value = e instanceof Error ? e.message : String(e)
    }
    setTimeout(() => (notificationResult.value = null), 10000)
}

const asList = (value: unknown) => (Array.isArray(value) ? value.join(", ") : "")
const fromList = (value: string) =>
    value
        .split(",")
        .map(part => part.trim())
        .filter(part => part !== "")

onMounted(load)
</script>

<template>
    <section class="settings">
        <header>
            <h2>Settings</h2>
            <span v-if="saving" class="saving">saving…</span>
        </header>

        <p v-if="error" class="error">{{ error }}</p>
        <p v-if="!settings" class="muted">Loading…</p>

        <template v-else>
            <div v-for="group in GROUPS" :key="group.title" class="group">
                <h3>{{ group.title }}</h3>
                <p v-if="group.note" class="note">{{ group.note }}</p>

                <div v-for="field in group.fields" :key="field.key" class="field">
                    <div class="text">
                        <label :for="field.key">{{ field.label }}</label>
                        <p v-if="field.help" class="help">{{ field.help }}</p>
                    </div>

                    <div class="control">
                        <input
                            v-if="field.type === 'toggle'"
                            :id="field.key"
                            type="checkbox"
                            :checked="Boolean(settings[field.key])"
                            @change="patch(field.key, ($event.target as HTMLInputElement).checked)"
                        />

                        <input
                            v-else-if="field.type === 'number'"
                            :id="field.key"
                            type="number"
                            :min="field.min"
                            :max="field.max"
                            :step="field.step ?? 1"
                            :value="settings[field.key]"
                            @change="patch(field.key, Number(($event.target as HTMLInputElement).value))"
                        />

                        <select
                            v-else-if="field.type === 'select'"
                            :id="field.key"
                            :value="settings[field.key]"
                            @change="patch(field.key, ($event.target as HTMLSelectElement).value)"
                        >
                            <option v-for="option in field.options" :key="option.value" :value="option.value">
                                {{ option.label }}
                            </option>
                        </select>

                        <input
                            v-else-if="field.type === 'list'"
                            :id="field.key"
                            type="text"
                            :value="asList(settings[field.key])"
                            @change="patch(field.key, fromList(($event.target as HTMLInputElement).value))"
                        />

                        <input
                            v-else
                            :id="field.key"
                            type="text"
                            :value="settings[field.key]"
                            @change="patch(field.key, ($event.target as HTMLInputElement).value)"
                        />
                    </div>
                </div>
            </div>

            <div class="group">
                <h3>Checking it works</h3>
                <p class="note">
                    You can't make a site publish an episode, so this runs the real new-episode notification against a
                    series you follow, using a pretend episode number. If it appears, the whole path works.
                </p>
                <div class="field">
                    <div class="text">
                        <label for="test-notification">Send a test notification</label>
                        <p v-if="notificationResult" class="help">{{ notificationResult }}</p>
                    </div>
                    <div class="control">
                        <button id="test-notification" class="btn" @click="testNotification">Send</button>
                    </div>
                </div>
            </div>

            <div class="group">
                <h3>Lab</h3>
                <p class="note">
                    Run one piece of a source or extractor on demand, inside the extension — same fetch context, same
                    header rules, same registry as real playback. Where a source has broken, this says which step.
                </p>
                <div class="field">
                    <div class="text">
                        <label for="open-lab">Open the Lab</label>
                    </div>
                    <div class="control">
                        <button id="open-lab" class="btn" @click="openLab">Open</button>
                    </div>
                </div>
            </div>

            <BackupPanel />

            <div class="group">
                <h3>Default schedule</h3>
                <p class="note">What a series is checked on unless it says otherwise.</p>
                <SchedulePicker
                    :model-value="settings.schedule"
                    @update:model-value="value => patch('schedule', value)"
                />
            </div>
        </template>
    </section>
</template>

<style scoped>
.settings {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 20px;
}

header {
    display: flex;
    align-items: baseline;
    gap: 10px;
}

h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
}

h3 {
    margin: 0 0 2px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-3);
}

.saving {
    font-size: 11px;
    color: var(--accent-ink);
}

.group {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}

.note {
    margin: 0 0 6px;
    font-size: 11px;
    color: var(--ink-3);
}

.field {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 5px 0;
    border-top: 1px solid var(--rule);
}

.field:first-of-type {
    border-top: none;
}

.text {
    min-width: 0;
}

label {
    font-size: 12px;
    color: var(--ink);
}

.help {
    margin: 1px 0 0;
    font-size: 11px;
    color: var(--ink-3);
}

.control {
    flex: 0 0 auto;
}

input[type="text"],
input[type="number"],
select {
    font: inherit;
    font-size: 12px;
    color: var(--ink);
    background: var(--ground);
    border: 1px solid var(--rule);
    border-radius: 4px;
    padding: 3px 6px;
}

input[type="number"] {
    width: 78px;
}

input[type="text"] {
    width: 190px;
}

input[type="checkbox"] {
    width: 15px;
    height: 15px;
    accent-color: var(--accent);
}

.error {
    margin: 0;
    color: var(--danger);
    background: var(--danger-soft);
    padding: 8px 10px;
    border-radius: var(--radius);
    font-size: 12px;
}

.muted {
    color: var(--ink-3);
    margin: 0;
}
</style>
