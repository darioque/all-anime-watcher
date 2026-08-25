<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"

export interface MenuItem {
    label: string
    /** Rendered as a checkmark column, for items that toggle state. */
    checked?: boolean
    danger?: boolean
    disabled?: boolean
    /** Starts a new group above this item. */
    separated?: boolean
    hint?: string
    action: () => void
}

defineProps<{ items: MenuItem[]; label?: string }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function close() {
    open.value = false
}

function onDocumentClick(event: MouseEvent) {
    if (!open.value) return
    if (root.value && !root.value.contains(event.target as Node)) close()
}

function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") close()
}

function run(item: MenuItem) {
    if (item.disabled) return
    close()
    item.action()
}

onMounted(() => {
    document.addEventListener("click", onDocumentClick, true)
    document.addEventListener("keydown", onKey)
})

onBeforeUnmount(() => {
    document.removeEventListener("click", onDocumentClick, true)
    document.removeEventListener("keydown", onKey)
})
</script>

<template>
    <div ref="root" class="menu-root">
        <button
            class="btn icon trigger"
            :class="{ on: open }"
            :aria-expanded="open"
            aria-haspopup="menu"
            :title="label ?? 'More actions'"
            @click.stop="open = !open"
        >
            ⋯
        </button>

        <div v-if="open" class="menu" role="menu">
            <button
                v-for="(item, index) in items"
                :key="index"
                class="item"
                :class="{ danger: item.danger, separated: item.separated, disabled: item.disabled }"
                role="menuitem"
                :disabled="item.disabled"
                @click.stop="run(item)"
            >
                <span class="tick" aria-hidden="true">{{ item.checked ? "✓" : "" }}</span>
                <span class="body">
                    <span class="label">{{ item.label }}</span>
                    <span v-if="item.hint" class="hint">{{ item.hint }}</span>
                </span>
            </button>
        </div>
    </div>
</template>

<style scoped>
.menu-root {
    position: relative;
    display: inline-block;
}

/*
 * Lifted only while it is open, so the dropdown paints above the rows that
 * follow it rather than behind them.
 *
 * The z-index has to sit here rather than on `.menu`, because `.menu` is
 * absolutely positioned *inside* this element: raising it only reorders it
 * against its own siblings. This element is what competes with the other rows.
 *
 * A row that establishes a stacking context of its own — anything with an
 * opacity, transform or filter — defeats this, which is exactly how the bug
 * appeared: unfollowed rows were dimmed with `opacity`, so their menus were
 * trapped and unclickable while every other row's worked.
 */
.menu-root:has(.menu) {
    z-index: 40;
}

.trigger {
    font-size: 13px;
    line-height: 1;
    padding: 3px 8px;
}

.trigger.on {
    border-color: var(--accent);
    color: var(--ink);
}

.menu {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 30;
    min-width: 208px;
    padding: 4px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    box-shadow: 0 10px 28px -10px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 1px;
}

.item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    width: 100%;
    padding: 5px 8px;
    border-radius: 4px;
    text-align: left;
    color: var(--ink-2);
    font-size: 12px;
    background: none;
    cursor: pointer;
}

.item:hover:not(.disabled) {
    background: var(--surface-2);
    color: var(--ink);
}

.item.disabled {
    opacity: 0.45;
    cursor: default;
}

.item.danger {
    color: var(--danger);
}

.item.separated {
    margin-top: 4px;
    border-top: 1px solid var(--rule);
    padding-top: 8px;
    border-radius: 0 0 4px 4px;
}

.tick {
    flex: 0 0 12px;
    color: var(--accent-ink);
    font-size: 11px;
    line-height: 1.5;
}

.body {
    display: flex;
    flex-direction: column;
    min-width: 0;
}

.hint {
    font-size: 10px;
    color: var(--ink-3);
}
</style>
