<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  api,
  type RangePreset,
  type RequestLog,
  type SeriesPoint,
  type UsageSnapshot,
  type StatsOverview,
  type StatsSeries,
  type StatsHeatmap,
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
import PSelect from '../components/PSelect.vue'
import UsageHeatmap from '../components/UsageHeatmap.vue'
import UsageTrendChart from '../components/UsageTrendChart.vue'
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
const granularity = ref<StatsSeries['granularity']>('hour')
const recent = ref<RequestLog[]>([])
const loading = ref(true)

/**
 * 「用量趋势」卡片内的两个视图：趋势图 / 使用频率。
 *
 * **按时间范围分别记忆**：在「今日」习惯看热力图、在「近一个月」习惯看走势，
 * 本来就是两件事。只记一个全局值的话，每换一次范围都得再手动点一遍。
 *
 * 存的是 JSON map（键 = range preset，值 = 视图）：
 * `{"today":"heatmap","30d":"chart"}`。
 * 存储**不可信**：坏 JSON、未知键名、未知值一律忽略该条并回退趋势图 ——
 * 宁可退回默认，也不能因为一条坏数据白屏。
 */
type TrendView = 'chart' | 'heatmap'
const TREND_VIEW_KEY = 'portara.overview.trendView'
const TREND_VIEWS: TrendView[] = ['chart', 'heatmap']
/** 必须与下面 `presets` 的 id 一致；也决定写入 map 时的键顺序 */
const TREND_RANGE_KEYS: RangePreset[] = ['today', '7d', '30d', '90d', '365d', 'custom']

const trendView = ref<TrendView>('chart')
/** 各范围记住的视图；没有条目 = 趋势图 */
const trendViews = reactive<Partial<Record<RangePreset, TrendView>>>({})
/**
 * **旧版格式**（裸字符串 `'chart'` / `'heatmap'`）的语义是「所有范围的默认视图」。
 * 读到它时记在这里兜底，等下次写入时自然升级成 map —— 不主动清掉、也不报错。
 */
let legacyTrendView: TrendView | null = null

function isTrendView(value: unknown): value is TrendView {
  return typeof value === 'string' && TREND_VIEWS.includes(value as TrendView)
}

/** 读取偏好；坏数据只丢坏的那条，不连坐整个 map */
function loadTrendViews(): void {
  for (const key of TREND_RANGE_KEYS) delete trendViews[key]
  legacyTrendView = null
  try {
    const raw = localStorage.getItem(TREND_VIEW_KEY)
    if (!raw) return
    // 老格式：裸字符串 = 所有范围的默认视图，先放内存，下次写入时升级
    if (isTrendView(raw)) {
      legacyTrendView = raw
      return
    }
    const parsed: unknown = JSON.parse(raw)
    // JSON 字符串形式的旧格式（手写过 "heatmap"）也按老格式处理
    if (isTrendView(parsed)) {
      legacyTrendView = parsed
      return
    }
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

/** 某范围该用哪个视图：本范围的记录 → 旧版全局默认 → 趋势图 */
function trendViewFor(range: RangePreset): TrendView {
  return trendViews[range] ?? legacyTrendView ?? 'chart'
}

/**
 * 写入偏好。
 *
 * 顺带把旧版全局默认落到每个范围：map 里写全量条目，升级后行为与升级前一致
 * （不只是当前范围，否则其余范围会因为「少了回退」而悄悄变回趋势图）。
 * 写不进去（隐私模式）就静默忽略，内存也保持原样，避免与存储各说各话。
 */
function persistTrendViews(): void {
  const data = {} as Record<RangePreset, TrendView>
  for (const range of TREND_RANGE_KEYS) data[range] = trendViewFor(range)
  try {
    localStorage.setItem(TREND_VIEW_KEY, JSON.stringify(data))
    for (const range of TREND_RANGE_KEYS) trendViews[range] = data[range]
    legacyTrendView = null
  } catch {
    /* 写不进去不影响功能 */
  }
}

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
  { id: '90d', label: t('overview.d90') },
  { id: '365d', label: t('overview.d365') },
  { id: 'custom', label: t('overview.custom') }
])

/*
 * 图表本身（双轴、悬浮、标签抽样）在 components/UsageTrendChart.vue。
 * 这里只管取数与粒度 —— 渠道详情页也画同一张图，两个实现必然两处走样。
 */

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

/**
 * 三张 Top 卡的排序依据也要记住。
 *
 * 和统计粒度是同一类偏好：**习惯看 token 的人每次刷新都要再点一遍**，
 * 纯属重复劳动。存到 localStorage，刷新后照旧。
 */
const TOP_SORT_KEY = 'portara.overview.topSort'
const TOP_KEYS = ['models', 'channels', 'keys'] as const

