<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  api,
  ApiError,
  type Channel,
  type ChannelTestResult,
  type FetchModelsResult,
  type ModelMeta,
  type ModelRoute,
  type User
} from '../api'
import Modal from '../components/Modal.vue'
import PInfo from '../components/PInfo.vue'
import PSelect from '../components/PSelect.vue'
import {
  formatNumber,
  formatTime,
  headerLines,
  parseHeaderLines,
  parseList
} from '../format'
import { useI18n } from '../i18n'
import { toast } from '../toast'

const props = defineProps<{ user?: User }>()

const { t } = useI18n()

const channels = ref<Channel[]>([])
const loading = ref(true)
const showForm = ref(false)
const saving = ref(false)
const editingId = ref<string | null>(null)
const testResults = reactive<Record<string, ChannelTestResult | 'loading'>>({})

const form = reactive({
  name: '',
  baseUrl: '',
  apiKey: '',
  protocol: 'openai',
  vendor: 'generic',
  modelsPath: '/models',
  modelsMeta: {} as Record<string, ModelMeta>,
  headersText: '',
  modelsText: '',
  priority: 100,
  weight: 1,
  timeoutMs: 120000,
  status: 'active' as 'active' | 'disabled',
  note: ''
})

const protocolOptions = computed(() => [
  { value: 'openai', label: t('channels.protocolOpenai') },
  { value: 'anthropic', label: t('channels.protocolAnthropic') },
  { value: 'mixed', label: t('channels.protocolMixed') }
])

const vendorOptions = computed(() => [
  { value: 'generic', label: t('channels.vendorGeneric') },
  { value: 'opencode-go', label: t('channels.vendorOpencode') }
])

const statusOptions = computed(() => [
  { value: 'active', label: t('common.enabled') },
  { value: 'disabled', label: t('common.disabled') }
])

const isAdmin = (): boolean => props.user?.role === 'admin'

// ---------------------------------------------------------------- 查看上游密钥

const revealTarget = ref<Channel | null>(null)
const revealedKey = ref('')
const revealError = ref('')
const revealing = ref(false)

async function revealChannelKey(ch: Channel): Promise<void> {
  revealTarget.value = ch
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
  revealTarget.value = null
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

// ---------------------------------------------------------------- 模型映射

const routes = ref<ModelRoute[]>([])
const showRouteForm = ref(false)
const showBatchForm = ref(false)
const savingRoute = ref(false)

const routeForm = reactive({
  alias: '',
  targets: [] as { channelId: string; upstreamModel: string; priority: number; weight: number }[]
})

const batchForm = reactive({
  channelId: '',
  prefix: '',
  modelsText: '',
  priority: 100,
  weight: 1
})

/** 按别名分组：一个网关模型 ID 对应多个目标 */
const routeGroups = computed(() => {
  const map = new Map<string, ModelRoute[]>()
  for (const r of routes.value) {
    const list = map.get(r.alias) ?? []
    list.push(r)
    map.set(r.alias, list)
  }
  return [...map.entries()]
    .map(([alias, targets]) => ({ alias, targets }))
    .sort((a, b) => a.alias.localeCompare(b.alias))
})

/**
 * 再按前缀分组 —— 批量映射产生的别名形如 `前缀/模型`，
 * 它们天然是一组，UI 上折叠起来才不会让页面无限变长。
 */
/**
 * 分组键（渠道 id 头）。
 *
 * 不能简单地按 `/` 切 —— 上游模型 id 自身可能含 `/`，
 * 例如 `commandcode/deepseek/deepseek-v4-flash` 用 lastIndexOf 会切出
 * `commandcode/deepseek`，把一组碎成一片。按可信度依次取：
 *
 *   ① 批量映射时**记录下来的**前缀（最可靠，创建时就知道）
 *   ② 从行内**精确推导**：别名去掉末尾的 `/<上游模型 id>` 就是前缀
 *   ③ 最后兜底：第一个 `/` 之前的部分
 */
function groupKeyOf(alias: string, targets: ModelRoute[]): string {
  const recorded = targets.find((t) => t.groupKey)?.groupKey
  if (recorded) return recorded

  const upstream = targets[0]?.upstreamModel
  if (upstream && alias !== upstream && alias.endsWith('/' + upstream)) {
    return alias.slice(0, alias.length - upstream.length - 1)
  }

  const slash = alias.indexOf('/')
  return slash > 0 ? alias.slice(0, slash) : ''
}

const prefixGroups = computed(() => {
  const map = new Map<string, { alias: string; targets: ModelRoute[] }[]>()
  for (const g of routeGroups.value) {
    const prefix = groupKeyOf(g.alias, g.targets)
    const list = map.get(prefix) ?? []
    list.push(g)
    map.set(prefix, list)
  }
  return [...map.entries()]
    .map(([prefix, aliases]) => ({
      prefix,
      aliases,
      targetCount: aliases.reduce((n, a) => n + a.targets.length, 0)
    }))
    .sort((a, b) => (a.prefix === '' ? 1 : b.prefix === '' ? -1 : a.prefix.localeCompare(b.prefix)))
})

/** 折叠状态按前缀记录；默认展开 */
const collapsed = reactive<Record<string, boolean>>({})

function toggleGroup(prefix: string): void {
  collapsed[prefix] = !collapsed[prefix]
}

function setAllCollapsed(value: boolean): void {
  for (const g of prefixGroups.value) collapsed[g.prefix] = value
}

// ---------------------------------------------------------------- JSON 编辑

const showJsonForm = ref(false)
const jsonText = ref('')
const jsonMode = ref<'replace' | 'merge'>('replace')
const jsonError = ref('')

const jsonModeOptions = computed(() => [
  {
    value: 'replace',
    // 明确告诉用户会删掉多少条 —— 删除前必须让人看见代价
    label: t('mapping.modeReplaceCount', { n: routes.value.length })
  },
  { value: 'merge', label: t('mapping.modeMerge') }
])

/** 导出为 JSON：单目标用对象、多目标用数组；渠道用名称 */
function buildJson(): string {
  const out: Record<string, unknown> = {}
  for (const g of routeGroups.value) {
    const targets = g.targets.map((tg) => ({
      channel: tg.channelName ?? '',
      model: tg.upstreamModel,
      ...(tg.priority !== 100 ? { priority: tg.priority } : {}),
      ...(tg.weight !== 1 ? { weight: tg.weight } : {})
    }))
    out[g.alias] = targets.length === 1 ? targets[0] : targets
  }
  return JSON.stringify(out, null, 2)
}

function openJsonEditor(): void {
  jsonText.value = buildJson()
  jsonMode.value = 'replace'
  jsonError.value = ''
  showJsonForm.value = true
}

async function applyJson(): Promise<void> {
  jsonError.value = ''
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText.value)
  } catch (err) {
    jsonError.value = t('mapping.jsonSyntaxError', {
      msg: err instanceof Error ? err.message : String(err)
    })
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    jsonError.value = t('mapping.jsonSyntaxError', { msg: 'expecting a JSON object' })
    return
  }
  if (Object.keys(parsed as object).length === 0) {
    jsonError.value = t('mapping.jsonEmpty')
    return
  }

  savingRoute.value = true
  try {
    const res = await api.post<{ applied: number; removed: number }>(
      '/api/model-routes/import',
      {
        mode: jsonMode.value,
        mapping: parsed,
        // replace 模式必须回填当前条数作为确认（服务端会校验，防止误删）
        ...(jsonMode.value === 'replace'
          ? { acknowledgeRemove: routes.value.length }
          : {})
      }
    )
    toast.success(t('mapping.jsonApplied', { n: res.applied, removed: res.removed }))
    showJsonForm.value = false
    await loadRoutes()
  } catch (err) {
    if (err instanceof ApiError) {
      // 服务端会把「不存在的渠道」与「可用渠道」一并返回，直接展示出来
      const extra = (err as ApiError & { extra?: Record<string, unknown> }).extra
      jsonError.value = err.message
      void extra
    } else {
      jsonError.value = t('mapping.jsonFailed')
    }
  } finally {
    savingRoute.value = false
  }
}

