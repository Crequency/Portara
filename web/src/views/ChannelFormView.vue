<script setup lang="ts">
/**
 * 渠道配置子页面（新建 / 编辑共用）。
 *
 * 以前这些配置塞在一个宽弹窗里：十来组字段上下堆叠，模型列表和元信息表
 * 还要在弹窗内部再滚一次 —— 找一项配置得来回滚，改完保存也看不清全貌。
 * 换成子页面后：字段按「基本信息 / 连接与凭据 / 模型 / 用量与额度 / 选路」
 * 分成卡片，内容区自己滚，底部操作条常驻。
 *
 * 上游账户、余额、请求日志仍在渠道详情页 —— 那里是「看」的地方，这里是「改」的地方。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { api, type Channel, type FetchModelsResult, type ModelMeta, type User } from '../api'
import PCheckbox from '../components/PCheckbox.vue'
import PInfo from '../components/PInfo.vue'
import PSelect from '../components/PSelect.vue'
import { errorText, toastError } from '../error'
import { formatNumber, headerLines, parseHeaderLines, parseList } from '../format'
import { useI18n } from '../i18n'
import { toast } from '../toast'

const props = defineProps<{ user?: User; channelId?: string }>()

const { t } = useI18n()

const isAdmin = (): boolean => props.user?.role === 'admin'
const isEdit = computed(() => Boolean(props.channelId))
/** 编辑对象 id（新建时为空串） —— 拉模型/保存都按它判断走哪条分支 */
const editingId = computed(() => props.channelId ?? '')

// 注意传 `isEdit.value`（布尔）而不是 `isEdit`（ComputedRef）——
// 否则 ref() 会原样返回那个只读的计算属性，后面就没法置位了
const loading = ref(isEdit.value)
const notFound = ref(false)
const saving = ref(false)
const channel = ref<Channel | null>(null)

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
  /** 最大并发：该渠道同时在途的上游请求上限，0 = 不限制 */
  maxConcurrency: 0,
  /** 选用的 HTTP 代理；null = 直连 */
  proxyId: null as string | null,
  /** 余额/用量适配器 id；'' = 不提供余额 */
  usageAdapter: '',
  /** 用量接口的地址覆盖（适配器的接口不在 Base URL 下时才用） */
  usageUrl: '',
  /** 耗尽判定依据：balance（余额优先）| quota（用量限额优先） */
  limitPriority: 'balance' as 'balance' | 'quota',
  /** 只暴露映射模型：未映射的模型名不出现在 /models、也不受理 */
  hideUnmappedModels: false,
  status: 'active' as 'active' | 'disabled',
  note: ''
})

/**
 * 初始快照。
 *
 * 子页面没有弹窗那层"点外面就关"的屏障，反而更容易误触后退把改动弄丢，
 * 所以拿它判断「有没有改过」，离开前问一句。
 */
const snapshot = ref('')

const dirty = computed(() => JSON.stringify(form) !== snapshot.value)

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

// ---------------------------------------------------------------- 辅助数据

const usageAdapters = ref<{ id: string; label: string; note: string }[]>([])
const usageAdapterOptions = computed(() => [
  { value: '', label: t('usage.adapterNone'), hint: '' },
  ...usageAdapters.value.map((a) => ({ value: a.id, label: a.label, hint: a.note }))
])

const proxies = ref<{ id: string; name: string; host: string; port: number; status: string }[]>([])
const proxyOptions = computed(() => [
  { value: '', label: t('channels.proxyDirect'), hint: t('channels.proxyDirectHint') },
  ...proxies.value.map((p) => ({
    value: p.id,
    label: p.name,
    hint: `${p.host}:${p.port}${p.status === 'disabled' ? ' · ' + t('common.disabled') : ''}`
  }))
])

async function loadSupport(): Promise<void> {
  // 三者互不依赖，任一失败都不该拦住表单 —— 拿不到就用内置默认
  void api
    .get<{ settings: { defaultChannelTimeoutMs: number } }>('/api/settings')
    .then((res) => {
      // 新建页补上「系统设置里的默认超时」；用户已经动过表单就不覆盖，
      // 顺带把快照更新掉 —— 自动填的默认值不该被算成「未保存的修改」
      if (!isEdit.value && !dirty.value && res.settings.defaultChannelTimeoutMs) {
        form.timeoutMs = res.settings.defaultChannelTimeoutMs
        snapshot.value = JSON.stringify(form)
      }
    })
    .catch(() => {
      /* 操作员拿不到系统设置 —— 用表单里的内置默认即可 */
    })

  void api
    .get<{ adapters: typeof usageAdapters.value }>('/api/usage/adapters')
    .then((res) => {
      usageAdapters.value = res.adapters
    })
    .catch(() => {
      usageAdapters.value = []
    })

  void api
    .get<{ proxies: typeof proxies.value }>('/api/proxies')
    .then((res) => {
      proxies.value = res.proxies
    })
    .catch(() => {
      proxies.value = []
    })
}

