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

let observer: IntersectionObserver | null = null

function jump(id: string): void {
  const el = document.getElementById(id)
  if (!el) return
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
}

onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver(
    (entries) => {
      /*
       * 取「可见且最靠上」的那个作为当前区块。
       * rootMargin 的上边留 15% 是给固定顶栏让位；下边收 70% 让判定集中在视口上部 ——
       * 否则一屏里同时可见两个区块时，高亮会在两块之间来回跳。
       */
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      const first = visible[0]
      if (first) activeId.value = first.target.id
    },
    { rootMargin: '-15% 0px -70% 0px', threshold: 0 }
  )
  for (const s of props.sections) {
    const el = document.getElementById(s.id)
    if (el) observer.observe(el)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
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