const channelSelectOptions = computed(() =>
  channels.value.map((c) => ({
    value: c.id,
    label: c.name,
    hint: c.status === 'active' ? '' : t('common.disabled')
  }))
)

const batchChannel = computed(
  () => channels.value.find((c) => c.id === batchForm.channelId) ?? null
)

const batchPreview = computed(() => {
  const models = parseList(batchForm.modelsText)
  const prefix = batchForm.prefix.trim().replace(/^\/+|\/+$/g, '')
  return models.map((m) => (prefix ? prefix + '/' + m : m))
})

function openDetail(ch: Channel): void {
  location.hash = '#/channels/' + ch.id
}

async function loadRoutes(): Promise<void> {
  try {
    const res = await api.get<{ routes: ModelRoute[] }>('/api/model-routes')
    routes.value = res.routes
  } catch {
    toast.error(t('mapping.loadFailed'))
  }
}

function openRouteCreate(): void {
  routeForm.alias = ''
  routeForm.targets = [
    { channelId: channels.value[0]?.id ?? '', upstreamModel: '', priority: 100, weight: 1 }
  ]
  showRouteForm.value = true
}

function addTarget(): void {
  routeForm.targets.push({
    channelId: channels.value[0]?.id ?? '',
    upstreamModel: '',
    priority: 100,
    weight: 1
  })
}

function removeTarget(i: number): void {
  routeForm.targets.splice(i, 1)
}

async function submitRoute(): Promise<void> {
  const targets = routeForm.targets.filter((x) => x.channelId && x.upstreamModel.trim())
  if (targets.length === 0) {
    toast.error(t('mapping.saveFailed'))
    return
  }
  savingRoute.value = true
  try {
    await api.post('/api/model-routes', {
      alias: routeForm.alias.trim(),
      targets: targets.map((x) => ({
        channelId: x.channelId,
        upstreamModel: x.upstreamModel.trim(),
        priority: Number(x.priority),
        weight: Number(x.weight)
      }))
    })
    toast.success(t('mapping.created'))
    showRouteForm.value = false
    await loadRoutes()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : t('mapping.saveFailed'))
  } finally {
    savingRoute.value = false
  }
}

async function removeRoute(r: ModelRoute): Promise<void> {
  try {
    await api.del('/api/model-routes/' + r.id)
    toast.success(t('mapping.deleted'))
    await loadRoutes()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : t('mapping.deleteFailed'))
  }
}