/** 把渠道的当前配置灌进表单；密钥留空表示「不修改」 */
function fill(ch: Channel): void {
  Object.assign(form, {
    name: ch.name,
    baseUrl: ch.baseUrl,
    apiKey: '',
    protocol: ch.protocol,
    vendor: ch.vendor,
    modelsPath: ch.modelsPath ?? '/models',
    modelsMeta: { ...(ch.modelsMeta ?? {}) },
    proxyId: ch.proxyId ?? null,
    usageAdapter: ch.usageAdapter ?? '',
    usageUrl: ch.usageUrl ?? '',
    limitPriority: ch.limitPriority ?? 'balance',
    hideUnmappedModels: ch.hideUnmappedModels === true,
    headersText: headerLines(ch.extraHeaders ?? {}),
    modelsText: ch.models.join('\n'),
    priority: ch.priority,
    weight: ch.weight,
    timeoutMs: ch.timeoutMs,
    // 后端尚未提供该字段时按「不限制」回填，而不是把表单留成 NaN / undefined
    maxConcurrency: ch.maxConcurrency ?? 0,
    status: ch.status,
    note: ch.note
  })
}

async function loadChannel(): Promise<void> {
  if (!props.channelId) {
    // 新建：先落一份快照，之后再算「是否改过」
    snapshot.value = JSON.stringify(form)
    return
  }
  loading.value = true
  try {
    const res = await api.get<{ channel: Channel }>('/api/channels/' + props.channelId)
    channel.value = res.channel
    fill(res.channel)
    snapshot.value = JSON.stringify(form)
  } catch (err) {
    notFound.value = true
    toastError(err, t('channels.loadFailed'))
  } finally {
    loading.value = false
  }
}

// ---------------------------------------------------------------- 模型

const fetchingModels = ref(false)
const fetchState = ref<{ ok: boolean; message: string; warnings: string[] } | null>(null)
/** 上游 /models 的原始响应体（供复制排查） */
const rawModelsBody = ref('')
const rawTruncated = ref(false)

/** 已在模型列表里的模型（用于展示上下文长度等元信息） */
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
    const message = errorText(err, t('channels.fetchFailed'))
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

// ---------------------------------------------------------------- 导航与保存

function back(): void {
  // 编辑态回详情，新建态回列表 —— 与各自进入时的位置对称
  location.hash = props.channelId ? '#/channels/' + props.channelId : '#/channels'
}

function cancel(): void {
  if (dirty.value && !confirm(t('channels.unsavedConfirm'))) return
  back()
}

function openDetail(): void {
  if (props.channelId) location.hash = '#/channels/' + props.channelId
}

async function save(): Promise<void> {
  if (!form.name.trim()) {
    toast.error(t('channels.nameRequired'))
    return
  }
  if (!form.baseUrl.trim()) {
    toast.error(t('channels.baseUrlRequired'))
    return
  }

  const maxConcurrency = Number(form.maxConcurrency ?? 0)
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 0) {
    toast.error(t('channels.maxConcurrencyInvalid'))
    return
  }

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
      maxConcurrency,
      proxyId: form.proxyId || null,
      usageAdapter: form.usageAdapter || '',
      usageUrl: form.usageUrl.trim(),
      limitPriority: form.limitPriority,
      hideUnmappedModels: form.hideUnmappedModels,
      status: form.status,
      note: form.note
    }

    let id = props.channelId ?? ''
    if (id) {
      await api.patch('/api/channels/' + id, {
        ...body,
        // 留空表示不修改密钥 —— 不能把空串发上去，那会把已存的 Key 抹掉
        ...(form.apiKey ? { apiKey: form.apiKey } : {})
      })
      toast.success(t('channels.updated'))
    } else {
      const res = await api.post<{ channel: Channel }>('/api/channels', {
        ...body,
        apiKey: form.apiKey
      })
      id = res.channel.id
      toast.success(t('channels.created'))
    }

    // 保存后离开表单页：不留在原地，否则用户会以为还没提交
    location.hash = '#/channels/' + id
  } catch (err) {
    toastError(err, t('channels.saveFailed'))
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  // 操作员进不来这个页面（上面有权限卡片），也就没必要替他们发这些请求 ——
  // 那些接口对操作员是 403，白白在控制台刷一串失败。
  if (!isAdmin()) return
  await loadChannel()
  void loadSupport()
})
</script>

