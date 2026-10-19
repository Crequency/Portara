<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  api,
  type RangePreset,
  type RequestLog,
  type SeriesPoint,
  type UsageSnapshot,
  type StatsOverview,
  type StatsSeries,
  type User
} from '../api'
import {
  formatCompact,
  formatLatency,
  formatNumber,
  formatPercent,
  formatTime,
  quotaColor,
  quotaPercent
} from '../format'
import { useI18n } from '../i18n'
import { loadRangePreference, saveRangePreference } from '../rangePreference'
import { CLIENT_TZ, tzQueryParam } from '../time'
import { toast } from '../toast'

const props = defineProps<{ user?: User }>()

const { t } = useI18n()

const preset = ref<RangePreset>('today')
const customFrom = ref('')
const customTo = ref('')
const appliedCustom = ref<{ from: string; to: string } | null>(null)

const stats = ref<StatsOverview | null>(null)
const series = ref<SeriesPoint[]>([])
const granularity = ref<'hour' | 'day'>('hour')
const recent = ref<RequestLog[]>([])
const loading = ref(true)

/** 记住上次用的统计粒度（键与渠道详情页**不同**，两处记忆彼此独立） */
const RANGE_KEY = 'portara.overview.range'

/** 启动时恢复上次的粒度（必须在首次 load 之前调用） */
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
  { id: 'custom', label: t('overview.custom') }
])

// 请求量与 Token 量级差得远（几十 vs 几百万），
// 若共用一根轴，请求量的柱子会被压成一条线 —— 因此两条序列各自按自身峰值缩放
const maxRequests = computed(() => Math.max(1, ...series.value.map((p) => p.requests)))
const maxTokens = computed(() => Math.max(1, ...series.value.map((p) => p.tokens)))

/** 柱高百分比：按所属轴的**刻度上限**归一化，这样柱顶与网格线严格对应 */
function barHeight(value: number, axisMax: number): string {
  return Math.max(2, (value / axisMax) * 100) + '%'
}

/** 悬浮说明：一次给全该时段的三个数字 */
// ---------------------------------------------------------------- 图表坐标轴

/** 网格分格数：左右两轴共用同一组横向网格线，各自标注自己的量纲 */
const GRID_DIVISIONS = 4

/**
 * 轴上限。
 *
 * 两条序列量级差得远（请求数几千、token 十几亿），共用一根轴会把请求量压成一条线，
 * 所以各用各的轴。这里**对「每格步长」取整而不是对峰值取整** ——
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

const reqTicks = computed(() =>
  axisTicks(reqAxisMax.value, (v) => formatNumber(Math.round(v)))
)
const tokTicks = computed(() => axisTicks(tokAxisMax.value, (v) => formatCompact(v)))
const gridLines = computed(() =>
  Array.from({ length: GRID_DIVISIONS + 1 }, (_, i) => (i / GRID_DIVISIONS) * 100)
)

/**
 * 日期标签抽样。
 *
 * 30 个「09-20」排不下 —— 这正是横向滚动条的来源。按桶数隔几个显示一个，
 * 并且**从末位往前数**，保证最新的那天一定有标签。
 */
const labelStep = computed(() => {
  const n = series.value.length
  if (n <= 12) return 1
  if (n <= 18) return 2
  if (n <= 26) return 3
  return 5
})

