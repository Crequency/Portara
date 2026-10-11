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

/** 柱高百分比：各自序列归一化，最小 2% 保证「有值就看得见」 */
function barHeight(value: number, max: number): string {
  return Math.max(2, (value / max) * 100) + '%'
}

/** 悬浮说明：一次给全该时段的三个数字 */
function bucketTip(p: SeriesPoint): string {
  return [
    p.day,
    `${t('overview.legendRequests')} ${formatNumber(p.requests)}`,
    `${t('overview.legendTokens')} ${formatNumber(p.tokens)}`,
    `${t('overview.failed')} ${formatNumber(p.errors)}`
  ].join(' · ')
}

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

/** 该渠道最"紧"的窗口（已用百分比最高）—— 概览只展示这一个重点 */
function tightestWindow(s: UsageSnapshot) {
  if (!s.windows || s.windows.length === 0) return null
  return [...s.windows].sort(
    (a, b) => quotaPercent(b.used, b.total) - quotaPercent(a.used, a.total)
  )[0]!
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
  void load()
}

function go(id: string): void {
  location.hash = '#/' + id
}

onMounted(() => {
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
          <span class="spacer" />
          <span class="dim" style="font-size: 11px">{{ t('overview.dualScale') }}</span>
        </div>

        <div class="chart">
          <div v-for="p in series" :key="p.day" class="chart-col">
            <!-- 时段少时把数字标出来；时段多（如 30 天）留给悬浮说明，避免挤成一团 -->
            <div v-if="series.length <= 14" class="chart-value">
              <span class="cv-req">{{ p.requests }}</span>
              <span class="cv-tok">{{ formatCompact(p.tokens) }}</span>
            </div>
            <div class="chart-bars">
              <div
                class="chart-bar chart-bar-req"
                :class="{ 'chart-bar-err': p.errors > 0 }"
                :style="{ height: barHeight(p.requests, maxRequests) }"
                :title="bucketTip(p)"
              />
              <div
                class="chart-bar chart-bar-tok"
                :style="{ height: barHeight(p.tokens, maxTokens) }"
                :title="bucketTip(p)"
              />
            </div>
            <div class="chart-label">
              {{ p.day }}
              <span
                v-if="p.errors > 0"
                class="chart-err-dot"
                :title="t('overview.failed') + ' ' + formatNumber(p.errors)"
              >•</span>
            </div>
          </div>
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

      <div v-else class="form-grid" style="gap: 12px">
        <div
          v-for="s in usageOk"
          :key="s.channelId"
          class="row row-wrap"
          style="gap: 10px; font-size: 12.5px"
        >
          <span style="min-width: 190px">{{ s.channelName }}</span>
          <span class="tag">{{ s.adapter }}</span>

          <span class="spacer" />

          <!-- 金额余额（DeepSeek / Moonshot 这类） -->
          <span v-if="primaryBalance(s)" class="mono nowrap">
            {{
              primaryBalance(s)!.remaining.toLocaleString('en-US', { maximumFractionDigits: 4 })
            }}
            <span class="dim">{{ primaryBalance(s)!.currency }}</span>
          </span>

          <!-- 最紧的那条额度窗口（CommandCode / MiniMax 这类） -->
          <template v-if="tightestWindow(s)">
            <span class="nowrap" style="min-width: 150px; text-align: right">
              {{ windowLabel(tightestWindow(s)!.key) }}
              <span
                :style="{
                  color: quotaColor(
                    quotaPercent(tightestWindow(s)!.used, tightestWindow(s)!.total),
                    tightestWindow(s)!.exceeded
                  )
                }"
              >
                {{ quotaPercent(tightestWindow(s)!.used, tightestWindow(s)!.total) }}%
              </span>
            </span>
            <span
              style="width: 90px; height: 5px; background: var(--bg-elev-2); border-radius: 3px"
            >
              <span
                :style="{
                  display: 'block',
                  width:
                    quotaPercent(tightestWindow(s)!.used, tightestWindow(s)!.total) + '%',
                  height: '100%',
                  background: quotaColor(
                    quotaPercent(tightestWindow(s)!.used, tightestWindow(s)!.total),
                    tightestWindow(s)!.exceeded
                  ),
                  borderRadius: '3px'
                }"
              />
            </span>
          </template>
        </div>

        <div v-if="usageFailedCount > 0" class="dim" style="font-size: 11.5px">
          {{ t('overview.usageFailed', { n: usageFailedCount }) }}
        </div>
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
