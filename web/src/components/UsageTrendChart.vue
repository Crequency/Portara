<script setup lang="ts">
/**
 * 用量趋势图（概览页与渠道详情页共用）。
 *
 * 两条序列量级差得远（请求数几千、Token 十几亿），共用一根轴会把请求量压成一条线，
 * 所以**各用一根轴、各按自身峰值缩放**，网格线共用。
 *
 * 抽成组件的原因：渠道详情页曾保留一套旧标记（每列自带数值与日期的纵向 flex），
 * 概览页重写图表后那套类名就失了效，于是详情页的图退化成一列竖排文字。
 * 两个地方画同一张图，就不可能两处都不出错 —— 只能有一个实现。
 */
import { computed, ref } from 'vue'
import type { SeriesPoint } from '../api'
import { formatCompact, formatNumber } from '../format'
import { useI18n } from '../i18n'

const props = defineProps<{ series: SeriesPoint[] }>()

const { t } = useI18n()

/** 网格分格数：左右两轴共用同一组横向网格线，各自标注自己的量纲 */
const GRID_DIVISIONS = 4

const maxRequests = computed(() => Math.max(1, ...props.series.map((p) => p.requests)))
const maxTokens = computed(() => Math.max(1, ...props.series.map((p) => p.tokens)))

/**
 * 轴上限。
 *
 * 这里**对「每格步长」取整而不是对峰值取整** ——
 * 后者会让格距变成 375M 这种没法读的刻度。取整后每格都是 400M、800 这类整数。
 */
function niceAxisMax(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return GRID_DIVISIONS
  const rawStep = peak / GRID_DIVISIONS
  const mag = 10 ** Math.floor(Math.log10(rawStep))
  const norm = rawStep / mag
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => norm <= s) ?? 10
  return step * mag * GRID_DIVISIONS
}

const reqAxisMax = computed(() => niceAxisMax(maxRequests.value))
const tokAxisMax = computed(() => niceAxisMax(maxTokens.value))

/** 刻度：从下往上，pct 是相对绘图区的高度百分比 */
function axisTicks(max: number, format: (v: number) => string): { pct: number; label: string }[] {
  return Array.from({ length: GRID_DIVISIONS + 1 }, (_, i) => ({
    pct: (i / GRID_DIVISIONS) * 100,
    label: format((max * i) / GRID_DIVISIONS)
  }))
}

const reqTicks = computed(() => axisTicks(reqAxisMax.value, (v) => formatNumber(Math.round(v))))
const tokTicks = computed(() => axisTicks(tokAxisMax.value, (v) => formatCompact(v)))
const gridLines = computed(() =>
  Array.from({ length: GRID_DIVISIONS + 1 }, (_, i) => (i / GRID_DIVISIONS) * 100)
)

/** 柱高百分比：按所属轴的**刻度上限**归一化，这样柱顶与网格线严格对应 */
function barHeight(value: number, axisMax: number): string {
  return Math.max(2, (value / axisMax) * 100) + '%'
}

/**
 * 日期标签抽样。
 *
 * 30 个「09-20」排不下 —— 这正是横向滚动条的来源。按桶数隔几个显示一个，
 * 并且**从末位往前数**，保证最新的那天一定有标签。
 */
const labelStep = computed(() => {
  const n = props.series.length
  if (n <= 12) return 1
  if (n <= 18) return 2
  if (n <= 26) return 3
  return 5
})

function showLabel(index: number): boolean {
  return (props.series.length - 1 - index) % labelStep.value === 0
}

/** 悬浮详情：用跟随光标的浮层，而不是原生 title（原生有延迟、不能排版、样式不可控） */
const hovered = ref<{ p: SeriesPoint; x: number; y: number } | null>(null)

function enterCol(p: SeriesPoint, e: MouseEvent): void {
  hovered.value = { p, x: e.clientX, y: e.clientY }
}

function moveCol(e: MouseEvent): void {
  if (hovered.value) {
    hovered.value.x = e.clientX
    hovered.value.y = e.clientY
  }
}

/**
 * 悬浮卡的位置。
 *
 * 右侧放不下就**翻到光标左侧** —— 之前是把它往左夹到 `innerWidth - 200`，
 * 结果 `position: fixed` 的收缩宽度被这剩下的 200px 卡住，
 * 内容一长（加了 M 单位括号之后）就折行。
 * 夹取只能保证不越界，不能保证内容排得开。
 */
const TIP_RESERVE_WIDTH = 280

const tipStyle = computed(() => {
  const h = hovered.value
  if (!h) return {}
  const fitsRight = h.x + 14 + TIP_RESERVE_WIDTH <= window.innerWidth - 8
  const left = fitsRight ? h.x + 14 : Math.max(8, h.x - TIP_RESERVE_WIDTH - 14)
  return { left: `${left}px`, top: `${Math.max(8, h.y - 12)}px` }
})

/** 悬浮卡里的 Token：附一个 M/B 单位的简略值，省得去数位数 */
function tokenShortform(n: number): string {
  return n >= 1e6 ? formatCompact(n) : ''
}
</script>

