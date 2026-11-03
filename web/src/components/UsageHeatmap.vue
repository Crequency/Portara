<script setup lang="ts">
/**
 * 使用频率热力图（GitHub 砖墙风格）。
 *
 * 布局由**粒度**决定，而不是由桶数决定：
 *   - hour：每行 24 个 —— today 一行 24，7d 七行 168，正好一天一行；
 *   - day：每行 30 个 —— 30d 一行、90d 三行、365d 十三行。
 *
 * 颜色按 requests 映射到 5 档。用 sqrt 而不是线性：真实流量里总有一两个
 * 尖峰，线性映射会把其余方块全压成最淡的一档，看不出日常分布。
 * 0 值单独用最淡的底色（--bg-elev-2），最大值用 --accent；
 * 中间三档全部用 color-mix 从这两个主题变量混出来，深浅主题都不需要另配颜色。
 */
import { computed, ref } from 'vue'
import type { HeatmapBucket } from '../api'
import { formatNumber } from '../format'
import { useI18n } from '../i18n'

const props = defineProps<{
  buckets: HeatmapBucket[]
  granularity: 'hour' | 'day'
}>()

const { t } = useI18n()

/** hour 一天 24 格；day 每行 30 格（30d 正好一行） */
const columns = computed(() => (props.granularity === 'hour' ? 24 : 30))

/** 色阶归一化基准：峰值 */
const maxRequests = computed(() =>
  props.buckets.reduce((max, b) => (b.requests > max ? b.requests : max), 0)
)

/** 全是 0（或没有桶）时给一句说明，而不是画一墙灰块 */
const isEmpty = computed(() => props.buckets.length === 0 || maxRequests.value === 0)

/**
 * requests → 0..4 档。
 *
 * sqrt 压缩尖峰；非零值至少落到 1 档，最大值（sqrt(1)）落到 4 档。
 */
function level(requests: number): number {
  if (requests <= 0 || maxRequests.value <= 0) return 0
  const ratio = Math.sqrt(requests / maxRequests.value)
  return Math.min(4, Math.max(1, Math.ceil(ratio * 4)))
}

/** 无障碍描述 / 原生 tooltip 兜底（视觉浮层另有一套） */
function cellLabel(b: HeatmapBucket): string {
  return (
    b.label +
    ' · ' +
    formatNumber(b.requests) +
    ' ' +
    t('overview.legendRequests') +
    ' · ' +
    formatNumber(b.tokens) +
    ' ' +
    t('overview.legendTokens')
  )
}

// ---------------------------------------------------------------- 悬浮浮层

const hovered = ref<{ bucket: HeatmapBucket; x: number; y: number } | null>(null)

function enterCell(b: HeatmapBucket, e: MouseEvent): void {
  hovered.value = { bucket: b, x: e.clientX, y: e.clientY }
}

function moveTip(e: MouseEvent): void {
  if (!hovered.value) return
  hovered.value.x = e.clientX
  hovered.value.y = e.clientY
}

/** 键盘聚焦时也用同一套浮层：位置取方块中心 */
function focusCell(b: HeatmapBucket, e: FocusEvent): void {
  const el = e.currentTarget as HTMLElement | null
  if (!el) return
  const rect = el.getBoundingClientRect()
  hovered.value = {
    bucket: b,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  }
}

/** 预留浮层尺寸：用于判断往左翻还是往右放 */
const TIP_WIDTH = 220
const TIP_HEIGHT = 78

/**
 * 浮层位置：跟随光标，且不越出视口。
 *
 * 默认放在光标**左上方**（transform: translateY(-100%)）；
 * 上方放不下时翻到下方，右侧放不下时翻到左侧。
 */
const tipStyle = computed(() => {
  const h = hovered.value
  if (!h) return {}
  const fitsRight = h.x + 14 + TIP_WIDTH <= window.innerWidth - 8
  const left = fitsRight ? h.x + 14 : Math.max(8, h.x - TIP_WIDTH - 14)
  const above = h.y - 12 - TIP_HEIGHT >= 8
  const top = above
    ? h.y - 12
    : Math.min(window.innerHeight - TIP_HEIGHT - 8, h.y + 18)
  return {
    left: left + 'px',
    top: Math.max(8, top) + 'px',
    transform: above ? 'translateY(-100%)' : 'none'
  }
})
</script>

