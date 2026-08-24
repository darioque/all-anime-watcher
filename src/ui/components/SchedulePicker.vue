<script setup lang="ts">
import { computed, ref, watch } from "vue"
import type { SchedulePolicy } from "~/model/types"

const props = defineProps<{
    modelValue: SchedulePolicy
    /** Omit "inherit" at the global level, where there is nothing to inherit from. */
    allowInherit?: boolean
    /** Shown next to "Use the default" so the inherited value isn't a mystery. */
    inheritedLabel?: string
}>()

const emit = defineEmits<{ "update:modelValue": [SchedulePolicy] }>()

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

const mode = ref<SchedulePolicy["mode"]>(props.modelValue.mode)
const everyHours = ref(props.modelValue.mode === "interval" ? props.modelValue.everyHours : 6)
const weekday = ref<number>(props.modelValue.mode === "weekly" ? props.modelValue.weekday : 2)
const time = ref(props.modelValue.mode === "weekly" ? props.modelValue.time : "18:00")
const days = ref(props.modelValue.mode === "everyNDays" ? props.modelValue.days : 7)
const fallbackHours = ref(props.modelValue.mode === "airing" ? props.modelValue.fallbackHours : 12)

watch(
    () => props.modelValue,
    value => {
        mode.value = value.mode
        if (value.mode === "interval") everyHours.value = value.everyHours
        if (value.mode === "weekly") {
            weekday.value = value.weekday
            time.value = value.time
        }
        if (value.mode === "everyNDays") days.value = value.days
        if (value.mode === "airing") fallbackHours.value = value.fallbackHours
    }
)

function build(): SchedulePolicy {
    switch (mode.value) {
        case "inherit":
            return { mode: "inherit" }
        case "never":
            return { mode: "never" }
        case "weekly":
            return { mode: "weekly", weekday: weekday.value as 0, time: time.value }
        case "everyNDays":
            return { mode: "everyNDays", days: days.value, from: Date.now() }
        case "airing":
            return { mode: "airing", padBeforeMin: 15, padAfterMin: 120, fallbackHours: fallbackHours.value }
        default:
            return { mode: "interval", everyHours: everyHours.value }
    }
}

const emitChange = () => emit("update:modelValue", build())

const summary = computed(() => {
    switch (mode.value) {
        case "inherit":
            return props.inheritedLabel ? `Using the default (${props.inheritedLabel})` : "Using the default"
        case "never":
            return "Followed, but never checked automatically"
        case "interval":
            return `Checked every ${everyHours.value}h`
        case "weekly":
            return `Checked ${WEEKDAYS[weekday.value]}s at ${time.value}`
        case "everyNDays":
            return `Checked every ${days.value} day${days.value === 1 ? "" : "s"}`
        case "airing":
            return `Around the air time, falling back to every ${fallbackHours.value}h`
        default:
            return ""
    }
})
</script>

<template>
    <div class="picker">
        <div class="modes">
            <button
                v-if="allowInherit"
                class="chip"
                :class="{ on: mode === 'inherit' }"
                @click="((mode = 'inherit'), emitChange())"
            >
                Default
            </button>
            <button class="chip" :class="{ on: mode === 'interval' }" @click="((mode = 'interval'), emitChange())">
                Every N hours
            </button>
            <button class="chip" :class="{ on: mode === 'weekly' }" @click="((mode = 'weekly'), emitChange())">
                Weekly
            </button>
            <button class="chip" :class="{ on: mode === 'everyNDays' }" @click="((mode = 'everyNDays'), emitChange())">
                Every N days
            </button>
            <button class="chip" :class="{ on: mode === 'airing' }" @click="((mode = 'airing'), emitChange())">
                Air time
            </button>
            <button class="chip" :class="{ on: mode === 'never' }" @click="((mode = 'never'), emitChange())">
                Never
            </button>
        </div>

        <div v-if="mode === 'interval'" class="row">
            <label>Every</label>
            <input v-model.number="everyHours" type="number" min="1" max="168" @change="emitChange" />
            <span class="unit">hours</span>
        </div>

        <div v-else-if="mode === 'weekly'" class="row">
            <label>Every</label>
            <select v-model.number="weekday" @change="emitChange">
                <option v-for="(name, index) in WEEKDAYS" :key="index" :value="index">{{ name }}</option>
            </select>
            <label>at</label>
            <input v-model="time" type="time" @change="emitChange" />
        </div>

        <div v-else-if="mode === 'everyNDays'" class="row">
            <label>Every</label>
            <input v-model.number="days" type="number" min="1" max="90" @change="emitChange" />
            <span class="unit">days, starting today</span>
        </div>

        <div v-else-if="mode === 'airing'" class="row">
            <label>Fall back to every</label>
            <input v-model.number="fallbackHours" type="number" min="1" max="168" @change="emitChange" />
            <span class="unit">hours when the air time is unknown</span>
        </div>

        <p class="summary">{{ summary }}</p>
        <p v-if="mode === 'airing'" class="caveat">
            Air times arrive with the AniList work. Until then this behaves like the fallback interval.
        </p>
    </div>
</template>

<style scoped>
.picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.modes {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}

.chip {
    font-size: 11px;
    padding: 3px 8px;
    border: 1px solid var(--rule);
    border-radius: 4px;
    color: var(--ink-2);
    background: var(--surface);
    cursor: pointer;
    white-space: nowrap;
}

.chip:hover {
    color: var(--ink);
    border-color: var(--accent);
}

.chip.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-ink);
    font-weight: 600;
}

.row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 12px;
    color: var(--ink-2);
}

input,
select {
    font: inherit;
    font-size: 12px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 4px;
    padding: 3px 6px;
}

input[type="number"] {
    width: 62px;
}

.unit {
    color: var(--ink-3);
}

.summary {
    margin: 0;
    font-size: 11px;
    color: var(--ink-3);
}

.caveat {
    margin: 0;
    font-size: 11px;
    color: var(--state-warn);
}
</style>
