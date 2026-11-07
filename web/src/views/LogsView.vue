<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, type RequestLog, type User } from '../api'
import PSelect from '../components/PSelect.vue'
import { formatLatency, formatNumber, formatTime } from '../format'
import { useI18n } from '../i18n'
import { toast } from '../toast'

const props = defineProps<{ user?: User }>()

const { t } = useI18n()

/** 成本 / 客户端 IP / 会话哈希是管理面字段；操作员只看到自己的流量 */
const isAdmin = computed(() => props.user?.role === 'admin')

const logs = ref<RequestLog[]>([])
const loading = ref(true)
const total = ref(0)
const limit = ref(25)
const offset = ref(0)
const status = ref<'all' | 'ok' | 'error'>('all')
const model = ref('')

const statusOptions = computed(() => [
  { value: 'all', label: t('logs.allStatus') },
  { value: 'ok', label: t('logs.okStatus') },
  { value: 'error', label: t('logs.errStatus') }
])

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
      '/api/logs?' + params.toString()
    )
    logs.value = res.logs
    total.value = res.total
  } catch {
    toast.error(t('logs.loadFailed'))
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
  <!-- fill-view：卡片撑满内容区，表格在内部滚动、表头吸顶、分页常驻底部 -->
  <div class="card fill-view">
    <div class="card-head">
      <div>
        <div class="card-title">
          {{ t('logs.title') }} · {{ t('logs.count', { n: formatNumber(total) }) }}
        </div>
        <div v-if="!isAdmin" class="dim" style="font-size: 12px">
          {{ t('logs.tenantHint') }}
        </div>
      </div>
      <button class="btn btn-sm" @click="load">{{ t('common.refresh') }}</button>
    </div>

    <div class="row row-wrap" style="margin-bottom: 14px">
      <div style="width: 160px">
        <PSelect v-model="status" :options="statusOptions" @update:model-value="applyFilter" />
      </div>
      <div style="width: 220px">
        <input v-model="model" :placeholder="t('logs.modelFilter')" @keyup.enter="applyFilter" />
      </div>
      <button class="btn btn-sm" @click="applyFilter">{{ t('logs.query') }}</button>
    </div>

    <div v-if="loading" class="loading fill-rest">{{ t('common.loading') }}</div>
    <div v-else-if="logs.length === 0" class="empty fill-rest">{{ t('logs.empty') }}</div>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ t('logs.time') }}</th>
            <th>{{ t('logs.key') }}</th>
            <th>{{ t('logs.channel') }}</th>
            <th>{{ t('logs.path') }}</th>
            <th>{{ t('logs.model') }}</th>
            <th>{{ t('logs.status') }}</th>
            <th>{{ t('logs.tokens') }}</th>
            <th>{{ t('logs.timing') }}</th>
            <!-- 来源 IP / 会话哈希只属于管理面；操作员的 DTO 里没有这两个字段 -->
            <template v-if="isAdmin">
              <th>{{ t('logs.ip') }}</th>
              <th :title="t('logs.sessionHint')">{{ t('logs.session') }}</th>
            </template>
          </tr>
        </thead>
        <tbody>
          <template v-for="log in logs" :key="log.id">
            <tr>
              <td class="nowrap dim">{{ formatTime(log.ts) }}</td>
              <td>{{ log.apiKeyName || '—' }}</td>
              <td>
                {{ log.channelName || '—' }}
                <!-- 哪个上游账户服务的：同一个渠道多把 Key 时，这是唯一能区分的线索 -->
                <div v-if="log.accountName" class="dim" style="font-size: 11px">
                  {{ log.accountName }}
                </div>
              </td>
              <td class="mono dim">{{ log.path }}</td>
              <td class="mono">{{ log.model || '—' }}</td>
              <td>
                <span class="badge" :class="log.statusCode < 400 ? 'badge-ok' : 'badge-err'">
                  {{ log.statusCode }}
                </span>
              </td>
              <td class="nowrap">
                {{ formatNumber(log.promptTokens) }} / {{ formatNumber(log.completionTokens) }}
                <span v-if="log.estimated" class="badge badge-warn" :title="t('logs.estimatedHint')">
                  {{ t('logs.estimated') }}
                </span>
              </td>
              <td class="nowrap">
                {{ log.ttftMs === null ? '—' : formatLatency(log.ttftMs) }} /
                {{ formatLatency(log.latencyMs) }}
              </td>
              <template v-if="isAdmin">
                <td class="mono dim">{{ log.clientIp ?? '—' }}</td>
                <!--
                  会话哈希（前 8 位）：用来核对「同一会话是不是一直落在同一渠道」。
                  空 = 本次请求没有会话键（未启用亲和）。
                -->
                <td class="mono dim">{{ log.sessionHash || '—' }}</td>
              </template>
            </tr>
            <tr v-if="log.error">
              <td :colspan="isAdmin ? 10 : 8" class="err-text" style="padding-top: 0">
                ↳ {{ log.error }}
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div class="pager" style="flex: 0 0 auto">
      <span>
        {{
          t('logs.pageInfo', {
            from: offset + 1,
            to: Math.min(offset + limit, total),
            total: formatNumber(total)
          })
        }}
      </span>
      <span class="row">
        <button class="btn btn-sm" :disabled="offset === 0" @click="prev">
          {{ t('logs.prev') }}
        </button>
        <button class="btn btn-sm" :disabled="offset + limit >= total" @click="next">
          {{ t('logs.next') }}
        </button>
      </span>
    </div>
  </div>
</template>
