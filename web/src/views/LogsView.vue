<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, type RequestLog, type User } from '../api'
import { formatLatency, formatNumber, formatTime } from '../format'
import { toast } from '../toast'

defineProps<{ user?: User }>()

const logs = ref<RequestLog[]>([])
const loading = ref(true)
const total = ref(0)
const limit = ref(25)
const offset = ref(0)
const status = ref<'all' | 'ok' | 'error'>('all')
const model = ref('')

async function load(): Promise<void> {
  loading.value = true
  try {
    const params = new URLSearchParams({
      limit: String(limit.value),
      offset: String(offset.value),
      status: status.value
    })
    if (model.value.trim()) params.set('model', model.value.trim())

    const res = await api.get<{ logs: RequestLog[]; total: number }>(
      `/api/logs?${params.toString()}`
    )
    logs.value = res.logs
    total.value = res.total
  } catch {
    toast.error('加载日志失败')
  } finally {
    loading.value = false
  }
}

function applyFilter(): void {
  offset.value = 0
  void load()
}

function prev(): void {
  offset.value = Math.max(0, offset.value - limit.value)
  void load()
}

function next(): void {
  if (offset.value + limit.value >= total.value) return
  offset.value += limit.value
  void load()
}

onMounted(load)
</script>

<template>
  <div class="card">
    <div class="card-head">
      <div class="card-title">请求日志（{{ formatNumber(total) }} 条）</div>
      <button class="btn btn-sm" @click="load">刷新</button>
    </div>

    <div class="row row-wrap" style="margin-bottom: 14px">
      <div class="field" style="width: 150px">
        <select v-model="status" @change="applyFilter">
          <option value="all">全部状态</option>
          <option value="ok">成功（&lt;400）</option>
          <option value="error">失败（≥400）</option>
        </select>
      </div>
      <div class="field" style="width: 220px">
        <input
          v-model="model"
          placeholder="按模型过滤…"
          @keyup.enter="applyFilter"
        />
      </div>
      <button class="btn btn-sm" @click="applyFilter">查询</button>
    </div>

    <div v-if="loading" class="loading">加载中…</div>
    <div v-else-if="logs.length === 0" class="empty">没有匹配的请求记录。</div>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>密钥</th>
            <th>渠道</th>
            <th>路径</th>
            <th>模型</th>
            <th>状态</th>
            <th>Token（入/出）</th>
            <th>首字节 / 总耗时</th>
            <th>来源 IP</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in logs" :key="log.id">
            <td class="nowrap dim">{{ formatTime(log.ts) }}</td>
            <td>{{ log.apiKeyName || '—' }}</td>
            <td>{{ log.channelName || '—' }}</td>
            <td class="mono dim">{{ log.path }}</td>
            <td class="mono">{{ log.model || '—' }}</td>
            <td>
              <span class="badge" :class="log.statusCode < 400 ? 'badge-ok' : 'badge-err'">
                {{ log.statusCode }}
              </span>
            </td>
            <td class="nowrap">
              {{ formatNumber(log.promptTokens) }} / {{ formatNumber(log.completionTokens) }}
              <span v-if="log.estimated" class="badge badge-warn" title="上游未返回 usage，按字节量估算">估</span>
            </td>
            <td class="nowrap">
              {{ log.ttftMs === null ? '—' : formatLatency(log.ttftMs) }} /
              {{ formatLatency(log.latencyMs) }}
            </td>
            <td class="mono dim">{{ log.clientIp }}</td>
          </tr>
          <tr v-for="log in logs.filter((l) => l.error)" :key="`e-${log.id}`">
            <td colspan="9" class="err-text" style="padding-top: 0">
              ↳ {{ log.error }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager">
      <span>
        第 {{ offset + 1 }} – {{ Math.min(offset + limit, total) }} 条，共
        {{ formatNumber(total) }} 条
      </span>
      <span class="row">
        <button class="btn btn-sm" :disabled="offset === 0" @click="prev">上一页</button>
        <button
          class="btn btn-sm"
          :disabled="offset + limit >= total"
          @click="next"
        >
          下一页
        </button>
      </span>
    </div>
  </div>
</template>