<template>
  <div v-if="series.length === 0" class="empty">{{ t('overview.rangeEmpty') }}</div>
  <div v-else class="chart-wrap">
    <div class="chart-legend">
      <span class="legend-item">
        <i class="legend-dot legend-dot-req" />{{ t('overview.legendRequests') }}
      </span>
      <span class="legend-item">
        <i class="legend-dot legend-dot-tok" />{{ t('overview.legendTokens') }}
      </span>
      <span class="legend-item">
        <i class="legend-dot legend-dot-err" />{{ t('overview.legendFailures') }}
      </span>
    </div>

    <div class="chart-body">
      <!-- 左轴：请求量 -->
      <div class="chart-axis chart-axis-left">
        <!--
          隐形量尺：把所有刻度叠在同一个网格单元里，宽度自然取最宽的那个。
          不能只拿「最大刻度」当量尺 —— 它不一定最宽
          （`1.6B` 里的点比数字窄，实际比 `800M` 窄）。
          写死宽度（曾是 46px）则会在窄刻度旁留一大片空白，白吃绘图区宽度。
        -->
        <span class="axis-measure" aria-hidden="true">
          <span v-for="tk in reqTicks" :key="tk.pct">{{ tk.label }}</span>
        </span>
        <span
          v-for="tk in reqTicks"
          :key="'r' + tk.pct"
          class="axis-label axis-req"
          :style="{ bottom: tk.pct + '%' }"
        >{{ tk.label }}</span>
      </div>

      <div class="chart-plot">
        <i
          v-for="g in gridLines"
          :key="'g' + g"
          class="chart-gridline"
          :style="{ bottom: g + '%' }"
        />
        <div class="chart-cols">
          <div
            v-for="p in series"
            :key="p.day"
            class="chart-col"
            :class="{ 'is-hover': hovered?.p.day === p.day }"
            @mouseenter="enterCol(p, $event)"
            @mousemove="moveCol"
            @mouseleave="hovered = null"
          >
            <div v-if="series.length <= 14" class="chart-value">
              <span class="cv-req">{{ p.requests }}</span>
              <span class="cv-tok">{{ formatCompact(p.tokens) }}</span>
            </div>
            <div class="chart-bars">
              <!--
                请求量柱：底部的红色段是失败量，其余是成功量。
                以前是「有失败就把整根柱染红」—— 而几乎每天都有失败，
                结果是图例里的蓝色根本看不到，图例与图形自相矛盾。
              -->
              <div class="chart-bar-stack">
                <div
                  class="chart-bar chart-bar-req"
                  :style="{ height: barHeight(p.requests, reqAxisMax) }"
                />
                <div
                  v-if="p.errors > 0"
                  class="chart-bar chart-bar-fail"
                  :style="{ height: barHeight(p.errors, reqAxisMax) }"
                />
              </div>
              <div
                class="chart-bar chart-bar-tok"
                :style="{ height: barHeight(p.tokens, tokAxisMax) }"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- 右轴：Token 用量 -->
      <div class="chart-axis chart-axis-right">
        <!--
          隐形量尺：让轴宽**恰好等于最宽的刻度**。
          写死宽度（曾是 46px）会在窄刻度（如「0」）旁留下一大片空白，
          白白吃掉绘图区宽度。
        -->
        <span class="axis-measure" aria-hidden="true">
          <span v-for="tk in tokTicks" :key="tk.pct">{{ tk.label }}</span>
        </span>
        <span
          v-for="tk in tokTicks"
          :key="'t' + tk.pct"
          class="axis-label axis-tok"
          :style="{ bottom: tk.pct + '%' }"
        >{{ tk.label }}</span>
      </div>

      <!-- 日期行：与绘图区同列同距，保证严格对齐 -->
      <div class="chart-labels">
        <div v-for="(p, i) in series" :key="'l' + p.day" class="chart-label-slot">
          <span class="chart-label" :class="{ 'is-hidden': !showLabel(i) }">
            {{ p.day }}
            <i v-if="p.errors > 0" class="chart-err-dot" />
          </span>
        </div>
      </div>
    </div>

    <!-- 悬浮详情：跟随光标，不参与布局 -->
    <div v-if="hovered" class="chart-tip" :style="tipStyle">
      <div class="chart-tip-day">{{ hovered.p.day }}</div>
      <div class="chart-tip-row">
        <i class="legend-dot legend-dot-req" />{{ t('overview.legendRequests') }}
        <span class="spacer" />{{ formatNumber(hovered.p.requests) }}
      </div>
      <div class="chart-tip-row">
        <i class="legend-dot legend-dot-tok" />{{ t('overview.legendTokens') }}
        <span class="spacer" />{{ formatNumber(hovered.p.tokens) }}
        <span v-if="tokenShortform(hovered.p.tokens)" class="dim chart-tip-alt">
          ({{ tokenShortform(hovered.p.tokens) }})
        </span>
      </div>
      <div v-if="hovered.p.errors > 0" class="chart-tip-row chart-tip-err">
        <i class="legend-dot legend-dot-err" />{{ t('overview.failed') }}
        <span class="spacer" />{{ formatNumber(hovered.p.errors) }}
      </div>
    </div>
  </div>
</template>
