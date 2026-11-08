<script setup lang="ts">
/**
 * 渠道详情子页面（从上游渠道列表点进来）。
 *
 * 聚合四块信息：基本配置 / 用量统计 / 模型列表（含上下文长度）/ 映射与最近请求。
 * 数据全部走既有接口，仅统计与映射按 channelId 过滤。
 */
import { errorText, toastError } from '../error'
import { computed, onMounted, ref, watch } from 'vue'
import {
  api,
  type Channel,
  type ChannelAccount,
  type ChannelRate,
  type ChannelTestResult,
  type ModelMeta,
  type ModelOverride,
  type ModelRoute,
  type UsageSnapshot,
  type RangePreset,
  type RequestLog,
  type SeriesPoint,
  type StatsOverview,
  type StatsSeries,
  type User
} from '../api'
import Modal from '../components/Modal.vue'
import AccountUsage from '../components/AccountUsage.vue'
import BillingRateDialog from '../components/BillingRateDialog.vue'
import UsageTrendChart from '../components/UsageTrendChart.vue'
import PInfo from '../components/PInfo.vue'
import PSelect from '../components/PSelect.vue'
import {
  formatCompact,
  formatLatency,
  formatMoney,
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

// ---------------------------------------------------------------- 计费费率

const rates = ref<ChannelRate[]>([])
const ratesLoading = ref(false)
const rateDialogOpen = ref(false)
const editingRate = ref<ChannelRate | null>(null)

/** 该渠道的默认费率（upstream_model = ''）；停用的不参与解析，视为未设置 */
const defaultRate = computed(
  () =>
    rates.value.find(
      (r) =>
        r.channelId === props.channelId &&
        r.upstreamModel === '' &&
        r.status === 'active'
    ) ?? null
)

/** 按模型的费率（含停用行，列表里用徽章标出） */
const modelRates = computed(() =>
  rates.value
    .filter((r) => r.channelId === props.channelId && r.upstreamModel !== '')
    .sort((a, b) => a.upstreamModel.localeCompare(b.upstreamModel))
)

/** 全局默认（解析优先级最低，用来解释「未设置时按什么计」） */
const globalRate = computed(
  () =>
    rates.value.find(
      (r) => r.channelId === null && r.upstreamModel === '' && r.status === 'active'
    ) ?? null
)

function rateSummary(rate: ChannelRate): string {
  return t('billing.rate.summary', {
    input: formatMoney(rate.inputPerMtok, rate.currency),
    output: formatMoney(rate.outputPerMtok, rate.currency),
    perRequest: formatMoney(rate.perRequest, rate.currency)
  })
}

async function loadRates(): Promise<void> {
  if (!isAdmin()) return
  ratesLoading.value = true
  try {
    const res = await api.get<{ rates: ChannelRate[] }>(
      '/api/billing/rates?channelId=' + props.channelId
    )
    rates.value = res.rates
  } catch {
    // 计费接口不可用时不该让整个详情页报错 —— 卡片显示未设置即可
    rates.value = []
  } finally {
    ratesLoading.value = false
  }
}

function openRateDialog(rate?: ChannelRate): void {
  editingRate.value = rate ?? null
  rateDialogOpen.value = true
}

function onRateSaved(): void {
  rateDialogOpen.value = false
  void loadRates()
}

/** 记住上次用的统计粒度（键与概览页**不同**，两处记忆彼此独立） */
const RANGE_KEY = 'portara.channelDetail.range'

function restoreRange(): void {
  const saved = loadRangePreference(RANGE_KEY)
  if (saved) preset.value = saved.preset
}

const rangeOptions = computed(() => [
  { value: 'today', label: t('overview.today') },
  { value: '7d', label: t('overview.d7') },
  { value: '30d', label: t('overview.d30') }
])

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
  return ch.models.map((id) => {
    const override = (ch.modelOverrides ?? {})[id]
    return {
      id,
      meta: meta[id] ?? null,
      aliases: aliasByModel.value.get(id) ?? [],
      override: override ?? null,
      // 有效协议：逐模型覆盖优先，其次渠道默认；混杂模式下未覆盖的按 openai
      protocol:
        override?.protocol ??
        (ch.protocol === 'anthropic' ? 'anthropic' : 'openai')
    }
  })
})