function loadTopSort(): void {
  try {
    const raw = localStorage.getItem(TOP_SORT_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const k of TOP_KEYS) {
      const v = parsed?.[k]
      // 只接受已知取值 —— 坏数据不该让界面进入未知状态
      if (v === 'requests' || v === 'tokens') topSort[k] = v
    }
  } catch {
    /* 隐私模式 / 坏 JSON：用默认值即可 */
  }
}

function persistTopSort(): void {
  try {
    localStorage.setItem(TOP_SORT_KEY, JSON.stringify(topSort))
  } catch {
    /* 写不进去不影响功能 */
  }
}

/** 切换某张卡的排序依据并立即记住 */
function setTopSort(key: (typeof TOP_KEYS)[number], basis: TopSort): void {
  topSort[key] = basis
  persistTopSort()
}

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
/**
 * 首次拉取尚未回来。初值必须是 true —— 否则 usageOk 在首帧为空，
 * 会先闪一下「还没有渠道配置余额适配器」再被真实数据替换。
 */
const usageLoading = ref(true)
const usageOk = computed(() => usageSnapshots.value.filter((s) => s.ok))
const usageFailedCount = computed(
  () => usageSnapshots.value.length - usageOk.value.length
)

const isAdmin = computed(() => props.user?.role === 'admin')

/**
 * 每张渠道卡各自记住"正在看哪个账户"：'' = 聚合，否则是账户 id。
 * 用 per-channel 的映射而不是一个全局选择器 —— 不同渠道的账户集合互不相干。
 */
const accountPick = reactive<Record<string, string>>({})

/** 当前展示的窗口/余额：选了账户就用该账户的，否则用聚合值 */
function windowsFor(s: UsageSnapshot) {
  const id = accountPick[s.channelId]
  const acc = id ? s.accounts.find((a) => a.accountId === id) : null
  return acc ? acc.windows : s.windows
}

function balancesFor(s: UsageSnapshot) {
  const id = accountPick[s.channelId]
  const acc = id ? s.accounts.find((a) => a.accountId === id) : null
  return acc ? acc.balances : s.balances
}

function accountOptions(s: UsageSnapshot) {
  return [
    { value: '', label: t('usage.aggregate') },
    ...s.accounts.map((a) => ({ value: a.accountId, label: a.accountName }))
  ]
}

/**
 * 窗口按**时间跨度升序**：5 小时 → 每周 → 每月。
 *
 * 这是人读限额的自然顺序。注意排序**不能**再兼职"窄屏留哪一条"——
 * 两件事要求相反（显示由短到长，窄屏要留最紧的），
 * 所以窄屏的选择改用 `is-tightest` 标记，见模板。
 */
const WINDOW_SPAN: Record<string, number> = {
  interval: 0, // MiniMax 的「当前周期」，跨度与 5 小时同类
  fiveHour: 0,
  weekly: 1,
  monthly: 2
}

function windowSpanRank(key: string): number {
  const base = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
  return WINDOW_SPAN[base] ?? 99
}

function orderedWindows<T extends { key: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => windowSpanRank(a.key) - windowSpanRank(b.key))
}

