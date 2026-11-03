<script setup lang="ts">
/**
 * 使用频率热力图（二维矩阵）。
 *
 * 布局完全由响应里的 cols / rows 驱动，横向撑满卡片：
 *   - 一个 CSS Grid 同时承载「纵坐标标签列 + 矩阵格子」，
 *     所以纵坐标与行、横坐标与列天然对齐，不会随窗口缩放漂移；
 *   - 格子 aspect-ratio 1/1，列宽由 minmax(0, 1fr) 自适应；
 *   - 窄屏由外层 .heatmap-scroll 接管横向滚动（默认 ≥1280px 一屏放下）。
 *
 * 颜色按 requests 做 sqrt 映射到 5 档：真实流量总有一两个尖峰，
 * 线性映射会把其余格子全压成最淡的一档。0 值用 --bg-elev-2，
 * 最大值用 --accent，中间三档由这两个主题变量 color-mix 出来。
 *
 * 时间换算见 ../heatmap.ts（时区一律取响应里的 timezone）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { HeatmapCell, StatsHeatmap } from '../api'
import { formatNumber } from '../format'
import { useI18n } from '../i18n'
import {
  calendarCell,
  formatCalendarDay,
  formatGridCellTime,
  gridCellInstant,
  heatmapProfile,
  heatmapUnit,
  type HeatmapProfile
} from '../heatmap'

const props = defineProps<{ data: StatsHeatmap }>()

const { t, locale } = useI18n()

const profile = computed<HeatmapProfile>(() => heatmapProfile(props.data))
const isCalendar = computed(() => props.data.mode === 'calendar')
const cols = computed(() => Math.max(0, Math.floor(props.data.cols || 0)))
const rows = computed(() => Math.max(0, Math.floor(props.data.rows || 0)))

/** Intl 用的语言标签：星期名要跟着界面语言走 */
const intlLocale = computed(() => (locale.value === 'zh' ? 'zh-CN' : 'en-US'))

function cellAt(y: number, x: number): HeatmapCell {
  return props.data.cells?.[y]?.[x] ?? { requests: 0, tokens: 0, errors: 0 }
}

/** 色阶归一化基准：全矩阵峰值 */
const maxRequests = computed(() => {
  let max = 0
  for (let y = 0; y < rows.value; y++) {
    for (let x = 0; x < cols.value; x++) {
      const r = cellAt(y, x).requests
      if (r > max) max = r
    }
  }
  return max
})

/** 全是 0（或没有格子）时给一句说明，而不是画一墙灰块 */
const isEmpty = computed(() => cols.value === 0 || rows.value === 0 || maxRequests.value === 0)

/** requests → 0..4 档；sqrt 压缩尖峰，非零至少 1 档 */
function levelOf(requests: number): number {
  if (requests <= 0 || maxRequests.value <= 0) return 0
  const ratio = Math.sqrt(requests / maxRequests.value)
  return Math.min(4, Math.max(1, Math.ceil(ratio * 4)))
}

interface CellView {
  y: number
  x: number
  requests: number
  tokens: number
  errors: number
  level: number
  /** 年历首尾补白：不在统计范围内，不参与悬浮 */
  blank: boolean
}

const flatCells = computed<CellView[]>(() => {
  const out: CellView[] = []
  for (let y = 0; y < rows.value; y++) {
    for (let x = 0; x < cols.value; x++) {
      const cell = cellAt(y, x)
      const blank = isCalendar.value ? calendarCell(props.data, y, x).day === null : false
      out.push({
        y,
        x,
        requests: cell.requests,
        tokens: cell.tokens,
        errors: cell.errors,
        level: levelOf(cell.requests),
        blank
      })
    }
  }
  return out
})

/**
 * 格子在**一维桶序列**里的序号。
 *
 * 后端 foldHeatmapBucket 是「列优先」：一列里装连续 rows 个小桶，
 * 所以 idx = 列 × 行数 + 行 —— 不是 row × cols + col。
 * 用 row-major 反推的话浮层时间会整体错位（xLabels 也会对不上）。
 */