const headerEntries = computed(() => Object.entries(channel.value?.extraHeaders ?? {}))

/** 余额快照：只在渠道配了适配器时才请求 */
const usage = ref<UsageSnapshot | null>(null)
const usageLoading = ref(false)

async function loadUsage(force = false): Promise<void> {
  const ch = channel.value
  if (!ch?.usageAdapter) return
  usageLoading.value = true
  try {
    usage.value = await api.get<UsageSnapshot>(
      '/api/channels/' + ch.id + '/usage' + (force ? '?refresh=1' : '')
    )
  } catch {
    usage.value = null
  } finally {
    usageLoading.value = false
  }
}

function windowPercent(w: { used: number; total: number }): number {
  return quotaPercent(w.used, w.total)
}

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

/** 该渠道选用的代理（详情页只读展示；改在编辑弹窗里改） */
const proxyName = ref('')
const proxyAddress = ref('')

// ---------------------------------------------------------------- 上游账户

/** 编辑中的账户；id 为空表示新建 */
const accountForm = ref<{
  id: string
  name: string
  apiKey: string
  priority: number
  weight: number
  status: 'active' | 'disabled'
  note: string
} | null>(null)
const accountSaving = ref(false)
/** 正在显示的账户明文（仅管理员） */
const accountReveal = ref<{ name: string; key: string } | null>(null)

/** 通用冷却剩余秒数；0 表示可用 */
function cooldownLeft(a: ChannelAccount): number {
  if (!a.cooldownUntil) return 0
  return Math.max(0, Math.round((new Date(a.cooldownUntil).getTime() - Date.now()) / 1000))
}

/** 额度用尽冷冻的剩余秒数；0 表示不在冷冻期 */
function quotaCooldownLeft(a: ChannelAccount): number {
  if (!a.quotaCooldownUntil) return 0
  return Math.max(
    0,
    Math.round((new Date(a.quotaCooldownUntil).getTime() - Date.now()) / 1000)
  )
}