function showLabel(index: number): boolean {
  return (series.value.length - 1 - index) % labelStep.value === 0
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

const tipStyle = computed(() => {
  const h = hovered.value
  if (!h) return {}
  const width = 200
  const left = Math.max(8, Math.min(h.x + 14, window.innerWidth - width - 8))
  return { left: `${left}px`, top: `${Math.max(8, h.y - 12)}px` }
})

const rangeLabel = computed(() => {
  if (!stats.value) return ''
  const from = new Date(stats.value.range.from)
  const to = new Date(stats.value.range.to)
  const fmt = (d: Date) =>
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0') +
    ' ' +
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0')
  return fmt(from) + ' → ' + fmt(to)
})

/**
 * Top 卡片的排序依据（每张卡片独立切换）。
 *
 * 后端返回的是**候选集**（每类最多 10 条 = 两种排序各自的前 5），
 * 所以切换排序纯属本地重排，不需要再请求一次。
 */
type TopSort = 'requests' | 'tokens'
const topSort = reactive<Record<'models' | 'channels' | 'keys', TopSort>>({
  models: 'requests',
  channels: 'requests',
  keys: 'requests'
})

const topBlocks = computed(() => [
  { key: 'models' as const, title: t('overview.topModels'), rows: stats.value?.topModels ?? [] },
  { key: 'channels' as const, title: t('overview.topChannels'), rows: stats.value?.topChannels ?? [] },
  { key: 'keys' as const, title: t('overview.topKeys'), rows: stats.value?.topKeys ?? [] }
])

// ---------------------------------------------------------------- 余额用量（概览）

/**
 * 余额快照。**只保留请求成功的** —— 概览是摘要，
 * 失败详情在「余额用量」页看；但失败数量会以一行小字提示，不静默吞掉。
 */
const usageSnapshots = ref<UsageSnapshot[]>([])
const usageOk = computed(() => usageSnapshots.value.filter((s) => s.ok))
const usageFailedCount = computed(
  () => usageSnapshots.value.length - usageOk.value.length
)

const isAdmin = computed(() => props.user?.role === 'admin')

/**
 * 窗口按**已用百分比降序**：最紧的排第一。
 *
 * 这样窄屏只要隐藏第一条之后的窗口，就自动等价于「只显示最紧的那条」——
 * 不必为两种布局各写一套 DOM。
 */
function sortedWindows(s: UsageSnapshot) {
  return [...(s.windows ?? [])].sort(
    (a, b) => quotaPercent(b.used, b.total) - quotaPercent(a.used, a.total)
  )
}


/**
 * 窗口键 → 界面文案。
 * 不能直接显示原始键名（fiveHour/monthly 会以英文混进中文界面）；
 * MiniMax 的键形如 `MiniMax-M*:interval`，只取冒号后的部分。
 */
function windowLabel(key: string): string {
  const base = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
  const map: Record<string, string> = {
    fiveHour: t('usage.windowFiveHour'),
    weekly: t('usage.windowWeekly'),
    monthly: t('usage.windowMonthly'),
    interval: t('usage.windowInterval')
  }
  return map[base] ?? base
}

/** 渠道的主余额（金额或 credits） */
function primaryBalance(s: UsageSnapshot) {
  return s.balances && s.balances.length > 0 ? s.balances[0]! : null
}

async function loadUsage(): Promise<void> {
  if (!isAdmin.value) return
  try {
    const res = await api.get<{ providers: UsageSnapshot[] }>('/api/usage')
    usageSnapshots.value = res.providers
  } catch {
    // 概览是次要信息，拿不到就不显示这张卡，不打扰用户
    usageSnapshots.value = []
  }
}

/** 按指定依据排序并取前 5 */
function sortedTop(key: 'models' | 'channels' | 'keys'): {
  name: string
  requests: number
  tokens: number
}[] {
  const rows = topBlocks.value.find((b) => b.key === key)?.rows ?? []
  const metric = topSort[key]
  return [...rows]
    .sort((a, b) =>
      metric === 'tokens'
        ? b.tokens - a.tokens || a.name.localeCompare(b.name)
        : b.requests - a.requests || a.name.localeCompare(b.name)
    )
    .slice(0, 5)
}

/** 当前排序依据下的最大值，用于柱长归一化 */
function topMax(key: 'models' | 'channels' | 'keys'): number {
  const rows = sortedTop(key)
  const metric = topSort[key]
  return Math.max(1, ...rows.map((r) => (metric === 'tokens' ? r.tokens : r.requests)))
}

function rangeQuery(): string {
  if (preset.value === 'custom' && appliedCustom.value) {
    return new URLSearchParams({
      range: 'custom',
      from: new Date(appliedCustom.value.from).toISOString(),
      to: new Date(appliedCustom.value.to).toISOString()
    }).toString()
  }
  return 'range=' + preset.value + '&' + tzQueryParam()
}

/** 本次统计实际使用的时区：以服务端回报为准（它可能回落到网关设置） */
const effectiveTz = computed(() => stats.value?.timezone ?? CLIENT_TZ)

async function load(): Promise<void> {
  loading.value = true
  try {
    const q = rangeQuery()
    const [overview, s, logs] = await Promise.all([
      api.get<StatsOverview>('/api/stats/overview?' + q),
      api.get<StatsSeries>('/api/stats/series?' + q),
      api.get<{ logs: RequestLog[] }>('/api/logs?limit=8')
    ])
    stats.value = overview
    series.value = s.series
    granularity.value = s.granularity
    recent.value = logs.logs
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('overview.loadFailed'))
  } finally {
    loading.value = false
  }
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
    void load()
    return
  }
  void load()
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
  void load()
}

function go(id: string): void {
  location.hash = '#/' + id
}

onMounted(() => {
  // 先恢复上次的粒度，再加载 —— 否则首屏会先按默认粒度拉一次
  restoreRange()
  void loadUsage()
  void load()
})
</script>

