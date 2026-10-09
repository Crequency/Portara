<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  api,
  type RangePreset,
  type RequestLog,
  type SeriesPoint,
  type StatsOverview,
  type StatsSeries,
  type TopEntry,
  type User
} from '../api'
import {
  formatCompact,
  formatLatency,
  formatNumber,
  formatPercent,
  formatTime
} from '../format'
import { toast } from '../toast'

defineProps<{ user?: User }>()

const PRESETS: { id: RangePreset; label: string }[] = [
  { id: 'today', label: '今日' },
  { id: '7d', label: '近 7 天' },
  { id: '30d', label: '近一个月' },
  { id: 'custom', label: '自定义' }
]

const preset = ref<RangePreset>('today')
const customFrom = ref('')
const customTo = ref('')
const appliedCustom = ref<{ from: string; to: string } | null>(null)

const stats = ref<StatsOverview | null>(null)
const series = ref<SeriesPoint[]>([])
const granularity = ref<'hour' | 'day'>('hour')
const recent = ref<RequestLog[]>([])
const loading = ref(true)

const maxRequests = computed(() => Math.max(1, ...series.value.map((p) => p.requests)))

const rangeLabel = computed(() => {
  if (!stats.value) return ''
  const from = new Date(stats.value.range.from)
  const to = new Date(stats.value.range.to)
  const fmt = (d: Date) =>
    `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(
      d.getHours()
    ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${fmt(from)} → ${fmt(to)}`
})

/** 组装查询串：自定义范围用 datetime-local 的值 */
function rangeQuery(): string {
  if (preset.value === 'custom' && appliedCustom.value) {
    const p = new URLSearchParams({
      range: 'custom',
      from: new Date(appliedCustom.value.from).toISOString(),
      to: new Date(appliedCustom.value.to).toISOString()
    })
    return p.toString()
  }
  return `range=${preset.value}`
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const q = rangeQuery()
    const [overview, s, logs] = await Promise.all([
      api.get<StatsOverview>(`/api/stats/overview?${q}`),
      api.get<StatsSeries>(`/api/stats/series?${q}`),
      api.get<{ logs: RequestLog[] }>('/api/logs?limit=8')
    ])
    stats.value = overview
    series.value = s.series
    granularity.value = s.granularity
    recent.value = logs.logs
  } catch (err) {
    toast.error(err instanceof Error ? err.message : '加载统计失败')
  } finally {
    loading.value = false
  }
}

function choosePreset(id: RangePreset): void {
  preset.value = id
  if (id === 'custom') {
    // 默认给一个「最近 24 小时」，省得用户面对两个空输入框
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
    toast.error('请填写起止时间')
    return
  }
  if (new Date(customFrom.value) >= new Date(customTo.value)) {
    toast.error('起始时间必须早于结束时间')
    return
  }
  appliedCustom.value = { from: customFrom.value, to: customTo.value }
  void load()
}

function maxOf(list: TopEntry[]): number {
  return Math.max(1, ...list.map((x) => x.requests))
}

onMounted(load)
</script>