<template>
  <div v-if="!isAdmin()" class="card">
    <div class="empty">{{ t('nav.noPermission') }}</div>
    <div class="row" style="justify-content: center">
      <button class="btn btn-sm" @click="back">{{ t('channelDetail.back') }}</button>
    </div>
  </div>

  <div v-else-if="loading" class="loading">{{ t('common.loading') }}</div>

  <div v-else-if="notFound" class="card">
    <div class="empty">{{ t('channelDetail.notFound') }}</div>
    <div class="row" style="justify-content: center">
      <button class="btn btn-sm" @click="back">{{ t('channelDetail.back') }}</button>
    </div>
  </div>

  <div v-else class="form-page fill-view">
    <!--
      卡片在中间这一层滚动，底部操作条留在滚动区之外 ——
      这样「保存」永远在视口底部，而滚动条仍然贴着内容区右边缘。
    -->
    <div class="form-scroll">
      <div class="stack form-column">
        <!-- 顶部：位置与去向 -->
        <div class="card">
          <div class="row row-wrap">
            <button class="btn btn-sm" @click="cancel">← {{ t('channelDetail.back') }}</button>
            <span class="spacer" />
            <span v-if="channel" class="dim mono" style="font-size: 12px">
              {{ channel.apiKeyMasked || t('channels.keyEmpty') }}
            </span>
            <button v-if="isEdit" class="btn btn-sm" @click="openDetail">
              {{ t('channels.openDetail') }}
            </button>
          </div>
        </div>

        <!-- 基本信息 -->
        <div class="card">
          <div class="card-head">
            <div class="card-title">{{ t('channels.sectionBasic') }}</div>
          </div>

          <div class="form-grid">
            <div class="form-row">
              <div class="field">
                <label>{{ t('common.name') }}</label>
                <input v-model="form.name" placeholder="openai-main" />
                <span class="hint">{{ t('channels.nameHint') }}</span>
              </div>
              <div class="field">
                <label>{{ t('common.status') }}</label>
                <PSelect v-model="form.status" :options="statusOptions" />
                <span class="hint">{{ t('channels.statusHint') }}</span>
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
              <label>{{ t('common.note') }}</label>
              <input v-model="form.note" :placeholder="t('channels.notePlaceholder')" />
            </div>
          </div>
        </div>

        <!-- 连接与凭据 -->
        <div class="card">
          <div class="card-head">
            <div class="card-title">{{ t('channels.sectionConnection') }}</div>
          </div>

          <div class="form-grid">
            <div class="field">
              <label>{{ t('channels.baseUrl') }}</label>
              <input v-model="form.baseUrl" placeholder="https://api.openai.com/v1" />
              <span class="hint">{{ t('channels.baseUrlHint') }}</span>
            </div>

            <div class="form-row">
              <div class="field">
                <label>{{ t('channels.upstreamKey') }}</label>
                <input
                  v-model="form.apiKey"
                  type="password"
                  :placeholder="
                    isEdit
                      ? t('channels.upstreamKeyPlaceholderEdit')
                      : t('channels.upstreamKeyPlaceholderNew')
                  "
                />
                <span class="hint">{{ t('channels.upstreamKeyHint') }}</span>
              </div>
              <div class="field">
                <label>{{ t('channels.modelsApiPath') }}</label>
                <input v-model="form.modelsPath" placeholder="/models" />
                <span class="hint">{{ t('channels.modelsApiPathHint') }}</span>
              </div>
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

            <div class="form-row">
              <div class="field">
                <label>{{ t('channels.proxy') }}</label>
                <!-- PSelect 的值类型是 string，而 proxyId 可为 null（= 直连），这里显式转换 -->
                <PSelect
                  :model-value="form.proxyId ?? ''"
                  :options="proxyOptions"
                  @update:model-value="form.proxyId = $event || null"
                />
                <span class="hint">{{ t('channels.proxyHint') }}</span>
              </div>
              <div class="field">
                <label>{{ t('channels.timeout') }}</label>
                <input v-model.number="form.timeoutMs" type="number" min="1000" />
                <span class="hint">{{ t('channels.timeoutHint') }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 模型 -->
        <div class="card">
          <div class="card-head">
            <div class="card-title">{{ t('channels.sectionModels') }}</div>
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

          <div class="form-grid">
            <div class="field">
              <label>{{ t('channels.models') }}</label>
              <textarea
                v-model="form.modelsText"
                rows="6"
                :placeholder="t('channels.modelsPlaceholder')"
              />
              <span class="hint">{{ t('channels.modelsHint') }} · {{ t('channels.fillFromApi') }}</span>
            </div>

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

            <div class="field">
              <PCheckbox
                v-model="form.hideUnmappedModels"
                :label="t('channels.hideUnmappedModels')"
              />
              <span class="hint">{{ t('channels.hideUnmappedModelsHint') }}</span>
            </div>

            <div v-if="metaList.length">
              <div class="dim" style="font-size: 12px; margin-bottom: 5px">
                {{ t('channels.modelsMetaTitle') }} · {{ t('channels.modelsMetaHint') }}
              </div>
              <div class="batch-scroll" style="max-height: 220px">
                <div
                  v-for="m in metaList"
                  :key="m.id"
                  class="batch-row"
                  style="grid-template-columns: 1.6fr 1fr 1fr"
                >
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
        </div>

        <!-- 用量与额度 -->
        <div class="card">
          <div class="card-head">
            <div class="card-title">{{ t('channels.sectionQuota') }}</div>
          </div>

          <div class="form-grid">
            <div class="form-row">
              <div class="field">
                <label>{{ t('usage.adapterField') }}</label>
                <PSelect v-model="form.usageAdapter" :options="usageAdapterOptions" />
                <span class="hint">{{ t('usage.adapterHint') }}</span>
              </div>
              <div v-if="form.usageAdapter" class="field">
                <label>{{ t('usage.limitPriority') }}</label>
                <PSelect
                  v-model="form.limitPriority"
                  :options="[
                    { value: 'balance', label: t('usage.limitPriorityBalance') },
                    { value: 'quota', label: t('usage.limitPriorityQuota') }
                  ]"
                />
                <span class="hint">{{ t('usage.limitPriorityHint') }}</span>
              </div>
            </div>

            <div v-if="form.usageAdapter" class="field">
              <label>{{ t('usage.urlField') }}</label>
              <input v-model="form.usageUrl" placeholder="https://api.example.com" />
              <span class="hint">{{ t('usage.urlFieldHint') }}</span>
            </div>
          </div>
        </div>

        <!-- 选路与权重 -->
        <div class="card">
          <div class="card-head">
            <div class="card-title">{{ t('channels.sectionRouting') }}</div>
          </div>

          <div class="form-grid">
            <div class="form-row">
              <div class="field">
                <label class="row" style="gap: 5px; display: inline-flex">
                  {{ t('channels.priority') }}
                  <PInfo :text="t('channels.priorityHint')" />
                </label>
                <input v-model.number="form.priority" type="number" min="1" />
                <span class="hint">{{ t('channels.priorityHint') }}</span>
              </div>
              <div class="field">
                <label class="row" style="gap: 5px; display: inline-flex">
                  {{ t('channels.weight') }}
                  <PInfo :text="t('channels.weightHint')" />
                </label>
                <input v-model.number="form.weight" type="number" min="1" />
                <span class="hint">{{ t('channels.weightHint') }}</span>
              </div>
            </div>

            <div class="field">
              <label class="row" style="gap: 5px; display: inline-flex">
                {{ t('channels.maxConcurrency') }}
                <PInfo :text="t('channels.maxConcurrencyHint')" />
              </label>
              <input
                v-model.number="form.maxConcurrency"
                type="number"
                min="0"
                step="1"
                placeholder="0"
              />
              <span class="hint">{{ t('channels.maxConcurrencyHint') }}</span>
            </div>

            <div v-if="isEdit" class="alert alert-info" style="margin-bottom: 0">
              {{ t('channels.formAccountsHint') }}
              <button class="btn btn-sm" style="margin-left: 8px" @click="openDetail">
                {{ t('channels.openDetail') }}
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- 底部操作条：常驻可见，改完不必滚回顶部 -->
    <div class="form-bar">
      <div class="form-column form-bar-inner">
        <button class="btn" @click="cancel">{{ t('common.cancel') }}</button>
        <!-- 放在操作条上而不是卡片里：卡片会滚走，这里一直看得见 -->
        <span v-if="dirty" class="dim" style="font-size: 12px">{{ t('channels.unsaved') }}</span>
        <span class="spacer" />
        <button
          class="btn btn-primary"
          :disabled="saving || (isEdit && !dirty)"
          @click="save"
        >
          {{ saving ? t('common.saving') : t('common.save') }}
        </button>
      </div>
    </div>
  </div>
</template>
