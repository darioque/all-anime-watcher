<script setup lang="ts">
import { computed, ref, watch } from "vue"
import type { SchedulePolicy, Weekday } from "~/model/types"
import { normalizeSchedule } from "~/background/schedule"

const props = defineProps<{
    modelValue: SchedulePolicy
    /** Omit "inherit" at the global level, where there is nothing to inherit from. */
    allowInherit?: boolean
    /** Shown next to "Use the default" so the inherited value isn't a mystery. */
    inheritedLabel?: string
}>()

const emit = defineEmits<{ "update:modelValue": [SchedulePolicy] }>()

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

const mode = ref<SchedulePolicy["mode"]>(props.modelValue.mode)
const everyHours = ref(props.modelValue.mode === "interval" ? props.modelValue.everyHours : 6)
const days = ref(props.modelValue.mode === "everyNDays" ? props.modelValue.days : 7)

/*
 * Through `normalizeSchedule` rather than reading the fields directly: a policy
 * saved before weekly took lists is still `{ weekday, time }` in storage, and
 * the picker is the one place that would otherwise show it as empty and then
 * write that emptiness back the moment anything else on the row was touched.
 */
const weekly = normalizeSchedule(props.modelValue)
const weekdays = ref<Weekday[]>(weekly.mode === "weekly" ? [...weekly.weekdays] : [2])
const times = ref<string[]>(weekly.mode === "weekly" ? [...weekly.times] : ["18:00"])

watch(
    () => props.modelValue,
    value => {
        mode.value = value.mode
        if (value.mode === "interval") everyHours.value = value.everyHours
        if (value.mode === "everyNDays") days.value = value.days
        const current = normalizeSchedule(value)
        if (current.mode === "weekly") {
            weekdays.value = [...current.weekdays]
            times.value = [...current.times]
        }
    }
)

function toggleDay(day: Weekday) {
    // Never down to nothing: a weekly schedule with no days has no next slot,
    // and the honest answer to that is a day's fallback rather than a policy
    // the user can save and never be told about again.
    if (weekdays.value.includes(day)) {
        if (weekdays.value.length === 1) return
        weekdays.value = weekdays.value.filter(existing => existing !== day)
    } else {
        weekdays.value = [...weekdays.value, day].sort((a, b) => a - b)
    }
    emitChange()
}

function setTime(index: number, value: string) {
    if (!value) return
    times.value = times.value.map((existing, at) => (at === index ? value : existing))
    emitChange()
}

function addTime() {
    // An hour after the last one, wrapped, so the new row is never a duplicate
    // of the row it was added from — which would silently collapse on save.
    const last = times.value[times.value.length - 1] ?? "18:00"
    const [hours = 18, minutes = 0] = last.split(":").map(Number)
    const next = `${String((hours + 1) % 24).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
    times.value = [...times.value, times.value.includes(next) ? "00:00" : next]
    emitChange()
}

function removeTime(index: number) {
    if (times.value.length === 1) return
    times.value = times.value.filter((_, at) => at !== index)
    emitChange()
}

function build(): SchedulePolicy {
    switch (mode.value) {
        case "inherit":
            return { mode: "inherit" }
        case "never":
            return { mode: "never" }
        case "weekly":
            return {
                mode: "weekly",
                weekdays: [...weekdays.value].sort((a, b) => a - b),
                // Deduped and ordered here rather than on the way in, so typing
                // a time that briefly matches another does not delete a row out
                // from under the cursor.
                times: [...new Set(times.value)].sort()
            }
        case "everyNDays":
            return { mode: "everyNDays", days: days.value, from: Date.now() }
        default:
            return { mode: "interval", everyHours: everyHours.value }
    }
}

const emitChange = () => emit("update:modelValue", build())

/** "Wed", "Wed and Thu", "Mon, Wed and Thu". */
const listed = (parts: string[]) =>
    parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`

const summary = computed(() => {
    switch (mode.value) {
        case "inherit":
            return props.inheritedLabel ? `Using the default (${props.inheritedLabel})` : "Using the default"
        case "never":
            return "Followed, but never checked automatically"
        case "interval":
            return `Checked every ${everyHours.value}h`
        case "weekly": {
            const when = `${listed(weekdays.value.map(day => SHORT[day] ?? ""))} at ${listed([...new Set(times.value)].sort())}`
            const slots = weekdays.value.length * new Set(times.value).size
            return `Checked ${when} — ${slots} check${slots === 1 ? "" : "s"} a week`
        }
        case "everyNDays":
            return `Checked every ${days.value} day${days.value === 1 ? "" : "s"}`
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
                On these days
            </button>
            <button class="chip" :class="{ on: mode === 'everyNDays' }" @click="((mode = 'everyNDays'), emitChange())">
                Every N days
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

        <template v-else-if="mode === 'weekly'">
            <div class="row">
                <label>On</label>
                <div class="days">
                    <button
                        v-for="(name, index) in SHORT"
                        :key="index"
                        class="day"
                        :class="{ on: weekdays.includes(index as Weekday) }"
                        :title="WEEKDAYS[index]"
                        @click="toggleDay(index as Weekday)"
                    >
                        {{ name }}
                    </button>
                </div>
            </div>

            <div class="row">
                <label>At</label>
                <div class="times">
                    <span v-for="(value, index) in times" :key="index" class="time">
                        <input
                            type="time"
                            :value="value"
                            @change="setTime(index, ($event.target as HTMLInputElement).value)"
                        />
                        <button
                            v-if="times.length > 1"
                            class="drop"
                            title="Remove this time"
                            @click="removeTime(index)"
                        >
                            ×
                        </button>
                    </span>
                    <button class="add" @click="addTime">+ time</button>
                </div>
            </div>
        </template>

        <div v-else-if="mode === 'everyNDays'" class="row">
            <label>Every</label>
            <input v-model.number="days" type="number" min="1" max="90" @change="emitChange" />
            <span class="unit">days, starting today</span>
        </div>

        <p class="summary">{{ summary }}</p>
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

.days,
.times {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
}

.day {
    font-size: 11px;
    padding: 3px 7px;
    border: 1px solid var(--rule);
    border-radius: 4px;
    color: var(--ink-3);
    background: var(--surface);
    cursor: pointer;
}

.day:hover {
    color: var(--ink);
    border-color: var(--accent);
}

.day.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-ink);
    font-weight: 600;
}

.time {
    display: inline-flex;
    align-items: center;
    gap: 2px;
}

.drop,
.add {
    font: inherit;
    font-size: 11px;
    padding: 3px 6px;
    border: 1px solid var(--rule);
    border-radius: 4px;
    color: var(--ink-3);
    background: var(--surface);
    cursor: pointer;
}

.drop:hover {
    color: var(--state-warn);
    border-color: var(--state-warn);
}

.add:hover {
    color: var(--ink);
    border-color: var(--accent);
}
</style>