function cellIndex(y: number, x: number): number {
  return x * rows.value + y
}

/** 单元格对应的具体时间文本（浮层标题 / title / aria-label 共用） */
function cellTime(view: CellView): string {
  if (isCalendar.value) {
    const { day } = calendarCell(props.data, view.y, view.x)
    return day === null ? '' : formatCalendarDay(day, intlLocale.value)
  }
  return formatGridCellTime(
    props.data,
    profile.value,
    gridCellInstant(props.data, profile.value, cellIndex(view.y, view.x))
  )
}

/** 无障碍描述 / 原生 tooltip 兜底（视觉浮层另有一套） */
function cellLabel(view: CellView): string {
  let text =
    cellTime(view) +
    ' · ' +
    formatNumber(view.requests) +
    ' ' +
    t('overview.legendRequests') +
    ' · ' +
    formatNumber(view.tokens) +
    ' ' +
    t('overview.legendTokens')
  if (view.errors > 0) {
    text += ' · ' + formatNumber(view.errors) + ' ' + t('overview.failed')
  }
  return text
}

/** 每格时长提示：今日 = 每格 1 分钟，年历 = 每格 1 天… */
const unitText = computed(() => {
  const unit = heatmapUnit(profile.value)
  const key =
    unit.kind === 'minute'
      ? 'overview.heatmapUnitMinute'
      : unit.kind === 'hour'
        ? 'overview.heatmapUnitHour'
        : 'overview.heatmapUnitDay'
  return t('overview.heatmapCellUnit', { n: unit.n, unit: t(key) })
})

const hintText = computed(() =>
  isCalendar.value ? t('overview.heatmapCalendarHint') : t('overview.heatmapHint')
)

// ---------------------------------------------------------------- 网格模板

const hasXLabels = computed(() => (props.data.xLabels ?? []).some((l) => l !== ''))

/** 1 = 年历没有月份行时矩阵从第 1 行开始；2 = 年历有月份行 */
const rowOffset = computed(() => (isCalendar.value ? 2 : 1))

const gridStyle = computed(() => {
  const trackRows = [
    ...(isCalendar.value ? ['16px'] : []),
    `repeat(${rows.value}, auto)`,
    ...(hasXLabels.value ? ['16px'] : [])
  ]
  return {
    '--hm-cols': String(cols.value),
    gridTemplateColumns: 'max-content 3px repeat(' + cols.value + ', minmax(0, 1fr))',
    gridTemplateRows: trackRows.join(' '),
    // 窄屏兜底：格子最窄留 4px，再窄就横向滚动而不是压成看不见
    minWidth: cols.value * 4 + Math.max(0, cols.value - 1) * 2 + 44 + 'px'
  }
})

const yLabelItems = computed(() => {
  const labels = props.data.yLabels ?? []
  return labels
    .map((label, y) => ({ label, y }))
    .filter((item) => {
      if (!item.label) return false
      // 年历只标 Mon / Wed / Fri（GitHub 的做法）：7 行挤在一起时更好读
      if (isCalendar.value) return item.y === 0 || item.y === 2 || item.y === 4
      return true
    })
})

/** 紧挨右边界时右对齐，避免标签文字越出容器产生横向滚动 */
function xLabelAlign(x: number): string {
  if (x === 0) return 'start'
  return x >= cols.value - 3 ? 'end' : 'center'
}

const xLabelItems = computed(() =>
  (props.data.xLabels ?? [])
    .map((label, x) => ({ label, x }))
    .filter((item) => item.label !== '')
)

/*
 * 横坐标文字比列宽得多（30d 一列一个 MM-DD），密排必然叠字。
 * 这里按「实测列宽 + 实测文字宽度」做贪心抽稀：只隐藏会与左邻叠字的那个，
 * 既保证字号 10.5px 不被裁切，也保证任何视口下都不互相压住。
 * 宽度只在挂载 / 换档位时量一次（字号固定，与视口无关）。
 */
