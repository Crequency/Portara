<script setup lang="ts">
/**
 * 渠道详情子页面（从上游渠道列表点进来）。
 *
 * 聚合四块信息：基本配置 / 用量统计 / 模型列表（含上下文长度）/ 映射与最近请求。
 * 数据全部走既有接口，仅统计与映射按 channelId 过滤。
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  api,
  ApiError,
  type Channel,
  type ChannelTestResult,
  type ModelMeta,
  type ModelRoute,
  type RangePreset,
  type RequestLog,
  type SeriesPoint,
  type StatsOverview,
  type StatsSeries,
  type User
} from '../api'
import Modal from '../components/Modal.vue'
import PSelect from '../components/PSelect.vue'
import { formatCompact, formatLatency, formatNumber, formatPercent, formatTime } from '../format'
import { useI18n } from '../i18n'
import { toast } from '../toast'

const props = defineProps<{ user?: User; channelId: string }>()

const { t } = useI18n()

const channel = ref<Channel | null>(null)
const routes = ref<ModelRoute[]>([])
const stats = ref<StatsOverview | null>(null)
const series = ref<SeriesPoint[]>([])
const recent = ref<RequestLog[]>([])
const loading = ref(true)
const notFound = ref(false)
const testing = ref(false)

const preset = ref<RangePreset>('7d')

const revealOpen = ref(false)
const revealedKey = ref('')
const revealError = ref('')
const revealing = ref(false)

const isAdmin = (): boolean => props.user?.role === 'admin'

const rangeOptions = computed(() => [
  { value: 'today', label: t('overview.today') },
  { value: '7d', label: t('overview.d7') },
  { value: '30d', label: t('overview.d30') }
])

const maxRequests = computed(() => Math.max(1, ...series.value.map((p) => p.requests)))

/** 上游模型 → 指向它的网关模型 ID 列表 */
const aliasByModel = computed(() => {
  const map = new Map<string, string[]>()
  for (const r of routes.value) {
    const list = map.get(r.upstreamModel) ?? []
    list.push(r.alias)
    map.set(r.upstreamModel, list)
  }
  return map
})

/** 模型列表：把 id 与抓取到的元信息（上下文长度等）合并 */
const modelRows = computed(() => {
  const ch = channel.value
  if (!ch) return []
  const meta = (ch.modelsMeta ?? {}) as Record<string, ModelMeta>
  return ch.models.map((id) => ({
    id,
    meta: meta[id] ?? null,
    aliases: aliasByModel.value.get(id) ?? []
  }))
})

const headerEntries = computed(() => Object.entries(channel.value?.extraHeaders ?? {}))

async function loadChannel(): Promise<void> {
  loading.value = true
  notFound.value = false
  try {
    const [ch, rt] = await Promise.all([
      api.get<{ channel: Channel }>('/api/channels/' + props.channelId),
      api.get<{ routes: ModelRoute[] }>(
        '/api/model-routes?channelId=' + props.channelId
      )
    ])
    channel.value = ch.channel
    routes.value = rt.routes
  } catch {
    notFound.value = true
    channel.value = null
    loading.value = false
    return
  }
  await loadStats()
  loading.value = false
}

async function loadStats(): Promise<void> {
  const q = 'range=' + preset.value + '&channelId=' + props.channelId
  try {
    const [s, se, lg] = await Promise.all([
      api.get<StatsOverview>('/api/stats/overview?' + q),
      api.get<StatsSeries>('/api/stats/series?' + q),
      api.get<{ logs: RequestLog[] }>(
        '/api/logs?channelId=' + props.channelId + '&limit=15'
      )
    ])
    stats.value = s
    series.value = se.series
    recent.value = lg.logs
  } catch {
    toast.error(t('channelDetail.loadFailed'))
  }
}

async function testChannel(): Promise<void> {
  const ch = channel.value
  if (!ch) return
  testing.value = true
  try {
    const res = await api.post<ChannelTestResult>('/api/channels/' + ch.id + '/test')
    ch.lastLatencyMs = res.latencyMs
    ch.lastTestAt = res.testedAt ?? new Date().toISOString()
    ch.lastTestOk = res.ok
    if (res.ok) toast.success(ch.name + ' · ' + res.latencyMs + 'ms')
    else toast.error(ch.name + ' · ' + res.message)
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : t('channels.testFailed'))
  } finally {
    testing.value = false
  }
}

async function revealKey(): Promise<void> {
  const ch = channel.value
  if (!ch) return
  revealOpen.value = true
  revealedKey.value = ''
  revealError.value = ''
  revealing.value = true
  try {
    const res = await api.get<{ key: string }>('/api/channels/' + ch.id + '/reveal')
    revealedKey.value = res.key
  } catch (err) {
    revealError.value = err instanceof ApiError ? err.message : t('channels.revealKeyFailed')
  } finally {
    revealing.value = false
  }
}

function closeReveal(): void {
  revealOpen.value = false
  revealedKey.value = ''
  revealError.value = ''
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('toast.copied'))
  } catch {
    toast.error(t('toast.copyFailed'))
  }
}

