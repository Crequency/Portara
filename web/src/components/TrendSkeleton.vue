<script setup lang="ts">
/**
 * 用量趋势卡片的骨架屏 —— 趋势图 / 使用频率两个视图各一套。
 *
 * 只负责几何：占位块的底色与流光全部来自全局 `.sk`（见 styles.css），
 * 结构、尺寸、行列数都对齐真实组件，数据回来时卡片高度不跳。
 */
import { computed } from 'vue'
import type { RangePreset } from '../api'
import { useI18n } from '../i18n'

const props = withDefaults(
  defineProps<{
    mode: 'chart' | 'heatmap'
    /** 热力图档位：决定占位矩阵的列数与行数（趋势图不用） */
    preset?: RangePreset
  }>(),
  { preset: 'today' }
)

const { t } = useI18n()

/**
 * 趋势图柱高（百分比）。
 *
 * 固定数组、不用 Math.random —— 随机的占位每渲染一次就变一轮，
 * 骨架自己在那儿跳，比没有骨架还难受。请求量柱整体高一些，
 * Token 柱矮一些，和真实图表两根柱的比例接近。
 */
const CHART_BARS_REQ = [
  38, 62, 45, 84, 55, 72, 33, 91, 68, 48, 76, 58, 41, 88, 63, 52, 79, 36, 69, 46, 82, 57, 74, 44
]
const CHART_BARS_TOK = [
  24, 47, 31, 66, 40, 58, 21, 73, 54, 33, 61, 45, 28, 70, 49, 37, 64, 23, 56, 30, 68, 42, 60, 35
]

/** 图例占位的三个短条宽度（对应真实图例的三项） */
const LEGEND_WIDTHS = [64, 72, 56]

/**
 * 各范围的热力图矩阵维度，与后端 resolveHeatmapPlan 的口径一致：
 *   today 96×15、7d 84×12、30d 90×16、90d 90×12、365d 53×7。
 *
 * custom 的维度取决于用户选的天数，前端在接口返回前无从得知，
 * 取 7d 的 84×12 近似兜底 —— 这里只是加载占位，真实网格以接口为准。
 */
const HEATMAP_DIMS: Record<RangePreset, { cols: number; rows: number }> = {
  today: { cols: 96, rows: 15 },
  '7d': { cols: 84, rows: 12 },
  '30d': { cols: 90, rows: 16 },
  '90d': { cols: 90, rows: 12 },
  '365d': { cols: 53, rows: 7 },
  custom: { cols: 84, rows: 12 }
}

const dims = computed(() => HEATMAP_DIMS[props.preset] ?? HEATMAP_DIMS['7d'])
/** 365d 是年历：顶部有月份行、没有底部横轴（与真实组件一致） */
const isCalendar = computed(() => props.preset === '365d')
const cellCount = computed(() => dims.value.cols * dims.value.rows)
const colsVar = computed(() => ({ '--sk-cols': String(dims.value.cols) }))
</script>

<template>
  <!-- 趋势图骨架：图例 / 左轴 / 柱列 / 右轴 / 横轴标签 -->
  <div
    v-if="mode === 'chart'"
    class="sk-trend sk-chart"
    role="status"
    :aria-label="t('common.loading')"
  >
    <div class="sk-chart-inner" aria-hidden="true">
      <div class="sk-chart-legend">
        <span
          v-for="(width, i) in LEGEND_WIDTHS"
          :key="'legend' + i"
          class="sk sk-chart-legend-item"
          :style="{ width: width + 'px' }"
          aria-hidden="true"
        />
      </div>

      <div class="sk-chart-body">
        <div class="sk-chart-axis sk-chart-axis-left" aria-hidden="true">
          <span v-for="n in 5" :key="'la' + n" class="sk sk-chart-tick" aria-hidden="true" />
        </div>

        <div class="sk-chart-plot" aria-hidden="true">
          <div v-for="(height, i) in CHART_BARS_REQ" :key="'col' + i" class="sk-chart-col">
            <span
              class="sk sk-chart-bar sk-chart-bar-req"
              :style="{ height: height + '%' }"
              aria-hidden="true"
            />
            <span
              class="sk sk-chart-bar sk-chart-bar-tok"
              :style="{ height: (CHART_BARS_TOK[i] ?? 0) + '%' }"
              aria-hidden="true"
            />
          </div>
        </div>

        <div class="sk-chart-axis sk-chart-axis-right" aria-hidden="true">
          <span v-for="n in 5" :key="'ra' + n" class="sk sk-chart-tick" aria-hidden="true" />
        </div>

        <div class="sk-chart-labels" aria-hidden="true">
          <span v-for="n in 6" :key="'x' + n" class="sk sk-chart-label" aria-hidden="true" />
        </div>
      </div>
    </div>
  </div>

  <!-- 使用频率骨架：月份行（仅 365d）/ 纵轴标签 / 矩阵 / 横轴标签 / 脚注 -->
  <div
    v-else
    class="sk-trend sk-heat"
    role="status"
    :aria-label="t('common.loading')"
  >
    <div class="sk-heat-inner" aria-hidden="true">
      <div class="sk-heat-chart">
        <div v-if="isCalendar" class="sk-heat-months" aria-hidden="true">
          <span v-for="n in 12" :key="'m' + n" class="sk sk-heat-month" aria-hidden="true" />
        </div>

        <div class="sk-heat-body" :style="colsVar">
          <div class="sk-heat-ylabels" aria-hidden="true">
            <span v-for="n in 4" :key="'y' + n" class="sk sk-heat-ylabel" aria-hidden="true" />
          </div>

          <!-- 与真实组件同一套 Grid 几何：列优先均分、1/1 格子、2px 间距 -->
          <div class="sk-heat-grid" aria-hidden="true">
            <span
              v-for="n in cellCount"
              :key="'cell' + n"
              class="sk sk-heat-cell"
              aria-hidden="true"
            />
          </div>
        </div>

        <div v-if="!isCalendar" class="sk-heat-xlabels" aria-hidden="true">
          <span v-for="n in 4" :key="'x' + n" class="sk sk-heat-xlabel" aria-hidden="true" />
        </div>
      </div>

      <div class="sk-heat-foot" aria-hidden="true">
        <span class="sk sk-heat-foot-item" style="width: 132px" aria-hidden="true" />
        <span class="sk sk-heat-foot-item" style="width: 74px" aria-hidden="true" />
        <span class="spacer" />
        <span class="sk sk-heat-foot-item" style="width: 62px" aria-hidden="true" />
      </div>
    </div>
  </div>
</template>