const xlabelsEl = ref<HTMLElement | null>(null)
const xlabelsWidth = ref(0)
const xLabelWidths = reactive<Record<number, number>>({})
const xLabelEls = new Map<number, HTMLElement>()

function registerXLabel(x: number, el: unknown): void {
  if (el instanceof HTMLElement) xLabelEls.set(x, el)
  else xLabelEls.delete(x)
}

function measureXLabels(): void {
  for (const item of xLabelItems.value) {
    const el = xLabelEls.get(item.x)
    // 被抽稀的标签是 display:none，量不到宽度 —— 保留上一次的值即可
    const width = el?.getBoundingClientRect().width ?? 0
    if (width > 0) xLabelWidths[item.x] = width
  }
}

const hiddenXLabels = computed<Set<number>>(() => {
  const total = xlabelsWidth.value
  const count = cols.value
  if (total <= 0 || count <= 0) return new Set()
  const gap = 2
  const pitch = (total + gap) / count
  const hidden = new Set<number>()
  let prevRight = Number.NEGATIVE_INFINITY
  for (const item of xLabelItems.value) {
    const width = xLabelWidths[item.x] ?? 0
    if (width <= 0) continue
    const start = item.x * pitch
    const end = start + pitch - gap
    let left: number
    let right: number
    if (item.x === 0) {
      left = start
      right = start + width
    } else if (item.x >= count - 3) {
      right = end
      left = end - width
    } else {
      const center = (start + end) / 2
      left = center - width / 2
      right = center + width / 2
    }
    if (left < prevRight + 4) {
      hidden.add(item.x)
      continue
    }
    prevRight = right
  }
  return hidden
})

let xLabelsObserver: ResizeObserver | null = null

function observeXLabels(el: HTMLElement | null): void {
  xLabelsObserver?.disconnect()
  xLabelsObserver = null
  if (!el) {
    xlabelsWidth.value = 0
    return
  }
  xlabelsWidth.value = el.clientWidth
  xLabelsObserver = new ResizeObserver(() => {
    xlabelsWidth.value = el.clientWidth
  })
  xLabelsObserver.observe(el)
}

watch(xlabelsEl, (el) => observeXLabels(el), { immediate: true })
watch(
  () => xLabelItems.value,
  () => {
    void nextTick(() => {
      measureXLabels()
    })
  },
  { deep: false }
)

onMounted(() => {
  void nextTick(() => measureXLabels())
})

onBeforeUnmount(() => xLabelsObserver?.disconnect())

/** 月份标签：相邻太近会叠字，隔不到 2 列就跳过后者（正常数据不会被删光） */
const monthItems = computed(() => {
  if (!isCalendar.value) return []
  const list = [...(props.data.monthLabels ?? [])].sort((a, b) => a.col - b.col)
  const kept: { col: number; label: string }[] = []
  let lastCol = Number.NEGATIVE_INFINITY
  for (const item of list) {
    if (item.col < 0 || item.col >= cols.value) continue
    if (item.col - lastCol < 2) continue
    kept.push(item)
    lastCol = item.col
  }
  return kept
})

// ---------------------------------------------------------------- 悬浮浮层

interface HoverState {
  y: number
  x: number
  px: number
  py: number
}

const hovered = ref<HoverState | null>(null)

/** 事件委托：1500 个格子不各挂一份监听 */
function viewFromEvent(event: Event): CellView | null {
  const target = event.target as HTMLElement | null
  const el = target?.closest?.('.hm-cell') as HTMLElement | null
  if (!el || el.dataset.y === undefined || el.dataset.x === undefined) return null
  const y = Number(el.dataset.y)
  const x = Number(el.dataset.x)
  if (!Number.isFinite(y) || !Number.isFinite(x)) return null
  return flatCells.value[y * cols.value + x] ?? null
}

