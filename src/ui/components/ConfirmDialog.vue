<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue"

const props = defineProps<{
    open: boolean
    title: string
    body?: string
    confirmLabel?: string
    danger?: boolean
}>()

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const confirmButton = ref<HTMLButtonElement | null>(null)

function onKey(event: KeyboardEvent) {
    if (!props.open) return
    if (event.key === "Escape") emit("cancel")
    if (event.key === "Enter") emit("confirm")
}

// Focus the confirm button so the dialog is operable from the keyboard, and so
// it is obvious which action is about to happen.
watch(
    () => props.open,
    isOpen => {
        if (isOpen) requestAnimationFrame(() => confirmButton.value?.focus())
    }
)

onMounted(() => document.addEventListener("keydown", onKey))
onBeforeUnmount(() => document.removeEventListener("keydown", onKey))
</script>

<template>
    <div v-if="open" class="scrim" role="dialog" aria-modal="true" @click.self="emit('cancel')">
        <div class="dialog">
            <h3>{{ title }}</h3>
            <p v-if="body">{{ body }}</p>
            <div class="actions">
                <button class="btn" @click="emit('cancel')">Cancel</button>
                <button
                    ref="confirmButton"
                    class="btn"
                    :class="danger ? 'danger-solid' : 'primary'"
                    @click="emit('confirm')"
                >
                    {{ confirmLabel ?? "Confirm" }}
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.scrim {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    background: rgba(8, 12, 15, 0.55);
}

.dialog {
    width: 100%;
    max-width: 340px;
    padding: 16px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    box-shadow: 0 18px 44px -16px rgba(0, 0, 0, 0.6);
}

h3 {
    margin: 0 0 6px;
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
}

p {
    margin: 0 0 14px;
    font-size: 12px;
    color: var(--ink-2);
    line-height: 1.5;
}

.actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
}

.danger-solid {
    background: var(--danger);
    border-color: var(--danger);
    color: var(--surface);
    font-weight: 600;
}

.danger-solid:hover {
    filter: brightness(1.08);
}
</style>
