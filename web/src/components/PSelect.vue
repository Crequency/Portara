<script setup lang="ts">
/**
 * 完全自定义的下拉选择器（不使用原生 <select>）。
 *
 * - 弹出层 Teleport 到 body，避免被卡片 overflow 裁切
 * - 自动避让视口边缘；滚动/缩放时跟随
 * - 键盘：↑ ↓ Home End Enter Esc Tab
 * - ARIA：combobox + listbox + option
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

export interface SelectOption {
  value: string
  label: string
  hint?: string
  disabled?: boolean
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: SelectOption[]
    placeholder?: string
    size?: 'sm' | 'md'
    disabled?: boolean
    align?: 'start' | 'end'
    /**
     * 触发按钮上显示的文案（可选）。缺省用选中项的 label。
     * 用于「选项写全称、按钮写短标签」的场景（如 简体中文 → 中文 / English → EN）。
     */
    triggerLabel?: string
  }>(),
  { placeholder: '', size: 'md', disabled: false, align: 'start', triggerLabel: '' }
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const open = ref(false)
const activeIndex = ref(-1)
const triggerEl = ref<HTMLButtonElement | null>(null)
const popupEl = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0, width: 0, maxHeight: 280 })

const selected = computed(
  () => props.options.find((o) => o.value === props.modelValue) ?? null
)
const label = computed(
  () => props.triggerLabel || selected.value?.label || props.placeholder
)

const ITEM_H = 38

function place(): void {
  const el = triggerEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const width = Math.max(r.width, 168)

  let left = props.align === 'end' ? r.right - width : r.left
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8))

  const wanted = Math.min(props.options.length * ITEM_H + 12, 300)
  const below = window.innerHeight - r.bottom - 10
  const above = r.top - 10
  let top = r.bottom + 6
  let maxHeight = Math.min(wanted, Math.max(below, 120))
  if (below < wanted && above > below) {
    maxHeight = Math.min(wanted, Math.max(above, 120))
    top = r.top - maxHeight - 6
  }

  pos.value = { left, top, width, maxHeight }
}

function onDocPointerDown(e: MouseEvent): void {
  const target = e.target as Node
  if (triggerEl.value?.contains(target)) return
  if (popupEl.value?.contains(target)) return
  close()
}

function onKeyNav(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (open.value) {
      e.preventDefault()
      close()
    }
    return
  }

  if (!open.value) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault()
      openMenu()
    }
    return
  }

  const usable = props.options.map((o, i) => ({ o, i })).filter((x) => !x.o.disabled)
  if (usable.length === 0) return
  const current = usable.findIndex((x) => x.i === activeIndex.value)

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      activeIndex.value = usable[(current + 1 + usable.length) % usable.length]!.i
      break
    case 'ArrowUp':
      e.preventDefault()
      activeIndex.value = usable[(current - 1 + usable.length) % usable.length]!.i
      break
    case 'Home':
      e.preventDefault()
      activeIndex.value = usable[0]!.i
      break
    case 'End':
      e.preventDefault()
      activeIndex.value = usable[usable.length - 1]!.i
      break
    case 'Enter':
    case ' ':
      e.preventDefault()
      if (activeIndex.value >= 0) choose(props.options[activeIndex.value]!)
      break
    case 'Tab':
      close()
      break
  }
}

function choose(option: SelectOption): void {
  if (option.disabled) return
  emit('update:modelValue', option.value)
  close()
}

function openMenu(): void {
  if (props.disabled) return
  const idx = props.options.findIndex((o) => o.value === props.modelValue && !o.disabled)
  activeIndex.value = idx >= 0 ? idx : props.options.findIndex((o) => !o.disabled)
  place()
  open.value = true
  void nextTick(() => {
    place()
    document.addEventListener('mousedown', onDocPointerDown)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
  })
}

function close(): void {
  if (!open.value) return
  open.value = false
  document.removeEventListener('mousedown', onDocPointerDown)
  window.removeEventListener('scroll', place, true)
  window.removeEventListener('resize', place)
}

function toggle(): void {
  open.value ? close() : openMenu()
}

watch(
  () => props.disabled,
  (v) => {
    if (v) close()
  }
)

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocPointerDown)
  window.removeEventListener('scroll', place, true)
  window.removeEventListener('resize', place)
})
</script>

<template>
  <div class="psel" :class="[`psel-${size}`, { 'psel-open': open, 'psel-disabled': disabled }]">
    <button
      ref="triggerEl"
      type="button"
      class="psel-trigger"
      role="combobox"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :disabled="disabled"
      @click="toggle"
      @keydown="onKeyNav"
    >
      <!-- 可选前缀（图标等）：加法能力，不传时渲染结果与之前完全一致 -->
      <slot name="prefix" />
      <span class="psel-label" :class="{ 'psel-placeholder': !selected }">{{ label }}</span>
      <svg class="psel-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path
          d="M2.5 4.5 6 8l3.5-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="popupEl"
        class="psel-popup"
        role="listbox"
        :style="{
          left: `${pos.left}px`,
          top: `${pos.top}px`,
          width: `${pos.width}px`,
          maxHeight: `${pos.maxHeight}px`
        }"
      >
        <div
          v-for="(option, i) in options"
          :key="option.value"
          class="psel-option"
          role="option"
          :aria-selected="option.value === modelValue"
          :class="{
            'psel-option-active': i === activeIndex,
            'psel-option-selected': option.value === modelValue,
            'psel-option-disabled': option.disabled
          }"
          @mouseenter="!option.disabled && (activeIndex = i)"
          @click="choose(option)"
        >
          <span class="psel-option-label">{{ option.label }}</span>
          <span v-if="option.hint" class="psel-option-hint">{{ option.hint }}</span>
          <svg
            v-if="option.value === modelValue"
            class="psel-check"
            width="13"
            height="13"
            viewBox="0 0 12 12"
            aria-hidden="true"
          >
            <path
              d="M2 6.4 4.6 9 10 3.4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </div>
      </div>
    </Teleport>
  </div>
</template>
