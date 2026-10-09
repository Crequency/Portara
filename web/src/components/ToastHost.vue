<script setup lang="ts">
import type { Toast } from '../toast'
import { toasts } from '../toast'
</script>

<template>
  <div class="toast-host">
    <div
      v-for="t in (toasts as Toast[])"
      :key="t.id"
      class="toast"
      :class="`toast-${t.kind}`"
    >
      {{ t.message }}
    </div>
  </div>
</template>