<template>
  <div v-if="isEmpty" class="empty">{{ t('overview.heatmapEmpty') }}</div>

  <div v-else class="heatmap">
    <!-- 窄屏横向滚动，不把卡片撑破 -->
    <div class="heatmap-scroll">
      <div
        class="heatmap-grid"
        role="list"
        :aria-label="t('overview.trendViewHeatmap')"
        :style="{ gridTemplateColumns: 'repeat(' + columns + ', var(--heatmap-cell))' }"
      >
        <div
          v-for="(b, i) in buckets"
          :key="i"
          class="heatmap-cell"
          :class="['lvl-' + level(b.requests), { 'is-hover': hovered?.bucket === b }]"
          role="listitem"
          tabindex="0"
          :title="cellLabel(b)"
          :aria-label="cellLabel(b)"
          @mouseenter="enterCell(b, $event)"
          @mousemove="moveTip"
          @mouseleave="hovered = null"
          @focus="focusCell(b, $event)"
          @blur="hovered = null"
        />
      </div>
    </div>

    <div class="heatmap-foot">
      <span class="dim heatmap-hint">{{ t('overview.heatmapHint') }}</span>
      <span class="spacer" />
      <span class="heatmap-legend">
        <span>{{ t('overview.heatmapLess') }}</span>
        <i v-for="l in 5" :key="l" class="heatmap-swatch" :class="'lvl-' + (l - 1)" />
        <span>{{ t('overview.heatmapMore') }}</span>
      </span>
    </div>

    <!-- 悬浮详情：用固定定位，不受卡片 / 滚动容器裁剪 -->
    <div v-if="hovered" class="chart-tip heatmap-tip" :style="tipStyle">
      <div class="chart-tip-day">{{ hovered.bucket.label }}</div>
      <div class="chart-tip-row">
        <i class="legend-dot legend-dot-req" />{{ t('overview.legendRequests') }}
        <span class="spacer" />{{ formatNumber(hovered.bucket.requests) }}
      </div>
      <div class="chart-tip-row">
        <i class="legend-dot legend-dot-tok" />{{ t('overview.legendTokens') }}
        <span class="spacer" />{{ formatNumber(hovered.bucket.tokens) }}
      </div>
      <div v-if="hovered.bucket.errors > 0" class="chart-tip-row chart-tip-err">
        <i class="legend-dot legend-dot-err" />{{ t('overview.failed') }}
        <span class="spacer" />{{ formatNumber(hovered.bucket.errors) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 尺寸全部走变量，微调只改这里。
 * 24 格 × 14 + 23 × 3 = 405px；30 格 × 14 + 29 × 3 = 507px —— 宽屏都放得下，
 * 窄屏由 .heatmap-scroll 接管横向滚动。
 */
.heatmap {
  --heatmap-cell: 14px;
  --heatmap-gap: 3px;
  --heatmap-radius: 3px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.heatmap-scroll {
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 2px;
}

.heatmap-grid {
  display: grid;
  gap: var(--heatmap-gap);
  width: max-content;
  align-content: start;
  justify-content: start;
}

.heatmap-cell {
  width: var(--heatmap-cell);
  height: var(--heatmap-cell);
  border-radius: var(--heatmap-radius);
  background: var(--bg-elev-2);
  cursor: default;
  transition: box-shadow 0.12s ease, filter 0.12s ease;
}

.heatmap-cell.is-hover {
  box-shadow: 0 0 0 1.5px var(--text);
}

.heatmap-cell:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/*
 * 5 档色阶：0 档直接用卡片内底色；4 档直接用强调色；
 * 中间三档由这两个主题变量混合 —— 换主题时不用再维护一套色板。
 */
.lvl-0 { background: var(--bg-elev-2); }
.lvl-1 { background: color-mix(in srgb, var(--accent) 20%, var(--bg-elev-2)); }
.lvl-2 { background: color-mix(in srgb, var(--accent) 42%, var(--bg-elev-2)); }
.lvl-3 { background: color-mix(in srgb, var(--accent) 68%, var(--bg-elev-2)); }
.lvl-4 { background: var(--accent); }

.heatmap-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--text-faint);
}

.heatmap-hint { white-space: nowrap; }

.heatmap-legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.heatmap-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
}
</style>