/** 倒计时的人类可读形式：3d2h / 2h15m / 14m / 45s */
function cooldownText(secs: number): string {
  if (secs >= 86400) return `${Math.floor(secs / 86400)}d${Math.floor((secs % 86400) / 3600)}h`
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`
  if (secs >= 60) return `${Math.floor(secs / 60)}m`
  return `${secs}s`
}

function openAccountForm(account?: ChannelAccount): void {
  accountForm.value = account
    ? {
        id: account.id,
        name: account.name,
        apiKey: '',
        priority: account.priority,
        weight: account.weight,
        status: account.status,
        note: account.note
      }
    : { id: '', name: '', apiKey: '', priority: 100, weight: 1, status: 'active', note: '' }
}

async function saveAccount(): Promise<void> {
  const ch = channel.value
  const f = accountForm.value
  if (!ch || !f) return
  if (!f.name.trim()) {
    toast.error(t('channels.nameRequired'))
    return
  }
  accountSaving.value = true
  try {
    const body = {
      name: f.name.trim(),
      // 留空表示不改密钥（新建时留空 = 该账户暂时没有密钥）
      ...(f.apiKey.trim() ? { apiKey: f.apiKey.trim() } : {}),
      priority: Number(f.priority),
      weight: Number(f.weight),
      status: f.status,
      note: f.note.trim()
    }
    if (f.id) await api.patch(`/api/channels/${ch.id}/accounts/${f.id}`, body)
    else await api.post(`/api/channels/${ch.id}/accounts`, body)
    accountForm.value = null
    await loadChannel()
    toast.success(t('channels.saved'))
  } catch (err) {
    toastError(err, t('channels.saveFailed'))
  } finally {
    accountSaving.value = false
  }
}

async function removeAccount(a: ChannelAccount): Promise<void> {
  const ch = channel.value
  if (!ch) return
  if (!confirm(t('channels.accountDeleteConfirm', { name: a.name }))) return
  try {
    await api.del(`/api/channels/${ch.id}/accounts/${a.id}`)
    await loadChannel()
    toast.success(t('common.deleted'))
  } catch (err) {
    toastError(err, t('channels.deleteFailed'))
  }
}

/** 正在取明文的账户 id：按钮显示"加载中"，避免慢请求期间看起来像点击没反应 */
const revealingId = ref('')

async function revealAccountKey(a: ChannelAccount): Promise<void> {
  const ch = channel.value
  if (!ch || revealingId.value) return
  revealingId.value = a.id
  try {
    const r = await api.get<{ key: string }>(`/api/channels/${ch.id}/accounts/${a.id}/reveal`)
    accountReveal.value = { name: a.name, key: r.key }
  } catch (err) {
    toastError(err, t('channels.revealKeyFailed'))
  } finally {
    revealingId.value = ''
  }
}

async function resetAccountHealth(a: ChannelAccount): Promise<void> {
  const ch = channel.value
  if (!ch) return
  try {
    await api.post(`/api/channels/${ch.id}/accounts/${a.id}/reset-health`)
    await loadChannel()
    toast.success(t('channels.accountHealthReset'))
  } catch (err) {
    toastError(err, t('channels.saveFailed'))
  }
}

async function loadProxyLabel(): Promise<void> {
  const id = channel.value?.proxyId
  if (!id) {
    proxyName.value = ''
    proxyAddress.value = ''
    return
  }
  try {
    const res = await api.get<{ proxies: { id: string; name: string; host: string; port: number }[] }>(
      '/api/proxies'
    )
    const hit = res.proxies.find((p) => p.id === id)
    proxyName.value = hit?.name ?? id
    proxyAddress.value = hit ? `${hit.host}:${hit.port}` : ''
  } catch {
    // 操作员无权限读代理列表 —— 退化显示 id，不影响其它信息
    proxyName.value = id
    proxyAddress.value = ''
  }
}

async function loadChannel(): Promise<void> {
  // 代理名称与渠道无关地并行加载，不阻塞主信息
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
  // 先恢复上次的粒度，再加载 —— 否则首屏会先按默认拉一次
  restoreRange()
  await loadStats()
  void loadProxyLabel()
  void loadUsage()
  void loadRates()
  loading.value = false
}

async function loadStats(): Promise<void> {
  const q = 'range=' + preset.value + '&channelId=' + props.channelId + '&' + tzQueryParam()
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
    toastError(err, t('channels.testFailed'))
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
    revealError.value = errorText(err, t('channels.revealKeyFailed'))
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

// ---------------------------------------------------------------- 批量覆盖

const overrideOpen = ref(false)
const overrideSelected = ref<string[]>([])
const overrideSearch = ref('')
const overrideProtocol = ref<'' | 'openai' | 'anthropic'>('')
const overrideBaseUrl = ref('')
const overrideClear = ref(false)
const savingOverride = ref(false)

const overrideProtocolOptions = computed(() => [
  { value: '', label: t('channelDetail.overrideInherit') },
  { value: 'openai', label: t('channels.protocolOpenai') },
  { value: 'anthropic', label: t('channels.protocolAnthropic') }
])

const overrideCandidates = computed(() => {
  const q = overrideSearch.value.trim().toLowerCase()
  return q ? modelRows.value.filter((m) => m.id.toLowerCase().includes(q)) : modelRows.value
})

function openOverride(): void {
  overrideSelected.value = []
  overrideSearch.value = ''
  overrideProtocol.value = ''
  overrideBaseUrl.value = ''
  overrideClear.value = false
  overrideOpen.value = true
}

function toggleOverrideModel(id: string): void {
  const i = overrideSelected.value.indexOf(id)
  if (i >= 0) overrideSelected.value.splice(i, 1)
  else overrideSelected.value.push(id)
}

function selectAllOverride(): void {
  overrideSelected.value = [...new Set([...overrideSelected.value, ...overrideCandidates.value.map((m) => m.id)])]
}

async function saveOverride(): Promise<void> {
  const ch = channel.value
  if (!ch) return
  if (overrideSelected.value.length === 0) {
    toast.error(t('channelDetail.selectModelsFirst'))
    return
  }

  savingOverride.value = true
  try {
    const next: Record<string, ModelOverride> = { ...(ch.modelOverrides ?? {}) }

    for (const id of overrideSelected.value) {
      if (overrideClear.value) {
        delete next[id]
        continue
      }
      const current = next[id] ?? {}
      const updated: ModelOverride = { ...current }
      if (overrideProtocol.value) updated.protocol = overrideProtocol.value
      if (overrideBaseUrl.value.trim()) updated.baseUrl = overrideBaseUrl.value.trim()
      // 覆盖里什么都没设且原本没有 → 不必留下空对象
      if (Object.keys(updated).length === 0) delete next[id]
      else next[id] = updated
    }

    await api.patch('/api/channels/' + ch.id, { modelOverrides: next })
    toast.success(t('channelDetail.overrideSaved', { n: overrideSelected.value.length }))
    overrideOpen.value = false
    await loadChannel()
  } catch (err) {
    toastError(err, t('channelDetail.overrideFailed'))
  } finally {
    savingOverride.value = false
  }
}

/** 配置的编辑入口：详情页只读展示，改配置去子页面 */
function editChannel(): void {
  location.hash = '#/channels/' + props.channelId + '/edit'
}

function back(): void {
  location.hash = '#/channels'
}

watch(preset, () => {
  saveRangePreference(RANGE_KEY, preset.value)
  void loadStats()
})
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
        <button v-if="isAdmin()" class="btn btn-sm btn-primary" @click="editChannel">
          {{ t('common.edit') }}
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
          <label>{{ t('channels.hideUnmappedModels') }}</label>
          <div>
            <span
              class="badge"
              :class="channel.hideUnmappedModels ? 'badge-ok' : 'badge-off'"
            >
              {{
                channel.hideUnmappedModels
                  ? t('common.enabled')
                  : t('common.disabled')
              }}
            </span>
          </div>
        </div>
        <div class="field">
          <label>{{ t('channelDetail.note') }}</label>
          <div class="dim">{{ channel.note || '—' }}</div>
        </div>
        <div class="field">
          <label>{{ t('channels.proxy') }}</label>
          <div v-if="!channel.proxyId" class="dim">{{ t('channels.proxyNone') }}</div>
          <div v-else>
            <span class="tag" style="color: var(--accent)">{{ proxyName }}</span>
            <span class="dim" style="margin-left: 6px">{{ proxyAddress }}</span>
          </div>
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

    <!-- 计费费率 -->
    <div v-if="isAdmin()" class="card">
      <div class="card-head">
        <div>
          <div class="card-title">{{ t('billing.rate.cardTitle') }}</div>
          <div class="dim" style="font-size: 12px">{{ t('billing.rate.cardSub') }}</div>
        </div>
        <div class="row">
          <button class="btn btn-sm" @click="loadRates">{{ t('common.refresh') }}</button>
          <button class="btn btn-sm btn-primary" @click="openRateDialog()">
            ＋ {{ t('billing.rate.newModel') }}
          </button>
        </div>
      </div>

      <div v-if="ratesLoading" class="loading">{{ t('common.loading') }}</div>
      <template v-else>
        <div class="row-between row-wrap" style="gap: 10px">
          <div class="row row-wrap">
            <span style="font-weight: 600">{{ t('billing.rate.defaultRow') }}</span>
            <span v-if="!defaultRate" class="tag">{{ t('billing.rate.notSet') }}</span>
            <span v-else class="badge badge-ok">{{ t('common.enabled') }}</span>
            <template v-if="defaultRate">
              <span class="tag">{{ defaultRate.currency }}</span>
              <span class="tag">
                {{ t('billing.rate.input') }} {{ formatMoney(defaultRate.inputPerMtok, defaultRate.currency) }}
              </span>
              <span class="tag">
                {{ t('billing.rate.output') }} {{ formatMoney(defaultRate.outputPerMtok, defaultRate.currency) }}
              </span>
              <span class="tag">
                {{ t('billing.rate.perRequest') }} {{ formatMoney(defaultRate.perRequest, defaultRate.currency) }}
              </span>
            </template>
          </div>
          <div class="row">
            <span class="dim" style="font-size: 11.5px">
              <template v-if="globalRate">
                {{ t('billing.rate.globalFallback', { value: rateSummary(globalRate) }) }}
              </template>
              <template v-else>{{ t('billing.rate.globalNone') }}</template>
            </span>
            <button v-if="defaultRate" class="btn btn-sm" @click="openRateDialog(defaultRate)">
              {{ t('common.edit') }}
            </button>
            <button v-else class="btn btn-sm btn-primary" @click="openRateDialog()">
              {{ t('billing.rate.quickSet') }}
            </button>
          </div>
        </div>

        <div class="card-title" style="margin-top: 16px; font-size: 13px">
          {{ t('billing.rate.modelRows') }}
        </div>
        <div v-if="modelRates.length === 0" class="empty" style="padding: 18px 0">
          {{ t('billing.rate.noModelRows') }}
        </div>
        <div v-else class="table-wrap" style="margin-top: 8px">
          <table>
            <thead>
              <tr>
                <th>{{ t('billing.rate.upstreamModel') }}</th>
                <th>{{ t('billing.currency') }}</th>
                <th>{{ t('billing.rate.input') }}</th>
                <th>{{ t('billing.rate.output') }}</th>
                <th>{{ t('billing.rate.perRequest') }}</th>
                <th>{{ t('common.status') }}</th>
                <th style="width: 100px">{{ t('common.actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in modelRates" :key="r.id">
                <td class="mono">{{ r.upstreamModel }}</td>
                <td class="mono">{{ r.currency }}</td>
                <td class="mono nowrap">{{ formatMoney(r.inputPerMtok, r.currency) }}</td>
                <td class="mono nowrap">{{ formatMoney(r.outputPerMtok, r.currency) }}</td>
                <td class="mono nowrap">{{ formatMoney(r.perRequest, r.currency) }}</td>
                <td>
                  <span class="badge" :class="r.status === 'active' ? 'badge-ok' : 'badge-off'">
                    {{ r.status === 'active' ? t('common.enabled') : t('common.disabled') }}
                  </span>
                </td>
                <td>
                  <button class="btn btn-sm" @click="openRateDialog(r)">{{ t('common.edit') }}</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <!-- 上游账户：同一渠道的多把 Key，按优先级/权重轮转 + 故障转移 -->
    <div class="card">
      <div class="card-head">
        <div class="card-title">
          {{ t('channels.accounts') }}
          <span class="tag">{{ channel.accounts.length }}</span>
        </div>
        <button type="button" class="btn btn-sm" @click="openAccountForm()">
          ＋ {{ t('channels.addAccount') }}
        </button>
      </div>

      <div class="acct-list">
        <div v-for="a in channel.accounts" :key="a.id" class="acct-row">
          <span class="acct-name">{{ a.name }}</span>
          <span class="tag">
            {{ a.status === 'active' ? t('common.enabled') : t('common.disabled') }}
          </span>
          <span v-if="cooldownLeft(a) > 0" class="badge badge-warn">
            {{ t('channels.accountCooling', { n: cooldownLeft(a) }) }}
          </span>
          <!-- 额度用尽触发的阶梯冷冻：与通用冷却分开显示，避免误读 -->
          <span v-if="quotaCooldownLeft(a) > 0" class="badge badge-err">
            {{
              t('channels.accountQuotaCooling', {
                n: cooldownText(quotaCooldownLeft(a)),
                level: a.quotaCooldownLevel
              })
            }}
          </span>
          <span class="mono dim acct-key">{{ a.apiKeyMasked || t('channels.accountNoKey') }}</span>
          <span class="dim acct-meta">
            {{ t('channels.accountPriority', { p: a.priority, w: a.weight }) }}
          </span>
          <span class="spacer" />
          <button
            type="button"
            class="btn btn-sm"
            :disabled="!a.hasKey || revealingId === a.id"
            :title="a.hasKey ? '' : t('channels.accountNoKey')"
            @click="revealAccountKey(a)"
          >
            {{ revealingId === a.id ? t('common.loading') : t('channels.revealKey') }}
          </button>
          <button type="button" class="btn btn-sm" @click="openAccountForm(a)">{{ t('common.edit') }}</button>
          <button
            v-if="cooldownLeft(a) > 0 || quotaCooldownLeft(a) > 0"
            class="btn btn-sm"
            @click="resetAccountHealth(a)"
          >
            {{ t('channels.accountReset') }}
          </button>
          <button class="btn btn-sm" @click="removeAccount(a)">{{ t('common.delete') }}</button>
        </div>
      </div>

      <div v-if="channel.accounts.length > 1" class="dim acct-hint">
        {{ t('channels.accountsHint') }}
      </div>
    </div>

    <!-- 用量统计 -->
    <div class="card">
      <div class="card-head">
        <div class="card-title">{{ t('channelDetail.usage') }}</div>
        <span class="dim" style="font-size: 11.5px; margin-left: auto; margin-right: 10px">
          {{ t('overview.timezoneLabel') }} {{ stats?.timezone ?? CLIENT_TZ }}
        </span>
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

      <!-- 与概览页共用同一张图（双轴 + 悬浮详情），避免两处各画一版 -->
      <div class="chart-inline">
        <UsageTrendChart :series="series" />
      </div>
    </div>

    <!-- 余额 / 用量（仅当渠道配了适配器） -->
    <div v-if="channel.usageAdapter" class="card">
      <div class="card-head">
        <div class="card-title row" style="gap: 8px">
          {{ t('usage.title') }}
          <span class="tag">{{ channel.usageAdapter }}</span>
        </div>
        <button class="btn btn-sm" :disabled="usageLoading" @click="loadUsage(true)">
          {{ t('common.refresh') }}
        </button>
      </div>

      <div v-if="usageLoading && !usage" class="loading">{{ t('common.loading') }}</div>

      <template v-else-if="usage">
        <div v-if="!usage.ok" class="alert">
          <b>{{ t('usage.error') }}：</b>{{ usage.error }}
        </div>
        <template v-else>
          <div v-if="usage.stale" class="alert">{{ t('usage.stale') }}</div>
          <div v-if="usage.balances.length" class="grid grid-3" style="margin-bottom: 14px">
            <div v-for="b in usage.balances" :key="b.currency" class="stat">
              <div class="stat-label">{{ t('usage.balance') }} · {{ b.currency }}</div>
              <div class="stat-value">
                {{ b.remaining.toLocaleString('en-US', { maximumFractionDigits: 4 }) }}
              </div>
              <div class="stat-hint">
                <template v-if="b.granted !== undefined">
                  {{ t('usage.granted') }} {{ formatNumber(b.granted) }}
                
  <!-- 账户表单 -->
  <Modal
    v-if="accountForm"
    :title="accountForm.id ? t('channels.accountEditTitle') : t('channels.accountCreateTitle')"
    @close="accountForm = null"
  >
    <div class="field">
      <label>{{ t('common.name') }}</label>
      <input v-model="accountForm.name" maxlength="64" />
    </div>
    <div class="field">
      <label>{{ t('channels.upstreamKey') }}</label>
      <input
        v-model="accountForm.apiKey"
        type="password"
        autocomplete="off"
        :placeholder="accountForm.id ? t('channels.accountKeyHint') : ''"
      />
    </div>
    <div class="form-row">
      <div class="field">
        <label>{{ t('channels.priority') }}</label>
        <input v-model.number="accountForm.priority" type="number" min="0" max="10000" />
      </div>
      <div class="field">
        <label>{{ t('channels.weight') }}</label>
        <input v-model.number="accountForm.weight" type="number" min="1" max="1000" />
      </div>
      <div class="field">
        <label>{{ t('common.status') }}</label>
        <PSelect
          v-model="accountForm.status"
          :options="[
            { value: 'active', label: t('common.enabled') },
            { value: 'disabled', label: t('common.disabled') }
          ]"
        />
      </div>
    </div>
    <div class="field">
      <label>{{ t('common.note') }}</label>
      <input v-model="accountForm.note" maxlength="500" />
    </div>
    <div class="modal-foot">
      <button class="btn" @click="accountForm = null">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" :disabled="accountSaving" @click="saveAccount">
        {{ accountSaving ? t('common.saving') : t('common.save') }}
      </button>
    </div>
  </Modal>

  <!-- 账户密钥明文（必留审计） -->
  <Modal
    v-if="accountReveal"
    :title="t('channels.accountSecretTitle') + ' · ' + accountReveal.name"
    @close="accountReveal = null"
  >
    <div class="alert">{{ t('channels.revealKeyWarning') }}</div>
    <div class="mono key-reveal">{{ accountReveal.key }}</div>
    <div class="modal-foot">
      <button class="btn" @click="accountReveal = null">{{ t('common.close') }}</button>
    </div>
  </Modal>

</template>
                <template v-if="b.toppedUp !== undefined">
                  · {{ t('usage.toppedUp') }} {{ formatNumber(b.toppedUp) }}
                </template>
              </div>
            </div>
          </div>
          <div v-if="usage.windows.length" class="form-grid" style="gap: 10px">
            <div v-for="w in usage.windows" :key="w.key">
              <div class="row-between" style="font-size: 12.5px">
                <span class="row" style="gap: 5px">
                  {{ windowLabel(w.key) }}
                  <PInfo v-if="w.inferred" :text="t('usage.inferredHint')" />
                  <span v-if="w.inferred" class="tag" style="color: var(--warn)">
                    {{ t('usage.inferred') }}
                  </span>
                </span>
                <span class="nowrap">
                  {{ formatNumber(Math.round(w.used)) }} / {{ formatNumber(Math.round(w.total)) }}
                  <span :style="{ color: quotaColor(windowPercent(w), w.exceeded) }">
                    ({{ windowPercent(w) }}%)
                  </span>
                  <span v-if="w.resetAt" class="dim">· {{ t('usage.resetAt') }} {{ formatTime(w.resetAt) }}</span>
                </span>
              </div>
              <div style="height: 5px; background: var(--bg-elev-2); border-radius: 3px; margin-top: 5px">
                <div
                  :style="{
                    width: windowPercent(w) + '%',
                    height: '100%',
                    background: quotaColor(windowPercent(w), w.exceeded),
                    borderRadius: '3px'
                  }"
                />
              </div>
            </div>
          </div>
          <div v-for="(wn, i) in usage.warnings" :key="i" class="dim" style="font-size: 12px; margin-top: 8px">
            · {{ wn }}
          </div>

          <!-- 逐账户：上面是聚合值，这里是每个号各自的余额与限额 -->
          <div v-if="usage.accounts.length > 1" class="detail-acct-usage">
            <div class="dim" style="font-size: 12px; margin-bottom: 10px">
              {{ t('usage.byAccount') }}
            </div>
            <!-- 小卡片：宽屏并排、窄屏堆叠；信息一条不少 -->
            <div class="acct-card-grid">
              <div v-for="a in usage.accounts" :key="a.accountId" class="acct-card">
                <AccountUsage :account="a" show-name />
              </div>
            </div>
          </div>

          <div class="dim" style="font-size: 11.5px; margin-top: 10px">
            {{ t('usage.fetchedAt') }} {{ formatTime(usage.fetchedAt) }}
          </div>
        </template>
      </template>
    </div>

    <!-- 模型列表 -->
    <div class="card">
      <div class="card-head">
        <div class="card-title">
          {{ t('channelDetail.models') }} · {{ t('channelDetail.modelsCount', { n: modelRows.length }) }}
        </div>
        <div class="row">
          <span class="dim" style="font-size: 12px">{{ t('channels.modelsMetaHint') }}</span>
          <button v-if="isAdmin()" class="btn btn-sm" @click="openOverride">
            {{ t('channelDetail.batchOverride') }}
          </button>
        </div>
      </div>

      <div v-if="modelRows.length === 0" class="empty">{{ t('channelDetail.noModels') }}</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('channelDetail.modelId') }}</th>
              <th>{{ t('channelDetail.modelProtocol') }}</th>
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
                <span
                  class="tag"
                  :style="m.protocol === 'anthropic' ? 'color: var(--accent)' : ''"
                >
                  {{ m.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI' }}
                </span>
                <span
                  v-if="m.override"
                  class="tag"
                  style="color: var(--warn); margin-left: 4px"
                  :title="m.override.baseUrl ?? ''"
                >
                  {{ t('channelDetail.overridden') }}
                </span>
              </td>
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

  <BillingRateDialog
    v-if="rateDialogOpen && channel"
    :rate="editingRate"
    :fixed-channel-id="channel.id"
    :fixed-channel-name="channel.name"
    :models="channel.models"
    @close="rateDialogOpen = false"
    @saved="onRateSaved"
  />

  <Modal
    v-if="overrideOpen && channel"
    :title="t('channelDetail.overrideTitle')"
    wide
    @close="overrideOpen = false"
  >
    <div class="alert alert-info">{{ t('channelDetail.overrideSub') }}</div>

    <div class="form-grid">
      <div class="field">
        <div class="row-between">
          <label>
            {{ t('chat.batchSelectModels') }} · {{ t('chat.batchSelected', { n: overrideSelected.length }) }}
          </label>
          <div class="row">
            <button class="btn btn-sm" @click="selectAllOverride">{{ t('chat.batchSelectAll') }}</button>
            <button class="btn btn-sm" @click="overrideSelected = []">{{ t('chat.batchClear') }}</button>
          </div>
        </div>
        <input v-model="overrideSearch" :placeholder="t('chat.batchSearch')" />
        <div class="batch-pick">
          <div
            v-for="m in overrideCandidates"
            :key="m.id"
            class="batch-pick-item"
            :class="{ on: overrideSelected.includes(m.id) }"
            @click="toggleOverrideModel(m.id)"
          >
            <span class="batch-pick-box">
              <svg v-if="overrideSelected.includes(m.id)" width="10" height="10" viewBox="0 0 12 12">
                <path d="M2 6.4 4.6 9 10 3.4" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <span class="mono">{{ m.id }}</span>
            <span class="spacer" />
            <span class="tag">{{ m.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI' }}</span>
          </div>
        </div>
      </div>

      <div class="form-row">
        <div class="field">
          <label>{{ t('channelDetail.overrideProtocol') }}</label>
          <PSelect v-model="overrideProtocol" :options="overrideProtocolOptions" />
        </div>
        <div class="field">
          <label>{{ t('channelDetail.overrideBaseUrl') }}</label>
          <input v-model="overrideBaseUrl" placeholder="https://api.anthropic.com/v1" />
        </div>
      </div>

      <label class="row" style="gap: 8px; cursor: pointer">
        <input v-model="overrideClear" type="checkbox" style="width: auto" />
        <span>{{ t('channelDetail.overrideClear') }}</span>
      </label>
    </div>

    <div class="modal-foot">
      <button class="btn" @click="overrideOpen = false">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" :disabled="savingOverride" @click="saveOverride">
        {{ savingOverride ? t('common.saving') : t('common.save') }}
      </button>
    </div>
  </Modal>

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
