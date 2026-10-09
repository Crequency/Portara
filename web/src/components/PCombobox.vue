<script setup lang="ts">
/**
 * 可输入的下拉框（combobox）。
 *
 * 与 PSelect 的区别：PSelect 只能从固定项里选，而它**允许手输任意值**
 * —— 模型名这种「列表可能不全、用户知道确切名字」的场景需要这个能力。
 *
 * 与原生 <datalist> 的区别（这正是做它的原因）：
 *   - 弹层自绘，与 PSelect 视觉完全一致
 *   - **列出全部选项**（原生 datalist 在 Chrome 下只给有限的几条建议）
 *   - 可测、可键盘操作、可控制滚动与避让
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: string[]
    placeholder?: string
    disabled?: boolean
    /** 每次最多渲染多少条，避免上千项时卡顿（超出提示继续输入以过滤） */
    maxRender?: number
  }>(),
  { placeholder: '', disabled: false, maxRender: 300 }
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const open = ref(false)
const typed = ref(false)
const activeIndex = ref(-1)
const triggerEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const popupEl = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0, width: 0, maxHeight: 300 })

const ITEM_H = 34

/** 打开后没输入过 → 列全部；输入过 → 按子串过滤 */
const visible = computed(() => {
  const all = props.options
  if (!typed.value) return all.slice(0, props.maxRender)
  const q = props.modelValue.trim().toLowerCase()
  if (!q) return all.slice(0, props.maxRender)
  return all.filter((o) => o.toLowerCase().includes(q)).slice(0, props.maxRender)
})

const truncated = computed(
  () => visible.value.length >= props.maxRender && props.options.length > props.maxRender
)

function place(): void {
  const el = triggerEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const width = Math.max(r.width, 200)
  let left = r.left
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8))

  const wanted = Math.min(visible.value.length * ITEM_H + 12, 320)
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
  const t = e.target as Node
  if (triggerEl.value?.contains(t)) return
  if (popupEl.value?.contains(t)) return
  close()
}

function openMenu(): void {
  if (props.disabled || open.value) return
  typed.value = false
  const idx = props.options.indexOf(props.modelValue)
  activeIndex.value = idx
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

function choose(value: string): void {
  emit('update:modelValue', value)
  close()
}

function onInput(e: Event): void {
  const value = (e.target as HTMLInputElement).value
  emit('update:modelValue', value)
  typed.value = true
  activeIndex.value = -1
  if (!open.value) openMenu()
  else void nextTick(place)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (open.value) {
      e.preventDefault()
      close()
    }
    return
  }

  if (!open.value) {
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault()
      openMenu()
    }
    return
  }

  const list = visible.value
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      activeIndex.value = list.length === 0 ? -1 : (activeIndex.value + 1) % list.length
      break
    case 'ArrowUp':
      e.preventDefault()
      activeIndex.value =
        list.length === 0 ? -1 : (activeIndex.value - 1 + list.length) % list.length
      break
    case 'Home':
      e.preventDefault()
      activeIndex.value = 0
      break
    case 'End':
      e.preventDefault()
      activeIndex.value = list.length - 1
      break
    case 'Enter':
      if (activeIndex.value >= 0 && list[activeIndex.value] !== undefined) {
        e.preventDefault()
        choose(list[activeIndex.value]!)
      } else {
        // 没选中项时保留手输值
        close()
      }
      break
    case 'Tab':
      close()
      break
  }
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
  <div class="psel pcombo" :class="{ 'psel-open': open, 'psel-disabled': disabled }">
    <div ref="triggerEl" class="psel-trigger pcombo-trigger">
      <input
        ref="inputEl"
        class="pcombo-input"
        type="text"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="open"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        @input="onInput"
        @focus="openMenu"
        @keydown="onKeydown"
      />
      <button
        type="button"
        class="pcombo-toggle"
        :disabled="disabled"
        :aria-label="open ? '收起' : '展开'"
        @click="open ? close() : (inputEl?.focus(), openMenu())"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
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
    </div>

    <Teleport to="body">
      <div
        v-if="open"
        ref="popupEl"
        class="psel-popup"
        role="listbox"
        :style="{
          left: pos.left + 'px',
          top: pos.top + 'px',
          width: pos.width + 'px',
          maxHeight: pos.maxHeight + 'px'
        }"
      >
        <div v-if="visible.length === 0" class="psel-option psel-option-disabled">
          {{ placeholder || '无匹配项' }}
        </div>
        <div
          v-for="(option, i) in visible"
          :key="option"
          class="psel-option"
          role="option"
          :aria-selected="option === modelValue"
          :class="{
            'psel-option-active': i === activeIndex,
            'psel-option-selected': option === modelValue
          }"
          @mouseenter="activeIndex = i"
          @mousedown.prevent="choose(option)"
        >
          <span class="psel-option-label">{{ option }}</span>
          <svg
            v-if="option === modelValue"
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
        <div v-if="truncated" class="psel-option psel-option-disabled">
          …还有更多，输入关键字以过滤
        </div>
      </div>
    </Teleport>
  </div>
</template>
