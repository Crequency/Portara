<script setup lang="ts">
/**
 * 用量趋势卡片（双视图）—— 个人资料页用，数据口径 = **当前登录用户自己**。
 *
 * 为什么不从 OverviewView 抽一份出来：首页那张卡还连着 overview / 最近请求 /
 * Top 榜 / 余额等一整套请求与状态，为了复用一张卡去重构首页，风险远大于收益
 * （用户明确要求不要动概览页）。这里**独立实现**取数与偏好记忆，
 * 只复用纯展示组件：UsageTrendChart / UsageHeatmap / TrendSkeleton。
 *
 * 取数：/api/stats/series 与 /api/stats/heatmap 都带 `mine=1`，
 * 后端据此把范围限制到当前用户名下的 API Key（见 server/src/routes/logs.ts）。
 * 每条请求都带 tz —— 分桶与「今日」的日界按浏览器时区算。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import {
  api,
  type RangePreset,
  type SeriesPoint,
  type StatsHeatmap,
  type StatsSeries
} from '../api'
import TrendSkeleton from './TrendSkeleton.vue'
import UsageHeatmap from './UsageHeatmap.vue'
import UsageTrendChart from './UsageTrendChart.vue'
import { useI18n } from '../i18n'
import { loadRangePreference, saveRangePreference } from '../rangePreference'
import { CLIENT_TZ, tzQueryParam } from '../time'
import { toast } from '../toast'

const props = withDefaults(defineProps<{ mine?: boolean }>(), { mine: false })

const { t } = useI18n()

/** 范围与视图各记各的：键与概览页（portara.overview.*）刻意分开，互不干扰 */
const RANGE_KEY = 'portara.profile.range'
const TREND_VIEW_KEY = 'portara.profile.trendView'

type TrendView = 'chart' | 'heatmap'
const TREND_VIEWS: TrendView[] = ['chart', 'heatmap']
/** 必须与下面 presets 的 id 一致；也决定写入 map 时的键顺序 */
const TREND_RANGE_KEYS: RangePreset[] = ['today', '7d', '30d', '90d', '365d', 'custom']

const preset = ref<RangePreset>('today')
const customFrom = ref('')
const customTo = ref('')
const appliedCustom = ref<{ from: string; to: string } | null>(null)

const series = ref<SeriesPoint[]>([])
const granularity = ref<StatsSeries['granularity']>('hour')
const rangeFrom = ref('')
const rangeTo = ref('')
/** 本次统计实际使用的时区：以服务端回报为准（它可能回落到网关设置） */
const timezone = ref(CLIENT_TZ)
const loading = ref(true)
const failed = ref(false)

const trendView = ref<TrendView>('chart')
/** 各范围记住的视图；没有条目 = 趋势图 */
const trendViews = reactive<Partial<Record<RangePreset, TrendView>>>({})

function isTrendView(value: unknown): value is TrendView {
  return typeof value === 'string' && TREND_VIEWS.includes(value as TrendView)
}

/**
 * 读取偏好。存储**不可信**：坏 JSON、未知键名、未知值一律忽略该条并回退趋势图 ——
 * 宁可退回默认，也不能因为一条坏数据白屏（与概览页 / rangePreference.ts 同一风格）。
 */
function loadTrendViews(): void {
  for (const key of TREND_RANGE_KEYS) delete trendViews[key]
  try {
    const raw = localStorage.getItem(TREND_VIEW_KEY)
    if (!raw) return
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    for (const [key, value] of Object.entries(parsed)) {
      if (!TREND_RANGE_KEYS.includes(key as RangePreset)) continue
      if (!isTrendView(value)) continue
      trendViews[key as RangePreset] = value
    }
  } catch {
    /* 隐私模式 / 坏 JSON：用默认值即可 */
  }
}

function trendViewFor(range: RangePreset): TrendView {
  return trendViews[range] ?? 'chart'
}

/** 写入时把 6 个键写全，换范围时才不会丢别的范围的习惯 */
function persistTrendViews(): void {
  const data = {} as Record<RangePreset, TrendView>
  for (const range of TREND_RANGE_KEYS) data[range] = trendViewFor(range)
  try {
    localStorage.setItem(TREND_VIEW_KEY, JSON.stringify(data))
    for (const range of TREND_RANGE_KEYS) trendViews[range] = data[range]
  } catch {
    /* 写不进去不影响功能 */
  }
}

/** 启动时恢复上次的范围（必须在首次 load 之前调用） */
function restoreRange(): void {
  const saved = loadRangePreference(RANGE_KEY)
  if (!saved) return
  preset.value = saved.preset
  if (saved.preset === 'custom' && saved.from && saved.to) {
    customFrom.value = saved.from
    customTo.value = saved.to
    appliedCustom.value = { from: saved.from, to: saved.to }
  }
}

function persistRange(): void {
  saveRangePreference(RANGE_KEY, preset.value, appliedCustom.value)
}