async function purgeAlias(alias: string, n: number): Promise<void> {
  if (!confirm(t('mapping.purgeConfirm', { alias, n }))) return
  try {
    await api.post('/api/model-routes/purge', { alias })
    toast.success(t('mapping.deleted'))
    await loadRoutes()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : t('mapping.deleteFailed'))
  }
}

function openBatch(): void {
  batchForm.channelId = channels.value[0]?.id ?? ''
  batchForm.prefix = ''
  batchForm.modelsText = ''
  batchForm.priority = 100
  batchForm.weight = 1
  showBatchForm.value = true
  loadBatchModels()
}

/** 默认载入该渠道声明的模型，省去手打 */
function loadBatchModels(): void {
  batchForm.modelsText = (batchChannel.value?.models ?? []).join('\n')
}

async function submitBatch(): Promise<void> {
  const models = parseList(batchForm.modelsText)
  if (!batchForm.channelId || models.length === 0) {
    toast.error(t('mapping.batchFailed'))
    return
  }
  savingRoute.value = true
  try {
    const res = await api.post<{ created: number; merged: number }>('/api/model-routes/batch', {
      channelId: batchForm.channelId,
      prefix: batchForm.prefix.trim(),
      models,
      priority: Number(batchForm.priority),
      weight: Number(batchForm.weight)
    })
    toast.success(t('mapping.batchDone', { created: res.created, merged: res.merged }))
    showBatchForm.value = false
    await loadRoutes()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : t('mapping.batchFailed'))
  } finally {
    savingRoute.value = false
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await api.get<{ channels: Channel[] }>('/api/channels')
    channels.value = res.channels
  } catch {
    toast.error(t('channels.loadFailed'))
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, {
    name: '',
    baseUrl: '',
    apiKey: '',
    protocol: 'openai',
    vendor: 'generic',
    modelsPath: '/models',
    modelsMeta: {},
    headersText: '',
    modelsText: '',
    priority: 100,
    weight: 1,
    timeoutMs: 120000,
    status: 'active',
    note: ''
  })
  fetchState.value = null
  rawModelsBody.value = ''
  rawTruncated.value = false
  showForm.value = true
}

function openEdit(ch: Channel): void {
  editingId.value = ch.id
  Object.assign(form, {
    name: ch.name,
    baseUrl: ch.baseUrl,
    apiKey: '',
    protocol: ch.protocol,
    vendor: ch.vendor,
    modelsPath: ch.modelsPath ?? '/models',
    modelsMeta: { ...(ch.modelsMeta ?? {}) },
    headersText: headerLines(ch.extraHeaders ?? {}),
    modelsText: ch.models.join('\n'),
    priority: ch.priority,
    weight: ch.weight,
    timeoutMs: ch.timeoutMs,
    status: ch.status,
    note: ch.note
  })
  fetchState.value = null
  rawModelsBody.value = ''
  rawTruncated.value = false
  showForm.value = true
}

const fetchingModels = ref(false)
const fetchState = ref<{ ok: boolean; message: string; warnings: string[] } | null>(null)
/** 上游 /models 的原始响应体（供复制排查） */
const rawModelsBody = ref('')
const rawTruncated = ref(false)

/** 已获取到元信息的模型（用于在弹窗里展示上下文长度） */
const metaList = computed(() =>
  Object.values(form.modelsMeta)
    .filter((m) => form.modelsText.includes(m.id))
    .sort((a, b) => a.id.localeCompare(b.id))
)
const metaWithCtx = computed(() => metaList.value.filter((m) => m.contextLength !== null).length)

/**
 * 从上游拉取模型列表并自动填入。
 * 编辑已有渠道且未重新输入密钥时，走后端用已存密钥的接口；
 * 否则把当前表单里的配置（含新填的密钥）发给草稿接口。
 */
async function fetchModelsFromApi(): Promise<void> {
  fetchingModels.value = true
  fetchState.value = null
  rawModelsBody.value = ''
  rawTruncated.value = false
  try {
    const useStored = editingId.value && !form.apiKey
    const res = useStored
      ? await api.post<FetchModelsResult>('/api/channels/' + editingId.value + '/fetch-models')
      : await api.post<FetchModelsResult>('/api/channels/fetch-models', {
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey,
          modelsPath: form.modelsPath.trim() || '/models',
          timeoutMs: Number(form.timeoutMs),
          extraHeaders: parseHeaderLines(form.headersText).headers,
          vendor: form.vendor
        })

    // 无论成功失败都留一份原始响应体 —— 失败时往往更需要它
    rawModelsBody.value = res.raw ?? ''
    rawTruncated.value = res.rawTruncated === true

    if (!res.ok) {
      fetchState.value = { ok: false, message: res.message, warnings: [] }
      toast.error(res.message)
      return
    }

    // 自动填入模型列表，并记录元信息（上下文长度等）
    form.modelsText = res.models.map((m) => m.id).join('\n')
    form.modelsMeta = Object.fromEntries(res.models.map((m) => [m.id, m]))

    const withCtx = res.models.filter((m) => m.contextLength !== null).length
    fetchState.value = { ok: true, message: res.message, warnings: res.warnings }
    toast.success(
      withCtx > 0
        ? t('channels.fetchOk', { n: res.models.length, withCtx })
        : t('channels.fetchOkNoCtx', { n: res.models.length })
    )
  } catch (err) {
    const message = err instanceof ApiError ? err.message : t('channels.fetchFailed')
    fetchState.value = { ok: false, message, warnings: [] }
    toast.error(message)
  } finally {
    fetchingModels.value = false
  }
}

