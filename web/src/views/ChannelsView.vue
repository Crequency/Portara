<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  api,
  ApiError,
  type Channel,
  type ChannelTestResult,
  type ModelRoute,
  type User
} from '../api'
import Modal from '../components/Modal.vue'
import PSelect from '../components/PSelect.vue'
import { formatTime, headerLines, parseHeaderLines, parseList } from '../format'
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
  headersText: '',
  modelsText: '',
  priority: 100,
  weight: 1,
  timeoutMs: 120000,
  status: 'active' as 'active' | 'disabled',
  note: ''
})

const protocolOptions = computed(() => [
  { value: 'openai', label: t('channels.protocolOpenai') }
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
    headersText: '',
    modelsText: '',
    priority: 100,
    weight: 1,
    timeoutMs: 120000,
    status: 'active',
    note: ''
  })
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
    headersText: headerLines(ch.extraHeaders ?? {}),
    modelsText: ch.models.join('\n'),
    priority: ch.priority,
    weight: ch.weight,
    timeoutMs: ch.timeoutMs,
    status: ch.status,
    note: ch.note
  })
  showForm.value = true
}

async function submit(): Promise<void> {
  const parsedHeaders = parseHeaderLines(form.headersText)
  if (parsedHeaders.errors.length > 0) {
    toast.error(t('channels.headerFormatError', { msg: parsedHeaders.errors[0]! }))
    return
  }

  saving.value = true
  try {
    const body = {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      protocol: form.protocol,
      vendor: form.vendor,
      extraHeaders: parsedHeaders.headers,
      models: parseList(form.modelsText),
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
              <th>{{ t('channels.priority') }} / {{ t('channels.weight') }}</th>
              <th>{{ t('common.status') }}</th>
              <th style="min-width: 118px">{{ t('channels.latency') }}</th>
              <th style="width: 200px">{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="ch in channels" :key="ch.id">
              <td>
                <div>{{ ch.name }}</div>
                <div class="tag-list" style="margin-top: 3px">
                  <span class="tag">
                    {{ ch.protocol === 'openai' ? t('channels.protocolOpenai') : ch.protocol }}
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
              <td class="mono dim">{{ ch.apiKeyMasked || '—' }}</td>
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
              <td>
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
        <div class="row">
          <button class="btn btn-sm" @click="loadRoutes">{{ t('common.refresh') }}</button>
          <button v-if="isAdmin()" class="btn btn-sm" @click="openBatch">
            {{ t('mapping.batchAdd') }}
          </button>
          <button v-if="isAdmin()" class="btn btn-primary btn-sm" @click="openRouteCreate">
            ＋ {{ t('mapping.newMapping') }}
          </button>
        </div>
      </div>

      <div v-if="routeGroups.length === 0" class="empty">{{ t('mapping.empty') }}</div>
      <div v-else class="table-wrap">
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
            <template v-for="g in routeGroups" :key="g.alias">
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
                  <span class="badge" :class="r.status === 'active' ? 'badge-ok' : 'badge-off'">
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
        <label>{{ t('channels.models') }}</label>
        <textarea
          v-model="form.modelsText"
          rows="3"
          :placeholder="t('channels.modelsPlaceholder')"
        />
        <span class="hint">{{ t('channels.modelsHint') }}</span>
      </div>

      <div class="form-row">
        <div class="field">
          <label>{{ t('channels.priority') }}</label>
          <input v-model.number="form.priority" type="number" min="1" />
        </div>
        <div class="field">
          <label>{{ t('channels.weight') }}</label>
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
