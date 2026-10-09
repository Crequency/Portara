<script setup lang="ts">
/** 自定义复选框（不使用原生 <input type="checkbox"> 的外观） */
defineProps<{
  modelValue: boolean
  label?: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [boolean] }>()
</script>

<template>
  <button
    type="button"
    class="pcheck"
    role="checkbox"
    :aria-checked="modelValue"
    :disabled="disabled"
    :class="{ 'pcheck-on': modelValue }"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span class="pcheck-box" aria-hidden="true">
      <svg v-if="modelValue" width="11" height="11" viewBox="0 0 12 12">
        <path
          d="M2 6.4 4.6 9 10 3.4"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </span>
    <span v-if="label" class="pcheck-label">{{ label }}</span>
    <slot />
  </button>
</template>