<template>
  <div class="stack">
    <div class="card">
      <div class="row row-wrap">
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
        <span class="dim row" style="font-size: 12px; gap: 8px">
          <span>{{ rangeLabel }}</span>
          <span>·</span>
          <span>{{ granularity === 'hour' ? t('overview.perHour') : t('overview.perDay') }}</span>
          <span>·</span>
          <!-- 让用户明确知道统计口径用的是哪个时区，否则改了设置也看不出来 -->
          <span :title="t('overview.timezoneLabel') + '：' + effectiveTz">
            {{ t('overview.timezoneLabel') }} {{ effectiveTz }}
          </span>
          <button class="btn btn-ghost btn-sm" :disabled="loading" @click="load">
            {{ t('common.refresh') }}
          </button>
        </span>
      </div>
    </div>

    <div class="grid grid-4">
      <div class="stat">
        <div class="stat-label">{{ t('overview.requests') }}</div>
        <div class="stat-value">{{ formatNumber(stats?.totals.requests) }}</div>
        <div class="stat-hint">
          {{ t('overview.failed') }} {{ formatNumber(stats?.totals.errors) }} ·
          {{ formatPercent(stats?.totals.errorRate ?? 0) }}
        </div>
        <div
          v-if="(stats?.totals.diagnosticRequests ?? 0) > 0"
          class="stat-hint"
          style="color: var(--warn)"
        >
          {{ t('overview.diagnostic', { n: formatNumber(stats?.totals.diagnosticRequests) }) }}
        </div>
      </div>
      <div class="stat">
        <div class="stat-label">{{ t('overview.tokens') }}</div>
        <div class="stat-value">{{ formatCompact(stats?.totals.tokens) }}</div>
        <div class="stat-hint">
          {{ t('overview.inTokens') }} {{ formatCompact(stats?.totals.promptTokens) }} ·
          {{ t('overview.outTokens') }} {{ formatCompact(stats?.totals.completionTokens) }}
        </div>
      </div>
      <div class="stat">
        <div class="stat-label">{{ t('overview.avgLatency') }}</div>
        <div class="stat-value">{{ formatLatency(stats?.totals.avgLatencyMs) }}</div>
        <div class="stat-hint">
          {{ t('overview.p95') }} {{ formatLatency(stats?.totals.p95LatencyMs) }}
        </div>
      </div>
      <div class="stat">
        <div class="stat-label">{{ t('overview.estimated') }}</div>
        <div class="stat-value">{{ formatNumber(stats?.totals.estimated) }}</div>
        <div class="stat-hint">{{ t('overview.estimatedHint') }}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-title">{{ t('overview.trend') }}</div>
        <span class="dim" style="font-size: 12px">
          {{
            t('overview.resources', {
              active: formatNumber(stats?.resources.activeChannels),
              total: formatNumber(stats?.resources.channels),
              keys: formatNumber(stats?.resources.keys),
              users: formatNumber(stats?.resources.users)
            })
          }}
        </span>
      </div>

      <div v-if="loading" class="loading">{{ t('common.loading') }}</div>
      <div v-else-if="series.length === 0" class="empty">{{ t('overview.rangeEmpty') }}</div>
      <div v-else class="chart-wrap">
        <div class="chart-legend">
          <span class="legend-item">
            <i class="legend-dot legend-dot-req" />{{ t('overview.legendRequests') }}
          </span>
          <span class="legend-item">
            <i class="legend-dot legend-dot-tok" />{{ t('overview.legendTokens') }}
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
                  <div
                    class="chart-bar chart-bar-req"
                    :class="{ 'chart-bar-err': p.errors > 0 }"
                    :style="{ height: barHeight(p.requests, reqAxisMax) }"
                  />
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
        </div>
        <div v-if="hovered.p.errors > 0" class="chart-tip-row chart-tip-err">
          <i class="legend-dot legend-dot-err" />{{ t('overview.failed') }}
          <span class="spacer" />{{ formatNumber(hovered.p.errors) }}
        </div>
      </div>
    </div>

    <div class="grid grid-3">
      <div v-for="block in topBlocks" :key="block.key" class="card">
        <div class="card-head">
          <div class="card-title">{{ block.title }}</div>
          <!-- 右上角：切换排序依据（本地重排，不重新请求） -->
          <div class="segmented segmented-sm" :title="t('overview.sortHint')">
            <button
              :class="{ on: topSort[block.key] === 'requests' }"
              @click="topSort[block.key] = 'requests'"
            >
              {{ t('overview.sortByRequestsShort') }}
            </button>
            <button
              :class="{ on: topSort[block.key] === 'tokens' }"
              @click="topSort[block.key] = 'tokens'"
            >
              {{ t('overview.sortByTokensShort') }}
            </button>
          </div>
        </div>

        <div v-if="sortedTop(block.key).length === 0" class="empty">
          {{ t('common.empty') }}
        </div>
        <div v-else class="form-grid" style="gap: 10px">
          <div v-for="row in sortedTop(block.key)" :key="row.name">
            <div class="row-between" style="font-size: 12.5px">
              <span class="mono" style="overflow: hidden; text-overflow: ellipsis">
                {{ row.name }}
              </span>
              <!-- 两个数字都给，把当前排序依据的那个点亮 -->
              <span class="nowrap">
                <span :class="topSort[block.key] === 'requests' ? 'metric-on' : 'dim'">
                  {{ t('overview.times', { n: row.requests }) }}
                </span>
                <span class="dim"> · </span>
                <span :class="topSort[block.key] === 'tokens' ? 'metric-on' : 'dim'">
                  {{ formatCompact(row.tokens) }} tok
                </span>
              </span>
            </div>
            <div style="height: 4px; background: var(--bg-elev-2); border-radius: 3px; margin-top: 4px">
              <div
                :style="{
                  width:
                    ((topSort[block.key] === 'tokens' ? row.tokens : row.requests) /
                      topMax(block.key)) *
                      100 +
                    '%',
                  height: '100%',
                  background: 'var(--accent)',
                  borderRadius: '3px'
                }"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 余额用量：多渠道合并成一张卡，只显示请求成功的，只给重点 -->
    <div v-if="isAdmin" class="card">
      <div class="card-head">
        <div class="card-title">{{ t('overview.usageTitle') }}</div>
        <button class="btn btn-sm" @click="go('usage')">{{ t('overview.usageMore') }} →</button>
      </div>

      <div v-if="usageOk.length === 0" class="empty">
        <template v-if="usageSnapshots.length > 0">{{ t('overview.usageAllFailed') }}</template>
        <template v-else>
          {{ t('overview.usageNone') }}
          <div class="dim" style="font-size: 12px; margin-top: 6px">
            {{ t('overview.usageNoneHint') }}
          </div>
        </template>
      </div>

      <div v-else class="usage-grid">
        <div v-for="s in usageOk" :key="s.channelId" class="usage-cell">
          <div class="row" style="gap: 7px; min-width: 0">
            <span class="usage-cell-name">{{ s.channelName }}</span>
            <span class="tag">{{ s.adapter }}</span>
          </div>

          <!-- 金额余额（DeepSeek / Moonshot 这类） -->
          <div v-if="primaryBalance(s)" class="mono usage-cell-balance">
            {{
              primaryBalance(s)!.remaining.toLocaleString('en-US', { maximumFractionDigits: 4 })
            }}
            <span class="dim">{{ primaryBalance(s)!.currency }}</span>
          </div>

          <!-- 额度窗口：宽屏全列，窄屏只留最紧的那条 -->
          <div v-if="sortedWindows(s).length" class="usage-windows">
            <div v-for="w in sortedWindows(s)" :key="w.key" class="usage-window">
              <div class="row-between" style="font-size: 11.5px; gap: 8px">
                <span class="nowrap">{{ windowLabel(w.key) }}</span>
                <span
                  class="nowrap"
                  :style="{ color: quotaColor(quotaPercent(w.used, w.total), w.exceeded) }"
                >
                  {{ quotaPercent(w.used, w.total) }}%
                </span>
              </div>
              <div class="usage-window-track">
                <div
                  :style="{
                    width: quotaPercent(w.used, w.total) + '%',
                    height: '100%',
                    background: quotaColor(quotaPercent(w.used, w.total), w.exceeded),
                    borderRadius: '3px'
                  }"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        v-if="usageFailedCount > 0"
        class="dim"
        style="font-size: 11.5px; margin-top: 10px"
      >
        {{ t('overview.usageFailed', { n: usageFailedCount }) }}
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-title">{{ t('overview.recent') }}</div>
        <span class="dim" style="font-size: 12px">{{ t('overview.recentHint') }}</span>
      </div>

      <div v-if="recent.length === 0" class="empty">{{ t('overview.emptyHint') }}</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('overview.time') }}</th>
              <th>{{ t('overview.key') }}</th>
              <th>{{ t('overview.channel') }}</th>
              <th>{{ t('overview.model') }}</th>
              <th>{{ t('overview.status') }}</th>
              <th>{{ t('overview.token') }}</th>
              <th>{{ t('overview.duration') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in recent" :key="log.id">
              <td class="nowrap dim">{{ formatTime(log.ts) }}</td>
              <td>{{ log.apiKeyName || '—' }}</td>
              <td>{{ log.channelName || '—' }}</td>
              <td class="mono">{{ log.model || '—' }}</td>
              <td>
                <span class="badge" :class="log.statusCode < 400 ? 'badge-ok' : 'badge-err'">
                  {{ log.statusCode }}
                </span>
              </td>
              <td class="nowrap">
                {{ formatNumber(log.totalTokens) }}
                <span v-if="log.estimated" class="badge badge-warn">{{ t('logs.estimated') }}</span>
              </td>
              <td class="nowrap">{{ formatLatency(log.latencyMs) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
