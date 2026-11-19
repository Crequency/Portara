<script setup lang="ts">
/**
 * 页面右侧的快速导航（hover 展开）。
 *
 * 为什么需要：渠道详情页有 8 个区块，滚到中段后想回顶部或直达某块只能手动滚。
 *
 * 三个实现细节：
 *   1. **高亮用 IntersectionObserver**，不是滚动位置算术 —— 区块高度不一致时，
 *      「滚动距离 / 总高度」这类近似算出来的当前区块经常对不上。
 *   2. **点击不写 URL hash** —— 写 hash 会污染浏览历史，用户按后退会变成
 *      「回到上一个锚点」而不是上一页。
 *   3. **尊重 prefers-reduced-motion** —— 开了减少动效就瞬时跳，不做平滑滚动。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

export interface JumpSection {
  /** 目标元素的 id */
  id: string
  /** 显示文案（调用方负责本地化） */
  label: string
}

const props = defineProps<{
  sections: JumpSection[]
  /** 面板标题（读屏用） */
  title: string
}>()

/** 当前所处区块的 id；空串表示还没进入任何区块 */
const activeId = ref('')

function jump(id: string): void {
  const el = document.getElementById(id)
  if (!el) return
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
}

/**
 * 高亮跟随。
 *
 * 不用 IntersectionObserver：本项目的滚动发生在 .content 这个内部容器里（不是窗口），
 * 而区块卡片又特别高 —— observer 的 rootMargin 很难同时适配「卡片比视口高」与
 * 「滚动容器不是 window」两种情况，实测会出现整屏滚动却始终不高亮。
 *
 * 改为监听滚动容器的 scroll，直接算「已越过顶部的最后一个区块」：
 * 判据简单、与容器是谁无关，滚动时也不会有延迟感。
 */
const SCROLL_ROOT_SELECTOR = '.content'
/** 顶部留白：标题被顶栏压住时仍算「已进入该区块」 */
const ACTIVE_OFFSET = 120

let scrollRoot: HTMLElement | null = null
let onScroll: (() => void) | null = null

function recomputeActive(): void {
  if (!scrollRoot) return
  const rootTop = scrollRoot.getBoundingClientRect().top
  let currentId = props.sections[0]?.id ?? ''
  for (const s of props.sections) {
    const el = document.getElementById(s.id)
    if (!el) continue
    // 元素顶部相对滚动容器顶部的距离
    const offset = el.getBoundingClientRect().top - rootTop
    if (offset <= ACTIVE_OFFSET) currentId = s.id
    else break
  }
  activeId.value = currentId
}

onMounted(() => {
  scrollRoot = (document.querySelector(SCROLL_ROOT_SELECTOR) as HTMLElement | null) ?? null
  onScroll = () => recomputeActive()
  // 滚动容器可能比组件晚就绪：窗口也挂一份，重复计算是幂等的
  scrollRoot?.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll, { passive: true })
  recomputeActive()
})

onBeforeUnmount(() => {
  if (onScroll) {
    scrollRoot?.removeEventListener('scroll', onScroll)
    window.removeEventListener('scroll', onScroll)
    window.removeEventListener('resize', onScroll)
  }
  onScroll = null
  scrollRoot = null
})
</script>

<template>
  <nav class="page-jump" :aria-label="title">
    <!-- 收起态：一条窄标签；hover / 键盘聚焦时展开列表 -->
    <div class="page-jump-body">
      <div class="page-jump-rail" aria-hidden="true">
        <span
          v-for="s in sections"
          :key="'dot-' + s.id"
          class="page-jump-dot"
          :class="{ 'is-active': s.id === activeId }"
        />
      </div>
      <div class="page-jump-tip">{{ title }}</div>
      <ul class="page-jump-list">
        <li v-for="s in sections" :key="s.id">
          <button
            type="button"
            class="page-jump-item"
            :class="{ 'is-active': s.id === activeId }"
            @click="jump(s.id)"
          >
            {{ s.label }}
          </button>
        </li>
      </ul>
    </div>
  </nav>
</template>