/** 已用百分比最高的那条窗口键 —— 窄屏只显示它 */
function tightestWindowKey(list: { key: string; used: number; total: number }[]): string {
  if (list.length === 0) return ''
  return [...list].sort(
    (a, b) => quotaPercent(b.used, b.total) - quotaPercent(a.used, a.total)
  )[0]!.key
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

async function loadUsage(): Promise<void> {
  if (!isAdmin.value) {
    usageLoading.value = false
    return
  }
  usageLoading.value = true
  try {
    const res = await api.get<{ providers: UsageSnapshot[] }>('/api/usage')
    usageSnapshots.value = res.providers
  } catch {
    // 概览是次要信息，拿不到就不显示这张卡，不打扰用户
    usageSnapshots.value = []
  } finally {
    // 成功 / 失败都要收起骨架 —— 失败时展示的是空态而不是永久骨架
    usageLoading.value = false
  }
}

// ---------------------------------------------------------------- Token 总量

/** `1.6B` + `1,638M`：大数先给 B，紧跟着的 M 才是人能对上号的量级 */
const tokenTotals = computed(() => {
  const n = stats.value?.totals.tokens ?? 0
  return {
    main: formatCompact(n),
    alt: n >= 1e9 ? `${formatNumber(Math.round(n / 1e6))}M` : ''
  }
})

const tokenStatEl = ref<HTMLElement | null>(null)
const tokenStatWidth = ref(0)

/**
 * 量文字宽度用 canvas。
 *
 * 不用「先渲染、溢出就收起来」那套：它让"是否显示"与"容器宽度"互相依赖，
 * 收起后内容变短、又可能重新放得下，容易来回抖。这里状态是单向的：
 * 宽度 → 是否放得下。
 */
/**
 * 对照值的字号比例。
 * **必须与 CSS 里 .stat-alt 的 font-size 一致** —— 否则量出来的宽度与真实渲染对不上，
 * 「放不下就收起」的判定就会失准。
 */
const TOKEN_ALT_SCALE = 0.75

/** 量文字宽度；`scale` 用于对照值那种更小的字号 */
function measureTextWidth(text: string, el: HTMLElement | null, scale = 1): number {
  if (!el) return 0
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return 0
  const cs = getComputedStyle(el)
  const size = parseFloat(cs.fontSize) * scale
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`
  return ctx.measureText(text).width
}

const tokenAltVisible = computed(() => {
  if (!tokenTotals.value.alt) return false
  // 还没量到宽度时先显示，避免首帧闪一下
  if (tokenStatWidth.value <= 0) return true
  // 主值与对照值字号不同（对照值是 0.62em），分开量才准
  const mainW = measureTextWidth(tokenTotals.value.main, tokenStatEl.value)
  // 带一个前导空格来量：.stat-alt 的 margin-left 是 0.25em，
  // 而一个空格在这个字号下正好也是 0.25em 左右 —— 用同一套度量，避免各算各的
  const altW = measureTextWidth(' ' + tokenTotals.value.alt, tokenStatEl.value, TOKEN_ALT_SCALE)
  return mainW + altW <= tokenStatWidth.value
})

let tokenStatObserver: ResizeObserver | null = null

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
    return (
      new URLSearchParams({
        range: 'custom',
        from: new Date(appliedCustom.value.from).toISOString(),
        to: new Date(appliedCustom.value.to).toISOString()
      }).toString() +
      '&' +
      tzQueryParam()
    )
  }
  return 'range=' + preset.value + '&' + tzQueryParam()
}

/** 本次统计实际使用的时区：以服务端回报为准（它可能回落到网关设置） */
const effectiveTz = computed(() => stats.value?.timezone ?? CLIENT_TZ)

/**
 * 使用频率热力图。
 *
 * **按需请求**：只有切到「使用频率」才拉；结果连同 range query 一起缓存，
 * 切回趋势图再切回来不会重复打接口。range 变了缓存键自然对不上，
 * 下次切过去时重新请求（正在看热力图时由 load() 直接重新请求）。
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
 * 换范围专用：先丢掉旧范围的缓存键，再按新范围取数。
 *
 * 只靠 ensureHeatmap() 也能发出请求（range 变了，key 对不上），
 * 但新数据回来之前界面上会挂着上一范围的热力图 —— 那是错的数字。
 * 这里先清空让卡片回到 loading；路上还没回来的旧请求由 heatmapSeq 作废。
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
 *
 * 必须在 `preset` 已经改好之后调用 —— loadHeatmap() 用的是 rangeQuery()，
 * 拿的还是 preset 的当前值；用旧 preset 去请求就会拉到错范围的热力图。
 */
function applyTrendViewForRange(): void {
  trendView.value = trendViewFor(preset.value)
  if (trendView.value !== 'heatmap') return
  // 已经缓存了同一范围（切走再切回）就直接复用，否则清掉旧范围的再拉
  if (heatmapKey.value === rangeQuery()) return
  reloadHeatmap()
}

/**
 * 卡片右上角显示的粒度。
 * 趋势图按 series 的四值（hour/day/week/halfmonth）；
 * 热力图是二维矩阵，每格时长由组件自己写在脚注里，这里不再重复。
 */
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

async function load(): Promise<void> {
  loading.value = true
  // 当前正停在热力图：切范围 / 点刷新都要拿新数据。
  // 停在趋势图时不动热力图缓存，交给切过去时的 ensureHeatmap 判定。
  if (trendView.value === 'heatmap') void loadHeatmap()
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
    // 顺序要紧：preset / appliedCustom 改完再套视图，热力图才会按新范围请求
    applyTrendViewForRange()
    void load()
    return
  }
  applyTrendViewForRange()
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
  // 区间变了就是换范围：同样按 custom 条目恢复视图（在 appliedCustom 改完之后，
  // 否则热力图会带着旧区间去请求）
  applyTrendViewForRange()
  void load()
}

function go(id: string): void {
  location.hash = '#/' + id
}

onMounted(() => {
  // 先恢复偏好，再加载 —— 否则首屏会先按默认值渲染一次。
  // 视图必须在 restoreRange() **之后**读：它要按恢复出来的范围取自己那条记录，
  // 反过来会先按今日的默认 chart 渲染一帧，热力图用户能看见闪一下。
  restoreRange()
  loadTopSort()
  loadTrendViews()
  trendView.value = trendViewFor(preset.value)
  void loadUsage()
  void load()

  // 卡片宽度变化时重新判断「M 对照值」放不放得下
  const el = tokenStatEl.value
  if (el) {
    tokenStatWidth.value = el.clientWidth
    tokenStatObserver = new ResizeObserver((entries) => {
      tokenStatWidth.value = entries[0]?.contentRect.width ?? 0
    })
    tokenStatObserver.observe(el)
  }
})

onBeforeUnmount(() => tokenStatObserver?.disconnect())
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
          <template v-if="activeGranularity">
            <span>·</span>
            <span>{{ activeGranularity }}</span>
          </template>
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
        <!-- 达到 B 量级时补一个 M 单位的对照值；放不下就只留 B -->
        <div ref="tokenStatEl" class="stat-value stat-value-pair">
          <span>{{ tokenTotals.main }}</span>
          <span v-if="tokenAltVisible" class="stat-alt">{{ tokenTotals.alt }}</span>
        </div>
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
        <div class="row row-wrap" style="gap: 10px; align-items: baseline; min-width: 0">
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
        <!-- 右上角：趋势图 / 使用频率，同一张卡片内切换 -->
        <div class="segmented segmented-sm" role="group" :aria-label="t('overview.trend')">
          <button
            :class="{ on: trendView === 'chart' }"
            @click="setTrendView('chart')"
          >
            {{ t('overview.trendViewChart') }}
          </button>
          <button
            :class="{ on: trendView === 'heatmap' }"
            @click="setTrendView('heatmap')"
          >
            {{ t('overview.trendViewHeatmap') }}
          </button>
        </div>
      </div>

      <div v-if="loading" class="loading">{{ t('common.loading') }}</div>
      <UsageTrendChart v-else-if="trendView === 'chart'" :series="series" />
      <div v-else-if="heatmapLoading" class="loading">{{ t('common.loading') }}</div>
      <UsageHeatmap v-else-if="heatmap" :data="heatmap" />
      <div v-else class="empty">{{ t('common.empty') }}</div>
    </div>

    <div class="grid grid-3">
      <div v-for="block in topBlocks" :key="block.key" class="card">
        <div class="card-head">
          <div class="card-title">{{ block.title }}</div>
          <!-- 右上角：切换排序依据（本地重排，不重新请求） -->
          <div class="segmented segmented-sm" :title="t('overview.sortHint')">
            <button
              :class="{ on: topSort[block.key] === 'requests' }"
              @click="setTopSort(block.key, 'requests')"
            >
              {{ t('overview.sortByRequestsShort') }}
            </button>
            <button
              :class="{ on: topSort[block.key] === 'tokens' }"
              @click="setTopSort(block.key, 'tokens')"
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

      <!-- 加载中：与真实卡片同构的骨架（3 张，名称 / 余额 / 两条窗口） -->
      <div v-if="usageLoading" class="usage-grid" aria-hidden="true">
        <div v-for="n in 3" :key="n" class="usage-cell sk-cell">
          <div class="sk-head">
            <span class="sk sk-name"></span>
            <span class="sk sk-tag"></span>
          </div>
          <span class="sk sk-balance"></span>
          <div class="usage-windows sk-windows">
            <div v-for="w in 2" :key="w" class="sk-window">
              <div class="sk-window-head">
                <span class="sk sk-window-label"></span>
                <span class="sk sk-window-value"></span>
              </div>
              <div class="sk sk-window-track"></div>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="usageOk.length === 0" class="empty">
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
            <!-- 多账户：提示额度是几个号合起来的 -->
            <template v-if="s.accounts.length > 1">
              <span class="dim nowrap" style="font-size: 11px">
                {{ t('usage.accountCount', { n: s.accounts.length }) }}
              </span>
              <span class="spacer" />
              <!-- 每张卡各自切换：聚合 / 某个账户 -->
              <span style="width: 118px">
                <PSelect
                  :model-value="accountPick[s.channelId] ?? ''"
                  :options="accountOptions(s)"
                  size="sm"
                  align="end"
                  @update:model-value="(v: string) => (accountPick[s.channelId] = v)"
                />
              </span>
            </template>
          </div>

          <!-- 金额余额（DeepSeek / Moonshot 这类） -->
          <div v-if="balancesFor(s).length" class="mono usage-cell-balance">
            {{
              balancesFor(s)[0]!.remaining.toLocaleString('en-US', { maximumFractionDigits: 4 })
            }}
            <span class="dim">{{ balancesFor(s)[0]!.currency }}</span>
          </div>

          <!-- 额度窗口：宽屏全列，窄屏只留最紧的那条 -->
          <div v-if="orderedWindows(windowsFor(s)).length" class="usage-windows">
            <div
              v-for="w in orderedWindows(windowsFor(s))"
              :key="w.key"
              class="usage-window"
              :class="{ 'is-tightest': w.key === tightestWindowKey(windowsFor(s)) }"
            >
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
