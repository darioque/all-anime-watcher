<script setup lang="ts">
/** One probe's answer: how long it took, and what came back — or why it didn't. */
defineProps<{ outcome?: { ok: boolean; ms?: number; body: string } }>()
</script>

<template>
    <div v-if="outcome" class="outcome" :class="{ bad: !outcome.ok }">
        <p v-if="outcome.ms !== undefined" class="timing">{{ outcome.ms }} ms</p>
        <pre>{{ outcome.body }}</pre>
    </div>
</template>

<style scoped>
.outcome {
    margin-top: 10px;
    border-top: 1px solid var(--rule);
    padding-top: 8px;
}

.timing {
    margin: 0 0 4px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-3);
}

pre {
    margin: 0;
    max-height: 420px;
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

.bad pre {
    color: var(--danger);
}
</style>