const presets = computed<{ id: RangePreset; label: string }[]>(() => [
  { id: 'today', label: t('overview.today') },
  { id: '7d', label: t('overview.d7') },
  { id: '30d', label: t('overview.d30') },
  { id: '90d', label: t('overview.d90') },
  { id: '365d', label: t('overview.d365') },
  { id: 'custom', label: t('overview.custom') }
])

/** 当前区间（与时区无关的墙钟展示，与概览页同一套写法） */
const rangeLabel = computed(() => {
  if (!rangeFrom.value || !rangeTo.value) return ''
  const fmt = (iso: string) => {
    const d = new Date(iso)
    return (
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0') +
      ' ' +
      String(d.getHours()).padStart(2, '0') +
      ':' +
      String(d.getMinutes()).padStart(2, '0')
    )
  }
  return fmt(rangeFrom.value) + ' → ' + fmt(rangeTo.value)
})

/** 右上角粒度：趋势图按 series 的四值；热力图每格时长由组件自己写在脚注 */
const activeGranularity = computed(() => {
  if (trendView.value === 'heatmap') return ''
  switch (granularity.value) {
    case 'hour':
      return t('overview.perHour')
    case 'week':
      return t('overview.perWeek')
    case 'halfmonth':
      return t('overview.perHalfMonth')
    default:
      return t('overview.perDay')
  }
})

/** 查询串：range/from/to + tz，mine=1 时再带上「只看自己」 */
function rangeQuery(): string {
  const base =
    preset.value === 'custom' && appliedCustom.value
      ? new URLSearchParams({
          range: 'custom',
          from: new Date(appliedCustom.value.from).toISOString(),
          to: new Date(appliedCustom.value.to).toISOString()
        }).toString() +
        '&' +
        tzQueryParam()
      : 'range=' + preset.value + '&' + tzQueryParam()
  return props.mine ? base + '&mine=1' : base
}

// ---------------------------------------------------------------- 趋势序列

let seriesSeq = 0

async function loadSeries(): Promise<void> {
  const seq = ++seriesSeq
  loading.value = true
  failed.value = false
  try {
    const res = await api.get<StatsSeries>('/api/stats/series?' + rangeQuery())
    // 换范围时旧请求可能后到 —— 只认最后一次
    if (seq !== seriesSeq) return
    series.value = res.series
    granularity.value = res.granularity
    rangeFrom.value = res.range.from
    rangeTo.value = res.range.to
    timezone.value = res.timezone ?? CLIENT_TZ
  } catch (err) {
    if (seq !== seriesSeq) return
    series.value = []
    failed.value = true
    toast.error(err instanceof Error ? err.message : t('overview.loadFailed'))
  } finally {
    if (seq === seriesSeq) loading.value = false
  }
}

// ---------------------------------------------------------------- 热力图（按需）

/**
 * **按需请求**：只有切到「使用频率」才拉；结果连同 range query 一起缓存，
 * 切回趋势图再切回来不会重复打接口。range 变了缓存键自然对不上。
 */
const heatmap = ref<StatsHeatmap | null>(null)
const heatmapKey = ref('')
const heatmapLoading = ref(false)
const heatmapLoadingKey = ref('')
let heatmapSeq = 0

async function loadHeatmap(): Promise<void> {
  const q = rangeQuery()
  // 同一范围的请求已经在路上，别重复发
  if (heatmapLoading.value && heatmapLoadingKey.value === q) return
  const seq = ++heatmapSeq
  heatmapLoadingKey.value = q
  heatmapLoading.value = true
  try {
    const res = await api.get<StatsHeatmap>('/api/stats/heatmap?' + q)
    if (seq !== heatmapSeq) return
    heatmap.value = res
    heatmapKey.value = q
  } catch (err) {
    if (seq !== heatmapSeq) return
    heatmap.value = null
    heatmapKey.value = ''
    toast.error(err instanceof Error ? err.message : t('overview.loadFailed'))
  } finally {
    if (seq === heatmapSeq) {
      heatmapLoading.value = false
      heatmapLoadingKey.value = ''
    }
  }
}

/** 缓存命中就不请求；切回趋势图不触发（因为根本不会调用这里） */
function ensureHeatmap(): void {
  if (heatmapKey.value === rangeQuery()) return
  void loadHeatmap()
}

/**
 * 换范围专用：先丢掉旧范围的缓存键，再按新范围取数 ——
 * 否则新数据回来之前界面上会挂着上一范围的热力图（那是错的数字）。
 */
function reloadHeatmap(): void {
  heatmap.value = null
  heatmapKey.value = ''
  void loadHeatmap()
}

/** 切视图并写进**当前范围**的条目；切到热力图时按当前范围拉数（缓存命中不重复请求） */
function setTrendView(view: TrendView): void {
  trendView.value = view
  trendViews[preset.value] = view
  persistTrendViews()
  if (view === 'heatmap') ensureHeatmap()
}