/** 复制上游 /models 的原始响应体 */
async function copyRawModelsBody(): Promise<void> {
  if (!rawModelsBody.value) return
  try {
    await navigator.clipboard.writeText(rawModelsBody.value)
    toast.success(
      rawTruncated.value
        ? t('channels.copiedRawTruncated')
        : t('channels.copiedRaw', { n: formatNumber(rawModelsBody.value.length) })
    )
  } catch {
    toast.error(t('toast.copyFailed'))
  }
}

async function submit(): Promise<void> {
  const parsedHeaders = parseHeaderLines(form.headersText)
  if (parsedHeaders.errors.length > 0) {
    toast.error(t('channels.headerFormatError', { msg: parsedHeaders.errors[0]! }))
    return
  }

  saving.value = true
  try {
    const modelIds = parseList(form.modelsText)

    const body = {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      protocol: form.protocol,
      vendor: form.vendor,
      extraHeaders: parsedHeaders.headers,
      modelsPath: form.modelsPath.trim() || '/models',
      // 只保留仍在模型列表里的元信息，避免留下陈旧条目
      modelsMeta: Object.fromEntries(
        Object.entries(form.modelsMeta).filter(([id]) => modelIds.includes(id))
      ),
      models: modelIds,
      priority: Number(form.priority),
      weight: Number(form.weight),
      timeoutMs: Number(form.timeoutMs),
      status: form.status,
      note: form.note
    }

    if (editingId.value) {
      await api.patch('/api/channels/' + editingId.value, {
        ...body,
        ...(form.apiKey ? { apiKey: form.apiKey } : {})
      })
      toast.success(t('channels.updated'))
    } else {
      await api.post('/api/channels', { ...body, apiKey: form.apiKey })
      toast.success(t('channels.created'))
    }
    showForm.value = false
    await load()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : t('channels.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function test(ch: Channel): Promise<void> {
  testResults[ch.id] = 'loading'
  try {
    const res = await api.post<ChannelTestResult>('/api/channels/' + ch.id + '/test')
    testResults[ch.id] = res
    ch.lastLatencyMs = res.latencyMs
    ch.lastTestAt = res.testedAt ?? new Date().toISOString()
    ch.lastTestOk = res.ok
    if (res.ok) toast.success(ch.name + ' · ' + res.latencyMs + 'ms')
    else toast.error(ch.name + ' · ' + res.message)
  } catch (err) {
    testResults[ch.id] = {
      ok: false,
      status: 0,
      latencyMs: 0,
      models: [],
      message: err instanceof ApiError ? err.message : t('channels.testFailed')
    }
    ch.lastLatencyMs = 0
    ch.lastTestAt = new Date().toISOString()
    ch.lastTestOk = false
    toast.error(t('channels.testFailed'))
  }
}

async function remove(ch: Channel): Promise<void> {
  if (!confirm(t('channels.deleteConfirm', { name: ch.name }))) return
  try {
    await api.del('/api/channels/' + ch.id)
    toast.success(t('channels.deleted'))
    await load()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : t('channels.deleteFailed'))
  }
}

function latencyOf(ch: Channel): number | null {
  const fresh = testResults[ch.id]
  if (fresh && fresh !== 'loading') return fresh.latencyMs
  return ch.lastLatencyMs
}

function latencyAt(ch: Channel): string | null {
  return testResults[ch.id] === 'loading' ? null : ch.lastTestAt
}

function latencyOk(ch: Channel): boolean {
  const fresh = testResults[ch.id]
  if (fresh && fresh !== 'loading') return fresh.ok
  return ch.lastTestOk !== false
}

onMounted(async () => {
  await load()
  await loadRoutes()
})
</script>

<template>
  <div class="stack">
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">{{ t('nav.channels') }}</div>
          <div class="dim" style="font-size: 12px">{{ t('channels.hint') }}</div>
        </div>
        <div class="row">
          <button class="btn btn-sm" @click="load">{{ t('common.refresh') }}</button>
          <button v-if="isAdmin()" class="btn btn-primary btn-sm" @click="openCreate">
            ＋ {{ t('channels.newChannel') }}
          </button>
        </div>
      </div>

      <div v-if="loading" class="loading">{{ t('common.loading') }}</div>
      <div v-else-if="channels.length === 0" class="empty">{{ t('channels.emptyHint') }}</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('common.name') }}</th>
              <th>{{ t('channels.baseUrl') }}</th>
              <th>{{ t('channels.upstreamKey') }}</th>
              <th>{{ t('channels.models') }}</th>
              <th>
                <span class="row" style="gap: 5px; display: inline-flex">
                  {{ t('channels.priority') }} / {{ t('channels.weight') }}
                  <PInfo :text="t('channels.priorityWeightHint')" />
                </span>
              </th>
              <th>{{ t('common.status') }}</th>
              <th style="min-width: 118px">{{ t('channels.latency') }}</th>
              <th style="width: 200px">{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="ch in channels"
              :key="ch.id"
              class="row-clickable"
              :title="t('channelDetail.title')"
              @click="openDetail(ch)"
            >
              <td>
                <div>{{ ch.name }}</div>
                <div class="tag-list" style="margin-top: 3px">
                  <span class="tag" :style="ch.protocol === 'mixed' ? 'color: var(--warn)' : ''">
                    {{
                      ch.protocol === 'openai'
                        ? t('channels.protocolOpenai')
                        : ch.protocol === 'anthropic'
                          ? t('channels.protocolAnthropic')
                          : ch.protocol === 'mixed'
                            ? t('channels.protocolMixed')
                            : ch.protocol
                    }}
                  </span>
                  <span v-if="ch.vendor !== 'generic'" class="tag" style="color: var(--accent)">
                    {{ ch.vendor }}
                  </span>
                  <span
                    v-if="Object.keys(ch.extraHeaders ?? {}).length > 0"
                    class="tag"
                    :title="Object.keys(ch.extraHeaders).join(', ')"
                  >
                    {{ t('channels.headersCount', { n: Object.keys(ch.extraHeaders).length }) }}
                  </span>
                </div>
                <div v-if="ch.note" class="dim" style="font-size: 11.5px; margin-top: 3px">
                  {{ ch.note }}
                </div>
              </td>
              <td class="mono" style="max-width: 240px; word-break: break-all">{{ ch.baseUrl }}</td>
              <td class="mono dim" @click.stop>
                <span class="row" style="gap: 7px">
                  <span>{{ ch.apiKeyMasked || '—' }}</span>
                  <button
                    v-if="isAdmin() && ch.hasApiKey"
                    class="btn btn-sm"
                    @click="revealChannelKey(ch)"
                  >
                    {{ t('channels.revealKey') }}
                  </button>
                </span>
              </td>
              <td>
                <span v-if="ch.models.length === 0" class="badge badge-info">
                  {{ t('channels.allModels') }}
                </span>
                <span v-else class="tag-list">
                  <span v-for="m in ch.models.slice(0, 3)" :key="m" class="tag">{{ m }}</span>
                  <span v-if="ch.models.length > 3" class="tag">+{{ ch.models.length - 3 }}</span>
                </span>
              </td>
              <td class="nowrap">{{ ch.priority }} / {{ ch.weight }}</td>
              <td>
                <span class="badge" :class="ch.status === 'active' ? 'badge-ok' : 'badge-off'">
                  {{ ch.status === 'active' ? t('common.enabled') : t('common.disabled') }}
                </span>
              </td>
              <td class="nowrap">
                <span v-if="testResults[ch.id] === 'loading'" class="dim">
                  {{ t('common.testing') }}
                </span>
                <template v-else-if="latencyOf(ch) !== null">
                  <span
                    class="badge"
                    :class="latencyOk(ch) ? 'badge-ok' : 'badge-err'"
                    :title="latencyOk(ch) ? t('channels.testTitleOk') : t('channels.testTitleFail')"
                  >
                    {{ latencyOf(ch) }} ms
                  </span>
                  <div v-if="latencyAt(ch)" class="dim" style="font-size: 11px">
                    {{ formatTime(latencyAt(ch)) }}
                  </div>
                </template>
                <span v-else class="dim">{{ t('channels.untested') }}</span>
              </td>
              <td @click.stop>
                <div class="row">
                  <button
                    class="btn btn-sm"
                    :disabled="testResults[ch.id] === 'loading'"
                    @click="test(ch)"
                  >
                    {{ testResults[ch.id] === 'loading' ? t('common.testing') : t('common.test') }}
                  </button>
                  <template v-if="isAdmin()">
                    <button class="btn btn-sm" @click="openEdit(ch)">{{ t('common.edit') }}</button>
                    <button class="btn btn-sm btn-danger" @click="remove(ch)">
                      {{ t('common.delete') }}
                    </button>
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">{{ t('mapping.title') }}</div>
          <div class="dim" style="font-size: 12px">{{ t('mapping.sub') }}</div>
        </div>
        <div class="row row-wrap">
          <button class="btn btn-sm" @click="loadRoutes">{{ t('common.refresh') }}</button>
          <template v-if="prefixGroups.length > 1">
            <button class="btn btn-sm" @click="setAllCollapsed(true)">
              {{ t('mapping.collapseAll') }}
            </button>
            <button class="btn btn-sm" @click="setAllCollapsed(false)">
              {{ t('mapping.expandAll') }}
            </button>
          </template>
          <button v-if="isAdmin()" class="btn btn-sm" @click="openJsonEditor">
            {{ t('mapping.jsonEdit') }}
          </button>
          <button v-if="isAdmin()" class="btn btn-sm" @click="openBatch">
            {{ t('mapping.batchAdd') }}
          </button>
          <button v-if="isAdmin()" class="btn btn-primary btn-sm" @click="openRouteCreate">
            ＋ {{ t('mapping.newMapping') }}
          </button>
        </div>
      </div>

      <div v-if="prefixGroups.length === 0" class="empty">{{ t('mapping.empty') }}</div>
      <div v-else class="stack" style="gap: 10px">
        <div v-for="group in prefixGroups" :key="group.prefix">
          <button class="group-head" @click="toggleGroup(group.prefix)">
            <svg
              class="group-chevron"
              :class="{ open: !collapsed[group.prefix] }"
              width="12"
              height="12"
              viewBox="0 0 12 12"
              aria-hidden="true"
            >
              <path
                d="M4 2.5 8 6l-4 3.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span class="group-name mono">
              {{ group.prefix || t('mapping.ungrouped') }}
            </span>
            <span class="dim" style="font-size: 12px">
              {{
                t('mapping.groupSummary', {
                  aliases: group.aliases.length,
                  targets: group.targetCount
                })
              }}
            </span>
          </button>

          <div v-show="!collapsed[group.prefix]" class="group-body table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{{ t('mapping.alias') }}</th>
                  <th>{{ t('mapping.channel') }}</th>
                  <th>{{ t('mapping.upstreamModel') }}</th>
                  <th>{{ t('mapping.priority') }} / {{ t('mapping.weight') }}</th>
                  <th>{{ t('common.status') }}</th>
                  <th style="width: 150px">{{ t('common.actions') }}</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="g in group.aliases" :key="g.alias">
                  <tr v-for="(r, i) in g.targets" :key="r.id">
                    <td v-if="i === 0" :rowspan="g.targets.length" style="vertical-align: top">
                      <div class="mono">{{ g.alias }}</div>
                      <div class="dim" style="font-size: 11.5px">
                        {{ t('mapping.targetsCount', { n: g.targets.length }) }}
                      </div>
                      <button
                        v-if="isAdmin()"
                        class="btn btn-sm btn-danger"
                        style="margin-top: 6px"
                        @click="purgeAlias(g.alias, g.targets.length)"
                      >
                        {{ t('mapping.purge') }}
                      </button>
                    </td>
                    <td>
                      {{ r.channelName ?? '—' }}
                      <span
                        v-if="r.channelStatus && r.channelStatus !== 'active'"
                        class="badge badge-off"
                        style="margin-left: 5px"
                      >
                        {{ t('common.disabled') }}
                      </span>
                    </td>
                    <td class="mono">{{ r.upstreamModel }}</td>
                    <td class="nowrap">{{ r.priority }} / {{ r.weight }}</td>
                    <td>
                      <span
                        class="badge"
                        :class="r.status === 'active' ? 'badge-ok' : 'badge-off'"
                      >
                        {{ r.status === 'active' ? t('common.enabled') : t('common.disabled') }}
                      </span>
                    </td>
                    <td>
                      <button
                        v-if="isAdmin()"
                        class="btn btn-sm btn-danger"
                        @click="removeRoute(r)"
                      >
                        {{ t('common.delete') }}
                      </button>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

  <Modal
    v-if="revealTarget"
    :title="t('channels.revealKeyTitle', { name: revealTarget.name })"
    wide
    @close="closeReveal"
  >
    <div class="alert">{{ t('channels.revealKeyWarning') }}</div>

    <div v-if="revealing" class="loading">{{ t('channels.revealKeyReading') }}</div>
    <div v-else-if="revealError" class="err-text">{{ revealError }}</div>
    <template v-else>
      <div class="code-box">{{ revealedKey }}</div>
      <div class="row row-wrap" style="margin-top: 12px">
        <button class="btn btn-primary btn-sm" @click="copyText(revealedKey)">
          {{ t('channels.copyFullKey') }}
        </button>
        <span class="dim mono" style="font-size: 12px">{{ revealTarget.baseUrl }}</span>
      </div>
    </template>

    <div class="modal-foot">
      <button class="btn" @click="closeReveal">{{ t('common.close') }}</button>
    </div>
  </Modal>

  <Modal
    v-if="showForm"
    :title="editingId ? t('channels.editChannel') : t('channels.newChannel')"
    wide
    @close="showForm = false"
  >
    <div class="form-grid">
      <div class="form-row">
        <div class="field">
          <label>{{ t('common.name') }}</label>
          <input v-model="form.name" placeholder="openai-main" />
        </div>
        <div class="field">
          <label>{{ t('common.status') }}</label>
          <PSelect v-model="form.status" :options="statusOptions" />
        </div>
      </div>

      <div class="form-row">
        <div class="field">
          <label>{{ t('channels.protocol') }}</label>
          <PSelect v-model="form.protocol" :options="protocolOptions" />
          <span class="hint">{{ t('channels.protocolHint') }}</span>
          <span v-if="form.protocol === 'mixed'" class="hint" style="color: var(--warn)">
            {{ t('channels.protocolMixedHint') }}
          </span>
        </div>
        <div class="field">
          <label>{{ t('channels.vendor') }}</label>
          <PSelect v-model="form.vendor" :options="vendorOptions" />
          <span v-if="form.vendor === 'opencode-go'" class="hint">
            {{ t('channels.vendorHint') }}
          </span>
        </div>
      </div>

      <div class="field">
        <label>{{ t('channels.baseUrl') }}</label>
        <input v-model="form.baseUrl" placeholder="https://api.openai.com/v1" />
        <span class="hint">{{ t('channels.baseUrlHint') }}</span>
      </div>

      <div class="field">
        <label>{{ t('channels.upstreamKey') }}</label>
        <input
          v-model="form.apiKey"
          type="password"
          :placeholder="
            editingId
              ? t('channels.upstreamKeyPlaceholderEdit')
              : t('channels.upstreamKeyPlaceholderNew')
          "
        />
        <span class="hint">{{ t('channels.upstreamKeyHint') }}</span>
      </div>

      <div class="field">
        <label>{{ t('channels.fixedHeaders') }}</label>
        <textarea
          v-model="form.headersText"
          rows="3"
          :placeholder="t('channels.fixedHeadersPlaceholder')"
        />
        <span class="hint">{{ t('channels.fixedHeadersHint') }}</span>
      </div>

      <div class="field">
        <label>{{ t('channels.modelsApiPath') }}</label>
        <input v-model="form.modelsPath" placeholder="/models" />
        <span class="hint">{{ t('channels.modelsApiPathHint') }}</span>
      </div>

      <div class="field">
        <div class="row-between">
          <label>{{ t('channels.models') }}</label>
          <div class="row">
            <button
              class="btn btn-sm"
              :disabled="fetchingModels || !form.baseUrl.trim()"
              @click="fetchModelsFromApi"
            >
              {{ fetchingModels ? t('channels.fetchingModels') : t('channels.fetchModels') }}
            </button>
            <button
              class="btn btn-sm btn-icon"
              :disabled="!rawModelsBody"
              :title="t('channels.copyRawBody')"
              @click="copyRawModelsBody"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="5.5" y="5.5" width="8" height="9" rx="1.5" />
                <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v7A1.5 1.5 0 0 0 4 12.5h1.5" />
              </svg>
            </button>
          </div>
        </div>
        <textarea
          v-model="form.modelsText"
          rows="4"
          :placeholder="t('channels.modelsPlaceholder')"
        />
        <span class="hint">{{ t('channels.modelsHint') }} · {{ t('channels.fillFromApi') }}</span>

        <div v-if="fetchState" class="hint" :class="{ 'err-text': !fetchState.ok }">
          {{ fetchState.message }}
          <template v-if="fetchState.warnings.length">
            · {{ t('channels.fetchWarnings', { n: fetchState.warnings.length }) }}
          </template>
          <template v-if="rawModelsBody">
            · {{ t('channels.rawBodySize', { n: formatNumber(rawModelsBody.length) }) }}
            <span v-if="rawTruncated">{{ t('channels.rawBodyTruncated') }}</span>
          </template>
        </div>

        <div v-if="metaList.length" style="margin-top: 8px">
          <div class="dim" style="font-size: 12px; margin-bottom: 5px">
            {{ t('channels.modelsMetaTitle') }} · {{ t('channels.modelsMetaHint') }}
          </div>
          <div class="batch-scroll" style="max-height: 160px">
            <div v-for="m in metaList" :key="m.id" class="batch-row" style="grid-template-columns: 1.6fr 1fr 1fr">
              <span class="mono" style="overflow: hidden; text-overflow: ellipsis">{{ m.id }}</span>
              <span class="nowrap">
                <span class="dim">{{ t('channels.ctxLength') }}</span>
                {{ m.contextLength === null ? '—' : m.contextLength.toLocaleString('en-US') }}
              </span>
              <span class="nowrap">
                <span class="dim">{{ t('channels.maxOutput') }}</span>
                {{ m.maxOutputTokens === null ? '—' : m.maxOutputTokens.toLocaleString('en-US') }}
              </span>
            </div>
          </div>
          <div class="dim" style="font-size: 11.5px; margin-top: 4px">
            {{ t('channels.fetchOk', { n: metaList.length, withCtx: metaWithCtx }) }}
          </div>
        </div>
      </div>

      <div class="form-row">
        <div class="field">
          <label class="row" style="gap: 5px; display: inline-flex">
            {{ t('channels.priority') }}
            <PInfo :text="t('channels.priorityHint')" />
          </label>
          <input v-model.number="form.priority" type="number" min="1" />
        </div>
        <div class="field">
          <label class="row" style="gap: 5px; display: inline-flex">
            {{ t('channels.weight') }}
            <PInfo :text="t('channels.weightHint')" />
          </label>
          <input v-model.number="form.weight" type="number" min="1" />
        </div>
      </div>

      <div class="form-row">
        <div class="field">
          <label>{{ t('channels.timeout') }}</label>
          <input v-model.number="form.timeoutMs" type="number" min="1000" />
        </div>
        <div class="field">
          <label>{{ t('common.note') }}</label>
          <input v-model="form.note" :placeholder="t('channels.notePlaceholder')" />
        </div>
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn" @click="showForm = false">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" :disabled="saving" @click="submit">
        {{ saving ? t('common.saving') : t('common.save') }}
      </button>
    </div>
  </Modal>

  <Modal
    v-if="showRouteForm"
    :title="t('mapping.newMapping')"
    wide
    @close="showRouteForm = false"
  >
    <div class="form-grid">
      <div class="field">
        <label>{{ t('mapping.alias') }}</label>
        <input v-model="routeForm.alias" :placeholder="t('mapping.aliasPlaceholder')" />
        <span class="hint">{{ t('mapping.aliasHint') }}</span>
      </div>

      <div class="field">
        <label>{{ t('mapping.targets') }}</label>
        <div class="form-grid" style="gap: 10px">
          <div
            v-for="(tg, i) in routeForm.targets"
            :key="i"
            class="card"
            style="padding: 12px; background: var(--bg-elev-2)"
          >
            <div class="row-between" style="margin-bottom: 8px">
              <span class="dim" style="font-size: 12px">
                {{ t('mapping.targetN', { n: i + 1 }) }}
              </span>
              <button
                v-if="routeForm.targets.length > 1"
                class="btn btn-ghost btn-sm"
                @click="removeTarget(i)"
              >
                {{ t('mapping.remove') }}
              </button>
            </div>
            <div class="form-row">
              <div class="field">
                <label>{{ t('mapping.channel') }}</label>
                <PSelect v-model="tg.channelId" :options="channelSelectOptions" />
              </div>
              <div class="field">
                <label>{{ t('mapping.upstreamModel') }}</label>
                <input v-model="tg.upstreamModel" placeholder="deepseek-flash" />
                <span class="hint">{{ t('mapping.upstreamHint') }}</span>
              </div>
            </div>
            <div class="form-row" style="margin-top: 10px">
              <div class="field">
                <label>{{ t('mapping.priority') }}</label>
                <input v-model.number="tg.priority" type="number" min="1" />
              </div>
              <div class="field">
                <label>{{ t('mapping.weight') }}</label>
                <input v-model.number="tg.weight" type="number" min="1" />
              </div>
            </div>
          </div>
          <button class="btn btn-sm" style="align-self: flex-start" @click="addTarget">
            {{ t('mapping.addTarget') }}
          </button>
        </div>
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn" @click="showRouteForm = false">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" :disabled="savingRoute" @click="submitRoute">
        {{ savingRoute ? t('common.saving') : t('common.save') }}
      </button>
    </div>
  </Modal>

  <Modal
    v-if="showJsonForm"
    :title="t('mapping.jsonTitle')"
    wide
    @close="showJsonForm = false"
  >
    <div class="alert alert-info">{{ t('mapping.jsonSub') }}</div>

    <div class="form-grid">
      <div class="field">
        <div class="row-between">
          <label>{{ t('mapping.alias') }} → {{ t('mapping.targets') }}</label>
          <button class="btn btn-sm" @click="jsonText = buildJson()">
            {{ t('mapping.regenerate') }}
          </button>
        </div>
        <textarea
          v-model="jsonText"
          rows="14"
          spellcheck="false"
          class="mono"
          :placeholder="t('mapping.jsonPlaceholder')"
        />
      </div>

      <div class="field">
        <label>{{ t('mapping.applyMode') }}</label>
        <PSelect v-model="jsonMode" :options="jsonModeOptions" />
      </div>

      <div v-if="jsonError" class="alert" style="margin-bottom: 0">{{ jsonError }}</div>
    </div>

    <div class="modal-foot">
      <button class="btn" @click="showJsonForm = false">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" :disabled="savingRoute" @click="applyJson">
        {{ savingRoute ? t('common.saving') : t('mapping.jsonApply') }}
      </button>
    </div>
  </Modal>

  <Modal
    v-if="showBatchForm"
    :title="t('mapping.batchTitle')"
    wide
    @close="showBatchForm = false"
  >
    <div class="alert alert-info">{{ t('mapping.batchSub') }}</div>

    <div class="form-grid">
      <div class="form-row">
        <div class="field">
          <label>{{ t('mapping.channel') }}</label>
          <PSelect
            v-model="batchForm.channelId"
            :options="channelSelectOptions"
            @update:model-value="loadBatchModels"
          />
        </div>
        <div class="field">
          <label>{{ t('mapping.prefix') }}</label>
          <input
            v-model="batchForm.prefix"
            :placeholder="t('mapping.prefixPlaceholder')"
          />
          <span class="hint">{{ t('mapping.prefixHint') }}</span>
        </div>
      </div>

      <div class="field">
        <label>{{ t('mapping.models') }}</label>
        <textarea v-model="batchForm.modelsText" rows="4" />
        <span class="hint">{{ t('mapping.modelsHint') }}</span>
        <button class="btn btn-sm" style="align-self: flex-start" @click="loadBatchModels">
          {{ t('mapping.loadChannelModels') }}
        </button>
      </div>

      <div class="form-row">
        <div class="field">
          <label>{{ t('mapping.priority') }}</label>
          <input v-model.number="batchForm.priority" type="number" min="1" />
        </div>
        <div class="field">
          <label>{{ t('mapping.weight') }}</label>
          <input v-model.number="batchForm.weight" type="number" min="1" />
        </div>
      </div>

      <div v-if="batchPreview.length" class="field">
        <label>{{ t('mapping.preview', { n: batchPreview.length }) }}</label>
        <div class="code-box" style="max-height: 130px; overflow: auto">
          {{ batchPreview.join('\n') }}
        </div>
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn" @click="showBatchForm = false">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" :disabled="savingRoute" @click="submitBatch">
        {{ savingRoute ? t('common.saving') : t('mapping.batchAdd') }}
      </button>
    </div>
  </Modal>
</template>
