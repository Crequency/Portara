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
import { formatCompact, formatLatency, formatNumber, formatPercent, formatTime } from '../format'
import { useI18n } from '../i18n'
import { toast } from '../toast'

defineProps<{ user?: User }>()

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

const maxRequests = computed(() => Math.max(1, ...series.value.map((p) => p.requests)))

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

const topBlocks = computed(() => [
  { title: t('overview.topModels'), rows: stats.value?.topModels ?? [] },
  { title: t('overview.topChannels'), rows: stats.value?.topChannels ?? [] },
  { title: t('overview.topKeys'), rows: stats.value?.topKeys ?? [] }
])

function rangeQuery(): string {
  if (preset.value === 'custom' && appliedCustom.value) {
    return new URLSearchParams({
      range: 'custom',
      from: new Date(appliedCustom.value.from).toISOString(),
      to: new Date(appliedCustom.value.to).toISOString()
    }).toString()
  }
  return 'range=' + preset.value
}

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

function maxOf(list: TopEntry[]): number {
  return Math.max(1, ...list.map((x) => x.requests))
}

onMounted(load)
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
      <div v-else class="chart">
        <div v-for="p in series" :key="p.day" class="chart-col">
          <div class="chart-value">{{ p.requests }}</div>
          <div
            class="chart-bar"
            :class="{ 'chart-bar-err': p.errors > 0 }"
            :style="{ height: Math.max(2, (p.requests / maxRequests) * 100) + '%' }"
            :title="p.day + '：' + p.requests + ' / ' + p.tokens + ' tok / ' + p.errors"
          />
          <div class="chart-label">{{ p.day }}</div>
        </div>
      </div>
    </div>

    <div class="grid grid-3">
      <div v-for="block in topBlocks" :key="block.title" class="card">
        <div class="card-head">
          <div class="card-title">{{ block.title }}</div>
        </div>
        <div v-if="block.rows.length === 0" class="empty">{{ t('common.empty') }}</div>
        <div v-else class="form-grid" style="gap: 10px">
          <div v-for="row in block.rows" :key="row.name">
            <div class="row-between" style="font-size: 12.5px">
              <span class="mono" style="overflow: hidden; text-overflow: ellipsis">
                {{ row.name }}
              </span>
              <span class="dim nowrap">
                {{ t('overview.times', { n: row.requests }) }} ·
                {{ formatCompact(row.tokens) }} tok
              </span>
            </div>
            <div style="height: 4px; background: var(--bg-elev-2); border-radius: 3px; margin-top: 4px">
              <div
                :style="{
                  width: (row.requests / maxOf(block.rows)) * 100 + '%',
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