/**
 * 切到某范围后**立刻**套用该范围记住的视图。
 * 必须在 preset / appliedCustom 已经改好之后调用 —— 热力图会用 rangeQuery() 取数。
 */
function applyTrendViewForRange(): void {
  trendView.value = trendViewFor(preset.value)
  if (trendView.value !== 'heatmap') return
  if (heatmapKey.value === rangeQuery()) return
  reloadHeatmap()
}

/** 换范围：系列与（若停在热力图）热力图都重新取数 */
function refresh(): void {
  if (trendView.value === 'heatmap') void loadHeatmap()
  void loadSeries()
}

function choosePreset(id: RangePreset): void {
  preset.value = id
  persistRange()
  if (id === 'custom') {
    const now = new Date()
    const before = new Date(now.getTime() - 24 * 3600_000)
    const local = (d: Date) =>
      new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    customFrom.value = local(before)
    customTo.value = local(now)
    appliedCustom.value = { from: customFrom.value, to: customTo.value }
    // 顺序要紧：preset / appliedCustom 改完再套视图，热力图才会按新范围请求
    applyTrendViewForRange()
    refresh()
    return
  }
  applyTrendViewForRange()
  refresh()
}

function applyCustom(): void {
  if (!customFrom.value || !customTo.value) {
    toast.error(t('overview.needRange'))
    return
  }
  if (new Date(customFrom.value) >= new Date(customTo.value)) {
    toast.error(t('overview.badRange'))
    return
  }
  appliedCustom.value = { from: customFrom.value, to: customTo.value }
  persistRange()
  applyTrendViewForRange()
  refresh()
}

onMounted(() => {
  // 先恢复偏好，再加载 —— 否则首屏会先按默认值渲染一次
  restoreRange()
  loadTrendViews()
  trendView.value = trendViewFor(preset.value)
  void loadSeries()
  if (trendView.value === 'heatmap') void loadHeatmap()
})
</script>

<template>
  <div class="card">
    <div class="card-head">
      <div class="card-title">{{ t('profile.usageTrend') }}</div>
      <!-- 右上角：趋势图 / 使用频率，与概览页同一套文案与交互 -->
      <div class="segmented segmented-sm" role="group" :aria-label="t('profile.usageTrend')">
        <button :class="{ on: trendView === 'chart' }" @click="setTrendView('chart')">
          {{ t('overview.trendViewChart') }}
        </button>
        <button :class="{ on: trendView === 'heatmap' }" @click="setTrendView('heatmap')">
          {{ t('overview.trendViewHeatmap') }}
        </button>
      </div>
    </div>

    <div class="row row-wrap trend-range">
      <div class="segmented">
        <button
          v-for="p in presets"
          :key="p.id"
          :class="{ on: preset === p.id }"
          @click="choosePreset(p.id)"
        >
          {{ p.label }}
        </button>
      </div>

      <template v-if="preset === 'custom'">
        <input
          v-model="customFrom"
          type="datetime-local"
          style="width: 200px"
          @change="applyCustom"
        />
        <span class="dim">→</span>
        <input
          v-model="customTo"
          type="datetime-local"
          style="width: 200px"
          @change="applyCustom"
        />
        <button class="btn btn-sm" @click="applyCustom">{{ t('overview.apply') }}</button>
      </template>

      <span class="spacer" />
      <span class="dim row trend-meta">
        <span>{{ rangeLabel }}</span>
        <template v-if="activeGranularity">
          <span>·</span>
          <span>{{ activeGranularity }}</span>
        </template>
        <span>·</span>
        <!-- 让用户明确知道统计口径用的是哪个时区 -->
        <span :title="t('overview.timezoneLabel') + '：' + timezone">
          {{ t('overview.timezoneLabel') }} {{ timezone }}
        </span>
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="refresh">
          {{ t('common.refresh') }}
        </button>
      </span>
    </div>

    <!--
      两个视图各有一套骨架。热力图视图下换范围会同时把 loading 与
      heatmapLoading 置真，所以必须先按视图分流 —— 否则会先闪一下趋势图骨架。
    -->
    <TrendSkeleton
      v-if="trendView === 'heatmap' && (loading || heatmapLoading)"
      mode="heatmap"
      :preset="preset"
    />
    <TrendSkeleton v-else-if="loading" mode="chart" />
    <UsageTrendChart v-else-if="trendView === 'chart'" :series="series" />
    <UsageHeatmap v-else-if="heatmap" :data="heatmap" />
    <div v-else class="empty">
      {{ failed ? t('overview.loadFailed') : t('overview.rangeEmpty') }}
    </div>
  </div>
</template>

<style scoped>
/* 范围选择行：与卡片标题拉开一点，窄屏自然折行 */
.trend-range {
  align-items: center;
  gap: 10px;
  margin: 2px 0 14px;
}

/* 右上角的区间 / 粒度 / 时区：一行小字，放不下就折行 */
.trend-meta {
  align-items: center;
  gap: 8px;
  font-size: 12px;
  flex-wrap: wrap;
}
</style>