function back(): void {
  location.hash = '#/channels'
}

watch(preset, () => void loadStats())
onMounted(loadChannel)
</script>

<template>
  <div v-if="loading" class="loading">{{ t('common.loading') }}</div>

  <div v-else-if="notFound" class="card">
    <div class="empty">{{ t('channelDetail.notFound') }}</div>
    <div class="row" style="justify-content: center">
      <button class="btn btn-sm" @click="back">{{ t('channelDetail.back') }}</button>
    </div>
  </div>

  <div v-else-if="channel" class="stack">
    <!-- 头部 -->
    <div class="card">
      <div class="row row-wrap">
        <button class="btn btn-sm" @click="back">← {{ t('channelDetail.back') }}</button>
        <span class="spacer" />
        <button class="btn btn-sm" :disabled="testing" @click="testChannel">
          {{ testing ? t('common.testing') : t('common.test') }}
        </button>
        <button v-if="isAdmin() && channel.hasApiKey" class="btn btn-sm" @click="revealKey">
          {{ t('channels.revealKey') }}
        </button>
        <button class="btn btn-sm" @click="loadChannel">{{ t('common.refresh') }}</button>
      </div>

      <div class="row row-wrap" style="margin-top: 12px">
        <span style="font-size: 18px; font-weight: 650">{{ channel.name }}</span>
        <span class="badge" :class="channel.status === 'active' ? 'badge-ok' : 'badge-off'">
          {{ channel.status === 'active' ? t('common.enabled') : t('common.disabled') }}
        </span>
        <span class="tag">{{ channel.protocol === 'openai' ? t('channels.protocolOpenai') : channel.protocol }}</span>
        <span v-if="channel.vendor !== 'generic'" class="tag" style="color: var(--accent)">
          {{ channel.vendor }}
        </span>
        <span v-if="channel.lastLatencyMs !== null" class="badge" :class="channel.lastTestOk === false ? 'badge-err' : 'badge-ok'">
          {{ channel.lastLatencyMs }} ms
        </span>
      </div>
    </div>

    <!-- 基本配置 -->
    <div class="card">
      <div class="card-head">
        <div class="card-title">{{ t('channelDetail.basic') }}</div>
      </div>
      <div class="grid grid-3">
        <div class="field">
          <label>Base URL</label>
          <div class="mono" style="word-break: break-all">{{ channel.baseUrl }}</div>
        </div>
        <div class="field">
          <label>{{ t('channelDetail.modelsPath') }}</label>
          <div class="mono">{{ channel.modelsPath }}</div>
        </div>
        <div class="field">
          <label>{{ t('channelDetail.timeout') }}</label>
          <div>{{ channel.timeoutMs }} ms</div>
        </div>
        <div class="field">
          <label>{{ t('channelDetail.priorityWeight') }}</label>
          <div>{{ channel.priority }} / {{ channel.weight }}</div>
        </div>
        <div class="field">
          <label>{{ t('channelDetail.upstreamKey') }}</label>
          <div class="mono dim">{{ channel.apiKeyMasked || '—' }}</div>
        </div>
        <div class="field">
          <label>{{ t('channelDetail.lastTest') }}</label>
          <div class="dim">{{ formatTime(channel.lastTestAt) }}</div>
        </div>
        <div class="field">
          <label>{{ t('channelDetail.createdAt') }}</label>
          <div class="dim">{{ formatTime(channel.createdAt) }}</div>
        </div>
        <div class="field">
          <label>{{ t('channelDetail.note') }}</label>
          <div class="dim">{{ channel.note || '—' }}</div>
        </div>
        <div class="field">
          <label>{{ t('channelDetail.fixedHeaders') }}</label>
          <div v-if="headerEntries.length === 0" class="dim">{{ t('channelDetail.noHeaders') }}</div>
          <div v-else class="tag-list">
            <span v-for="[k, v] in headerEntries" :key="k" class="tag">{{ k }}: {{ v }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 用量统计 -->
    <div class="card">
      <div class="card-head">
        <div class="card-title">{{ t('channelDetail.usage') }}</div>
        <div style="width: 150px">
          <PSelect v-model="preset" :options="rangeOptions" size="sm" align="end" />
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
          <div class="stat-hint">{{ t('overview.p95') }} {{ formatLatency(stats?.totals.p95LatencyMs) }}</div>
        </div>
        <div class="stat">
          <div class="stat-label">{{ t('overview.estimated') }}</div>
          <div class="stat-value">{{ formatNumber(stats?.totals.estimated) }}</div>
          <div class="stat-hint">{{ t('overview.estimatedHint') }}</div>
        </div>
      </div>

      <div v-if="series.length" class="chart" style="margin-top: 16px">
        <div v-for="p in series" :key="p.day" class="chart-col">
          <div class="chart-value">{{ p.requests }}</div>
          <div
            class="chart-bar"
            :class="{ 'chart-bar-err': p.errors > 0 }"
            :style="{ height: Math.max(2, (p.requests / maxRequests) * 100) + '%' }"
            :title="p.day + '：' + p.requests + ' / ' + p.tokens + ' tok'"
          />
          <div class="chart-label">{{ p.day }}</div>
        </div>
      </div>
    </div>

    <!-- 模型列表 -->
    <div class="card">
      <div class="card-head">
        <div class="card-title">
          {{ t('channelDetail.models') }} · {{ t('channelDetail.modelsCount', { n: modelRows.length }) }}
        </div>
        <span class="dim" style="font-size: 12px">{{ t('channels.modelsMetaHint') }}</span>
      </div>

      <div v-if="modelRows.length === 0" class="empty">{{ t('channelDetail.noModels') }}</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('channelDetail.modelId') }}</th>
              <th>{{ t('channelDetail.ctxLength') }}</th>
              <th>{{ t('channelDetail.maxOutput') }}</th>
              <th>{{ t('channelDetail.ownedBy') }}</th>
              <th>{{ t('channelDetail.gatewayAliases') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in modelRows" :key="m.id">
              <td class="mono">{{ m.id }}</td>
              <td class="nowrap">
                {{ m.meta?.contextLength ? m.meta.contextLength.toLocaleString('en-US') : '—' }}
              </td>
              <td class="nowrap">
                {{ m.meta?.maxOutputTokens ? m.meta.maxOutputTokens.toLocaleString('en-US') : '—' }}
              </td>
              <td class="dim">{{ m.meta?.ownedBy ?? '—' }}</td>
              <td>
                <span v-if="m.aliases.length === 0" class="dim">—</span>
                <span v-else class="tag-list">
                  <span v-for="a in m.aliases" :key="a" class="tag" style="color: var(--accent)">{{ a }}</span>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 映射 -->
    <div class="card">
      <div class="card-head">
        <div class="card-title">
          {{ t('channelDetail.mappings') }} · {{ t('channelDetail.mappingsCount', { n: routes.length }) }}
        </div>
      </div>
      <div v-if="routes.length === 0" class="empty">{{ t('channelDetail.noMappings') }}</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('mapping.alias') }}</th>
              <th>{{ t('mapping.upstreamModel') }}</th>
              <th>{{ t('mapping.priority') }} / {{ t('mapping.weight') }}</th>
              <th>{{ t('common.status') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in routes" :key="r.id">
              <td class="mono">{{ r.alias }}</td>
              <td class="mono dim">{{ r.upstreamModel }}</td>
              <td class="nowrap">{{ r.priority }} / {{ r.weight }}</td>
              <td>
                <span class="badge" :class="r.status === 'active' ? 'badge-ok' : 'badge-off'">
                  {{ r.status === 'active' ? t('common.enabled') : t('common.disabled') }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 最近请求 -->
    <div class="card">
      <div class="card-head">
        <div class="card-title">{{ t('channelDetail.recent') }}</div>
      </div>
      <div v-if="recent.length === 0" class="empty">{{ t('overview.rangeEmpty') }}</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('logs.time') }}</th>
              <th>{{ t('logs.key') }}</th>
              <th>{{ t('logs.model') }}</th>
              <th>{{ t('logs.status') }}</th>
              <th>{{ t('logs.tokens') }}</th>
              <th>{{ t('logs.timing') }}</th>
              <th>{{ t('channelDetail.source') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in recent" :key="l.id">
              <td class="nowrap dim">{{ formatTime(l.ts) }}</td>
              <td>{{ l.apiKeyName || '—' }}</td>
              <td class="mono">{{ l.model || '—' }}</td>
              <td>
                <span class="badge" :class="l.statusCode < 400 ? 'badge-ok' : 'badge-err'">
                  {{ l.statusCode }}
                </span>
              </td>
              <td class="nowrap">
                {{ formatNumber(l.promptTokens) }} / {{ formatNumber(l.completionTokens) }}
              </td>
              <td class="nowrap">
                {{ l.ttftMs === null ? '—' : formatLatency(l.ttftMs) }} / {{ formatLatency(l.latencyMs) }}
              </td>
              <td>
                <span class="badge" :class="l.source === 'playground' ? 'badge-warn' : 'badge-off'">
                  {{ l.source === 'playground' ? t('channelDetail.sourcePlayground') : t('channelDetail.sourceGateway') }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <Modal
    v-if="revealOpen && channel"
    :title="t('channels.revealKeyTitle', { name: channel.name })"
    wide
    @close="closeReveal"
  >
    <div class="alert">{{ t('channels.revealKeyWarning') }}</div>
    <div v-if="revealing" class="loading">{{ t('channels.revealKeyReading') }}</div>
    <div v-else-if="revealError" class="err-text">{{ revealError }}</div>
    <template v-else>
      <div class="code-box">{{ revealedKey }}</div>
      <div class="row" style="margin-top: 12px">
        <button class="btn btn-primary btn-sm" @click="copyText(revealedKey)">
          {{ t('channels.copyFullKey') }}
        </button>
      </div>
    </template>
    <div class="modal-foot">
      <button class="btn" @click="closeReveal">{{ t('common.close') }}</button>
    </div>
  </Modal>
</template>