function onPointerOver(event: MouseEvent): void {
  const view = viewFromEvent(event)
  if (!view || view.blank) {
    hovered.value = null
    return
  }
  hovered.value = { y: view.y, x: view.x, px: event.clientX, py: event.clientY }
}

function onPointerMove(event: MouseEvent): void {
  if (!hovered.value) return
  hovered.value.px = event.clientX
  hovered.value.py = event.clientY
}

/** 键盘聚焦时也用同一套浮层：位置取格子中心 */
function onFocusIn(event: FocusEvent): void {
  const view = viewFromEvent(event)
  if (!view || view.blank) return
  const el = event.target as HTMLElement | null
  const rect = el?.getBoundingClientRect()
  hovered.value = {
    y: view.y,
    x: view.x,
    px: rect ? rect.left + rect.width / 2 : 0,
    py: rect ? rect.top + rect.height / 2 : 0
  }
}

const hoveredView = computed<CellView | null>(() => {
  const h = hovered.value
  if (!h) return null
  return flatCells.value[h.y * cols.value + h.x] ?? null
})

/** 预留浮层尺寸：用于判断往左翻还是往右放 */
const TIP_WIDTH = 240
const TIP_HEIGHT = 96

const tipStyle = computed(() => {
  const h = hovered.value
  if (!h) return {}
  const fitsRight = h.px + 14 + TIP_WIDTH <= window.innerWidth - 8
  const left = fitsRight ? h.px + 14 : Math.max(8, h.px - TIP_WIDTH - 14)
  const above = h.py - 12 - TIP_HEIGHT >= 8
  const top = above ? h.py - 12 : Math.min(window.innerHeight - TIP_HEIGHT - 8, h.py + 18)
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
        class="hm-chart"
        :style="gridStyle"
        role="list"
        :aria-label="t('overview.trendViewHeatmap')"
        @mouseover="onPointerOver"
        @mousemove="onPointerMove"
        @mouseleave="hovered = null"
        @focusin="onFocusIn"
        @focusout="hovered = null"
      >
        <!-- 年历顶部的月份标签：与矩阵同列，只在月份切换处出现 -->
        <div
          v-if="isCalendar"
          class="hm-months"
          aria-hidden="true"
          :style="{ gridColumn: '3 / -1', gridRow: '1' }"
        >
          <span
            v-for="item in monthItems"
            :key="'m' + item.col"
            class="hm-month"
            :style="{ gridColumn: String(item.col + 1) }"
          >{{ item.label }}</span>
        </div>

        <!-- 左侧纵坐标：与格子共用行轨道，天然对齐 -->
        <span
          v-for="item in yLabelItems"
          :key="'y' + item.y"
          class="hm-ylabel"
          aria-hidden="true"
          :style="{ gridColumn: '1', gridRow: String(item.y + rowOffset) }"
        >{{ item.label }}</span>

        <!-- 矩阵：cells[row][col] 直接按行列落位 -->
        <div
          v-for="view in flatCells"
          :key="view.y * cols + view.x"
          v-memo="[view, locale]"
          class="hm-cell"
          :class="['lvl-' + view.level, { 'is-blank': view.blank }]"
          :style="{ gridColumn: String(view.x + 3), gridRow: String(view.y + rowOffset) }"
          role="listitem"
          :data-y="view.blank ? undefined : view.y"
          :data-x="view.blank ? undefined : view.x"
          :tabindex="view.blank ? undefined : view.requests > 0 ? 0 : -1"
          :title="view.blank ? undefined : cellLabel(view)"
          :aria-label="view.blank ? undefined : cellLabel(view)"
        />

        <!-- 底部横坐标：同一套列模板，标签不会跑偏 -->
        <div
          v-if="hasXLabels"
          ref="xlabelsEl"
          class="hm-xlabels"
          aria-hidden="true"
          :style="{ gridColumn: '3 / -1', gridRow: String(rowOffset + rows) }"
        >
          <span
            v-for="item in xLabelItems"
            :key="'x' + item.x"
            :ref="(el) => registerXLabel(item.x, el)"
            v-show="!hiddenXLabels.has(item.x)"
            class="hm-xlabel"
            :style="{
              gridColumn: String(item.x + 1),
              justifySelf: xLabelAlign(item.x)
            }"
          >{{ item.label }}</span>
        </div>
      </div>
    </div>

    <div class="heatmap-foot">
      <span class="dim heatmap-hint">{{ hintText }}</span>
      <span class="dim">·</span>
      <span class="dim heatmap-hint">{{ unitText }}</span>
      <span class="spacer" />
      <span class="heatmap-legend">
        <span>{{ t('overview.heatmapLess') }}</span>
        <i v-for="l in 5" :key="l" class="heatmap-swatch" :class="'lvl-' + (l - 1)" />
        <span>{{ t('overview.heatmapMore') }}</span>
      </span>
    </div>

    <!-- 悬浮详情：固定定位，不受卡片 / 滚动容器裁剪 -->
    <div v-if="hovered && hoveredView" class="chart-tip heatmap-tip" :style="tipStyle">
      <div class="chart-tip-day">{{ cellTime(hoveredView) }}</div>
      <div class="chart-tip-row">
        <i class="legend-dot legend-dot-req" />{{ t('overview.legendRequests') }}
        <span class="spacer" />{{ formatNumber(hoveredView.requests) }}
      </div>
      <div class="chart-tip-row">
        <i class="legend-dot legend-dot-tok" />{{ t('overview.legendTokens') }}
        <span class="spacer" />{{ formatNumber(hoveredView.tokens) }}
      </div>
      <div v-if="hoveredView.errors > 0" class="chart-tip-row chart-tip-err">
        <i class="legend-dot legend-dot-err" />{{ t('overview.failed') }}
        <span class="spacer" />{{ formatNumber(hoveredView.errors) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.heatmap {
  --hm-gap: 2px;
  --hm-radius: 2px;
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

/*
 * 一个网格同时管「纵坐标列 / 过渡列 / 矩阵列」和「月份行 / 矩阵行 / 横坐标行」：
 * 行列对齐靠轨道本身保证，不靠两套模板凑。
 */
.hm-chart {
  display: grid;
  width: 100%;
  column-gap: var(--hm-gap);
  row-gap: var(--hm-gap);
  align-items: stretch;
}

.hm-cell {
  aspect-ratio: 1 / 1;
  min-width: 0;
  border-radius: var(--hm-radius);
  background: var(--bg-elev-2);
  cursor: default;
  transition: box-shadow 0.12s ease;
}

.hm-cell:not(.is-blank):hover {
  box-shadow: 0 0 0 1.5px var(--text);
}

.hm-cell:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.hm-cell.is-blank {
  background: transparent;
  pointer-events: none;
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

/* 标签：字号 10–11px、永不换行、不裁切（父级不设 overflow: hidden） */
/*
 * 高度压成 0：标签文字（10.5px）比格子（窄屏时只有 7–8px）高，
 * 若让它参与行高，含标签的行会被撑高、cells 的 aspect-ratio 跟着变形，
 * 矩阵就歪了。height: 0 让它只「画在行中线上」，不影响轨道尺寸。
 */
.hm-ylabel {
  align-self: center;
  height: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 2px;
  font-size: 10.5px;
  line-height: 1.1;
  color: var(--text-faint);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.hm-months,
.hm-xlabels {
  display: grid;
  grid-template-columns: repeat(var(--hm-cols), minmax(0, 1fr));
  column-gap: var(--hm-gap);
  align-items: center;
  font-size: 10.5px;
  line-height: 1.1;
  color: var(--text-faint);
  min-width: 0;
}

.hm-month,
.hm-xlabel {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.hm-month {
  justify-self: start;
}

.hm-xlabel {
  justify-self: center;
}

.heatmap-foot {
  display: flex;
  align-items: center;
  gap: 6px;
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