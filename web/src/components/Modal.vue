<script setup lang="ts">
defineProps<{
  title: string
  wide?: boolean
}>()

const emit = defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="modal" :class="{ 'modal-wide': wide }">
      <div class="modal-head">
        <div class="modal-title">{{ title }}</div>
        <button class="btn btn-ghost btn-sm" @click="emit('close')">✕</button>
      </div>
      <slot />
    </div>
  </div>
</template>
