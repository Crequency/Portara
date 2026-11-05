<script setup lang="ts">
/**
 * 顶栏用户入口：一个圆形用户图标 + 悬浮卡片。
 *
 * 为什么不用 PSelect：这里展示的是「资料 + 动作」，不是「在一组值里选一个」，
 * 套用 listbox 的 ARIA 语义反而不对。但弹层的交互约定保持一致：
 * 点外面 / Esc / 滚动 / 路由切换都关闭，触发按钮同步 aria-expanded。
 *
 * 移动端只靠点击 —— 没有依赖 :hover，触屏同样可开。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { User } from '../api'
import { useI18n } from '../i18n'

const props = defineProps<{ user: User }>()
const emit = defineEmits<{ logout: [] }>()

const { t } = useI18n()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const triggerEl = ref<HTMLButtonElement | null>(null)
const cardEl = ref<HTMLElement | null>(null)

const displayName = computed(() => props.user.displayName || props.user.username)
/** 头像圆点里放显示名首字母；中文取第一个字，英文取首字母大写 */
const initial = computed(() => Array.from(displayName.value.trim())[0]?.toUpperCase() ?? '?')
const roleLabel = computed(() =>
  props.user.role === 'admin' ? t('nav.admin') : t('nav.operator')
)
const accountLabel = computed(() => t('nav.account'))

function close(): void {
  open.value = false
}

function toggle(): void {
  open.value = !open.value
  if (open.value) {
    void nextTick(() => {
      // 卡片本身不抢焦点；放开后 Tab 能顺着进入卡片里的退出按钮
      cardEl.value?.focus({ preventScroll: true })
    })
  }
}

function onDocPointerDown(e: MouseEvent): void {
  if (!open.value) return
  const target = e.target as Node
  if (rootEl.value?.contains(target)) return
  close()
}

function onKeydown(e: KeyboardEvent): void {
  if (!open.value || e.key !== 'Escape') return
  e.preventDefault()
  close()
  triggerEl.value?.focus({ preventScroll: true })
}

/** 滚动（含内容区内部滚动）与路由切换时收起，避免卡片悬在空白处 */
function onScroll(): void {
  if (open.value) close()
}

function onHashChange(): void {
  if (open.value) close()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocPointerDown)
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('hashchange', onHashChange)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocPointerDown)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('hashchange', onHashChange)
})

function onLogout(): void {
  close()
  emit('logout')
}
</script>

<template>
  <div ref="rootEl" class="user-menu">
    <button
      ref="triggerEl"
      type="button"
      class="icon-btn"
      :class="{ 'icon-btn-on': open }"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-label="accountLabel"
      :title="accountLabel"
      @click="toggle"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21c0-3.3 3.6-5 8-5s8 1.7 8 5"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <div
      v-if="open"
      ref="cardEl"
      class="user-card"
      role="menu"
      tabindex="-1"
      :aria-label="accountLabel"
    >
      <div class="user-card-head">
        <span class="user-avatar" aria-hidden="true">{{ initial }}</span>
        <div class="user-card-id">
          <div class="user-card-name">{{ displayName }}</div>
          <div class="user-card-handle">@{{ user.username }}</div>
        </div>
      </div>

      <div class="user-card-role">
        <span class="badge" :class="user.role === 'admin' ? 'badge-info' : 'badge-off'">
          {{ roleLabel }}
        </span>
      </div>

      <div class="user-card-divider" />

      <button type="button" class="user-card-logout" role="menuitem" @click="onLogout">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span>{{ t('nav.logout') }}</span>
      </button>
    </div>
  </div>
</template>