<template>
  <div>
    <div class="card" style="margin-bottom: 14px">
      <div class="row row-wrap">
        <button
          v-for="p in PRESETS"
          :key="p.id"
          class="btn btn-sm"
          :class="{ 'btn-primary': preset === p.id }"
          @click="choosePreset(p.id)"
        >
          {{ p.label }}
        </button>

        <template v-if="preset === 'custom'">
          <input
            v-model="customFrom"
            type="datetime-local"
            style="width: 190px"
            @change="applyCustom"
          />
          <span class="dim">→</span>
          <input
            v-model="customTo"
            type="datetime-local"
            style="width: 190px"
            @change="applyCustom"
          />
          <button class="btn btn-sm" @click="applyCustom">应用</button>
        </template>

        <span class="spacer" />
        <span class="dim" style="font-size: 12px">
          {{ rangeLabel }} · {{ granularity === 'hour' ? '按小时' : '按天' }} ·
          <button class="btn btn-ghost btn-sm" :disabled="loading" @click="load">刷新</button>
        </span>
      </div>
    </div>

    <div class="grid grid-4">
      <div class="stat">
        <div class="stat-label">请求数</div>
        <div class="stat-value">{{ formatNumber(stats?.totals.requests) }}</div>
        <div class="stat-hint">
          失败 {{ formatNumber(stats?.totals.errors) }} ·
          {{ formatPercent(stats?.totals.errorRate ?? 0) }}
        </div>
      </div>
      <div class="stat">
        <div class="stat-label">Token 用量</div>
        <div class="stat-value">{{ formatCompact(stats?.totals.tokens) }}</div>
        <div class="stat-hint">
          入 {{ formatCompact(stats?.totals.promptTokens) }} · 出
          {{ formatCompact(stats?.totals.completionTokens) }}
        </div>
      </div>
      <div class="stat">
        <div class="stat-label">平均延迟</div>
        <div class="stat-value">{{ formatLatency(stats?.totals.avgLatencyMs) }}</div>
        <div class="stat-hint">P95 {{ formatLatency(stats?.totals.p95LatencyMs) }}</div>
      </div>
      <div class="stat">
        <div class="stat-label">估算计量</div>
        <div class="stat-value">{{ formatNumber(stats?.totals.estimated) }}</div>
        <div class="stat-hint">上游未返回 usage 的请求数</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-title">请求量趋势</div>
        <span class="dim" style="font-size: 12px">
          渠道 {{ formatNumber(stats?.resources.activeChannels) }}/{{ formatNumber(stats?.resources.channels) }}
          · 有效密钥 {{ formatNumber(stats?.resources.keys) }}
          · 用户 {{ formatNumber(stats?.resources.users) }}
        </span>
      </div>

      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="series.length === 0" class="empty">该时间范围内暂无数据</div>
      <div v-else class="chart">
        <div v-for="p in series" :key="p.day" class="chart-col">
          <div class="chart-value">{{ p.requests }}</div>
          <div
            class="chart-bar"
            :class="{ 'chart-bar-err': p.errors > 0 }"
            :style="{ height: `${Math.max(2, (p.requests / maxRequests) * 100)}%` }"
            :title="`${p.day}：${p.requests} 次请求 / ${p.tokens} token / ${p.errors} 次失败`"
          />
          <div class="chart-label">{{ p.day }}</div>
        </div>
      </div>
    </div>

    <div class="grid grid-2" style="margin-top: 16px">
      <div v-for="block in [
        { title: 'Top 模型', rows: stats?.topModels ?? [] },
        { title: 'Top 渠道', rows: stats?.topChannels ?? [] },
        { title: 'Top 密钥', rows: stats?.topKeys ?? [] }
      ]" :key="block.title" class="card" style="margin-top: 0">
        <div class="card-head">
          <div class="card-title">{{ block.title }}</div>
        </div>
        <div v-if="block.rows.length === 0" class="empty">暂无数据</div>
        <div v-else class="form-grid" style="gap: 9px">
          <div v-for="row in block.rows" :key="row.name">
            <div class="row-between" style="font-size: 12.5px">
              <span class="mono" style="overflow: hidden; text-overflow: ellipsis">
                {{ row.name }}
              </span>
              <span class="dim nowrap">
                {{ row.requests }} 次 · {{ formatCompact(row.tokens) }} tok
              </span>
            </div>
            <div
              style="height: 4px; background: var(--bg-elev-2); border-radius: 3px; margin-top: 4px"
            >
              <div
                :style="{
                  width: `${(row.requests / maxOf(block.rows)) * 100}%`,
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

    <div class="card">
      <div class="card-head">
        <div class="card-title">最近请求</div>
        <span class="dim" style="font-size: 12px">仅元数据，不含请求正文</span>
      </div>

      <div v-if="recent.length === 0" class="empty">
        还没有请求。签发一个 Key，然后调用 <span class="mono">/v1/chat/completions</span>。
      </div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>密钥</th>
              <th>渠道</th>
              <th>模型</th>
              <th>状态</th>
              <th>Token</th>
              <th>耗时</th>
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
                <span v-if="log.estimated" class="badge badge-warn">估</span>
              </td>
              <td class="nowrap">{{ formatLatency(log.latencyMs) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
