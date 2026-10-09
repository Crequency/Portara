<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  api,
  type Overview,
  type RequestLog,
  type SeriesPoint,
  type User
} from '../api'
import { formatCompact, formatLatency, formatNumber, formatTime } from '../format'
import { toast } from '../toast'

defineProps<{ user?: User }>()

const stats = ref<Overview | null>(null)
const series = ref<SeriesPoint[]>([])
const recent = ref<RequestLog[]>([])
const loading = ref(true)

const maxRequests = computed(() =>
  Math.max(1, ...series.value.map((p) => p.requests))
)

async function load(): Promise<void> {
  loading.value = true
  try {
    const [overview, s, logs] = await Promise.all([
      api.get<Overview>('/api/stats/overview'),
      api.get<{ series: SeriesPoint[] }>('/api/stats/series?days=7'),
      api.get<{ logs: RequestLog[] }>('/api/logs?limit=8')
    ])
    stats.value = overview
    series.value = s.series
    recent.value = logs.logs
  } catch {
    toast.error('加载概览数据失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="grid grid-4">
      <div class="stat">
        <div class="stat-label">今日请求</div>
        <div class="stat-value">{{ formatNumber(stats?.todayRequests) }}</div>
        <div class="stat-hint">
          累计 {{ formatCompact(stats?.totalRequests) }} · 失败
          {{ formatNumber(stats?.todayErrors) }}
        </div>
      </div>
      <div class="stat">
        <div class="stat-label">今日 Token</div>
        <div class="stat-value">{{ formatCompact(stats?.todayTokens) }}</div>
        <div class="stat-hint">按上游返回的 usage 累计</div>
      </div>
      <div class="stat">
        <div class="stat-label">上游渠道</div>
        <div class="stat-value">{{ formatNumber(stats?.channels) }}</div>
        <div class="stat-hint">启用中 {{ formatNumber(stats?.activeChannels) }}</div>
      </div>
      <div class="stat">
        <div class="stat-label">有效密钥</div>
        <div class="stat-value">{{ formatNumber(stats?.keys) }}</div>
        <div class="stat-hint">用户 {{ formatNumber(stats?.users) }} 个</div>
      </div>
    </div>

    <div class="card" style="margin-top: 16px">
      <div class="card-head">
        <div class="card-title">近 7 天请求量</div>
        <button class="btn btn-sm" :disabled="loading" @click="load">刷新</button>
      </div>

      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="series.length === 0" class="empty">暂无数据</div>
      <div v-else class="chart">
        <div v-for="p in series" :key="p.day" class="chart-col">
          <div class="chart-value">{{ p.requests }}</div>
          <div
            class="chart-bar"
            :style="{ height: `${Math.max(2, (p.requests / maxRequests) * 100)}%` }"
            :title="`${p.day}：${p.requests} 次请求 / ${p.tokens} token`"
          />
          <div class="chart-label">{{ p.day }}</div>
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
                <span
                  class="badge"
                  :class="log.statusCode < 400 ? 'badge-ok' : 'badge-err'"
                >
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
