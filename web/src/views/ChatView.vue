<script setup lang="ts">
/**
 * 对话测试 —— 用 Portara 自己签发的 Key 走一遍真实网关链路。
 *
 * 两种测试对象：
 *   gateway：带 Bearer Key 打本站 /v1，治理全链路真实生效
 *   channel：带会话 Cookie 打 /api/channels/:id/chat，服务端用渠道自己的
 *            Key 与固定请求头直连上游，绕过网关治理（诊断用途）
 *
 * 不做会话管理：每次进入即新会话，刷新即清空；明文密钥只在本页内存中。
 */
import { errorText } from '../error'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { api, type ApiKey, type Channel, type ChannelAccount, type User } from '../api'
import Modal from '../components/Modal.vue'
import PCheckbox from '../components/PCheckbox.vue'
import PCombobox from '../components/PCombobox.vue'
import PSelect from '../components/PSelect.vue'
import { formatCompact, formatLatency } from '../format'
import { useI18n } from '../i18n'
import { toast } from '../toast'

const props = defineProps<{ user?: User }>()

const { t } = useI18n()

type TestTarget = 'gateway' | 'channel'

interface ChatMeta {
  model: string
  latencyMs: number
  ttftMs: number | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 直连测试时真正出这个响应的上游账户；网关链路为空 */
  account?: string
  /** 这个账户之前被跳过（可重试失败）的账户数 */
  skipped?: number
}

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  failed?: boolean
  pending?: boolean
  meta?: ChatMeta
}

const testTarget = ref<TestTarget>('gateway')
const keys = ref<ApiKey[]>([])
const keyId = ref('')
const channels = ref<Channel[]>([])
const channelId = ref('')
/** 直连测试要试哪些上游账户（多选，按面板顺序回退） */
const accountIds = ref<string[]>([])
const models = ref<string[]>([])
const model = ref('')
const messages = ref<ChatMessage[]>([])
const input = ref('')
const sending = ref(false)
const useStream = ref(true)
const keyError = ref('')
const loadingModels = ref(false)

const scroller = ref<HTMLElement | null>(null)
let seq = 0
let plainKey = ''
let plainKeyFor = ''

const isAdmin = computed(() => props.user?.role === 'admin')
const selectedKey = computed(() => keys.value.find((k) => k.id === keyId.value) ?? null)
const selectedChannel = computed(
  () => channels.value.find((ch) => ch.id === channelId.value) ?? null
)

const channelAccounts = computed(() => selectedChannel.value?.accounts ?? [])

/** 主账户 = 创建最早的那个 —— 与后端 primaryAccount() 的判定保持一致 */
const primaryAccountId = computed(() => {
  let best: ChannelAccount | null = null
  for (const a of channelAccounts.value) {
    if (!best || a.createdAt < best.createdAt) best = a
  }
  return best?.id ?? ''
})

const allAccountsSelected = computed(
  () => channelAccounts.value.length > 0 && accountIds.value.length === channelAccounts.value.length
)

const keyOptions = computed(() =>
  keys.value.map((k) => ({
    value: k.id,
    label: k.name,
    hint:
      k.keyPrefix +
      '…' +
      (k.status === 'active' ? '' : ' ' + t('chat.keyDisabled')) +
      (k.revealable ? '' : ' ' + t('chat.keyNotRevealable'))
  }))
)

const channelOptions = computed(() =>
  channels.value.map((c) => ({
    value: c.id,
    label: c.name,
    hint: c.baseUrl
  }))
)

const targetReady = computed(() =>
  testTarget.value === 'gateway' ? !!keyId.value : !!channelId.value
)

const canSend = computed(
  () =>
    !sending.value &&
    input.value.trim().length > 0 &&
    targetReady.value &&
    model.value.trim().length > 0
)

/**
 * 账户选择跟随渠道。
 *
 * 换渠道时丢掉不属于该渠道的 id；一个都没剩下就回到主账户 ——
 * 那正是引入多账户之前「直连测试只用主账户」的行为，不做静默改变。
 */
function syncAccountSelection(): void {
  const list = channelAccounts.value
  const valid = new Set(list.map((a) => a.id))
  const kept = accountIds.value.filter((id) => valid.has(id))
  accountIds.value = kept.length > 0 ? kept : primaryAccountId.value ? [primaryAccountId.value] : []
}

function toggleAccount(id: string): void {
  const i = accountIds.value.indexOf(id)
  if (i >= 0) {
    // 至少留一个：全不选会被服务端当成「用主账户」，与面板所见不符
    if (accountIds.value.length === 1) return
    accountIds.value.splice(i, 1)
    return
  }
  // 保持渠道账户列表的顺序，这样「按顺序回退」在界面上是可见的
  const order = channelAccounts.value.map((a) => a.id)
  accountIds.value = [...accountIds.value, id].sort((a, b) => order.indexOf(a) - order.indexOf(b))
}

/** 全选 / 只留主账户 —— 一键在「随便哪个通都行」与「只测主号」之间切换 */
function toggleAllAccounts(): void {
  accountIds.value = allAccountsSelected.value
    ? primaryAccountId.value
      ? [primaryAccountId.value]
      : []
    : channelAccounts.value.map((a) => a.id)
}

/**
 * 悬浮信息里的账户注解。
 *
 * 拆成「账户 + 跳过数」两段再拼，是为了让中文的「（跳过 1 个）」紧贴账户名、
 * 英文的 ` (skipped 1)` 自带前导空格 —— 模板里换行会各自多出一个空格。
 */
function accountNote(meta: ChatMeta): string {
  const head = t('chat.metaAccount', { name: meta.account ?? '' })
  return meta.skipped ? head + t('chat.metaSkipped', { n: meta.skipped }) : head
}

/**
 * 直连测试的 URL。
 *
 * 多选时按顺序传给服务端（`accountIds=a,b`），由服务端逐个尝试、
 * 只在可重试的失败（401/402/403/429/5xx）上换号 ——
 * 前端不自己循环，否则一次「渠道测试」会在面板上留下多条残缺记录。
 */
function channelChatUrl(): string {
  const base = '/api/channels/' + channelId.value + '/chat'
  return accountIds.value.length > 0
    ? base + '?accountIds=' + encodeURIComponent(accountIds.value.join(','))
    : base
}

/** 从响应头取「这次是谁出的力」；账户名是 encodeURIComponent 过的（HTTP 头只吃 latin-1） */
function accountHeaders(res: Response): { account?: string; skipped?: number } {
  const raw = res.headers.get('x-portara-account')
  if (!raw) return {}
  let account = raw
  try {
    account = decodeURIComponent(raw)
  } catch {
    /* 解不开就按原样显示 */
  }
  const n = Number(res.headers.get('x-portara-skipped') ?? '0')
  return { account, skipped: Number.isFinite(n) ? n : 0 }
}

async function loadKeys(): Promise<void> {
  try {
    const res = await api.get<{ keys: ApiKey[] }>('/api/keys')
    keys.value = res.keys
  } catch {
    toast.error(t('chat.loadKeysFailed'))
  }
}

async function loadChannels(): Promise<void> {
  try {
    const res = await api.get<{ channels: Channel[] }>('/api/channels')
    channels.value = res.channels
  } catch {
    toast.error(t('chat.loadChannelsFailed'))
  }
}

async function ensurePlainKey(): Promise<string> {
  if (!keyId.value) throw new Error(t('chat.pickKeyFirst'))
  if (plainKey && plainKeyFor === keyId.value) return plainKey
  const res = await api.get<{ key: string }>('/api/keys/' + keyId.value + '/reveal')
  plainKey = res.key
  plainKeyFor = keyId.value
  return plainKey
}

async function loadModels(): Promise<void> {
  models.value = []
  keyError.value = ''

  if (testTarget.value === 'channel') {
    if (!channelId.value) return
    models.value = selectedChannel.value?.models ?? []
    if (models.value.length > 0 && !models.value.includes(model.value)) {
      model.value = models.value[0]!
    }
    return
  }

  if (!keyId.value) return

  loadingModels.value = true
  try {
    const token = await ensurePlainKey()
    const res = await fetch('/v1/models', { headers: { authorization: 'Bearer ' + token } })
    const json = (await res.json()) as { data?: { id: string }[]; error?: { message: string } }
    if (!res.ok) {
      keyError.value = json?.error?.message ?? 'HTTP ' + res.status
      return
    }
    models.value = (json.data ?? []).map((m) => m.id)
    if (models.value.length > 0 && !models.value.includes(model.value)) {
      model.value = models.value[0]!
    }
  } catch (err) {
    keyError.value = errorText(err, t('keys.revealFailed'))
  } finally {
    loadingModels.value = false
  }
}

watch([keyId, channelId, testTarget, channels], () => {
  // 账户选择必须先进位，再拉模型 —— 否则首帧的模型列表与所选账户对不上号
  if (testTarget.value === 'channel') syncAccountSelection()
  void loadModels()
})

async function scrollToBottom(): Promise<void> {
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
}

function newSession(): void {
  messages.value = []
  input.value = ''
  keyError.value = ''
}

async function send(): Promise<void> {
  if (!canSend.value) return

  const text = input.value.trim()
  input.value = ''

  messages.value.push({ id: ++seq, role: 'user', content: text })
  const assistant: ChatMessage = { id: ++seq, role: 'assistant', content: '', pending: true }
  messages.value.push(assistant)
  await scrollToBottom()

  sending.value = true
  const startedAt = Date.now()
  let ttftMs: number | null = null
  let meta: ChatMeta = {
    model: model.value,
    latencyMs: 0,
    ttftMs: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  }

  try {
    const history = messages.value
      .filter((m) => !m.pending && m.content)
      .map((m) => ({ role: m.role, content: m.content }))

    const payload = {
      model: model.value.trim(),
      messages: history,
      stream: useStream.value,
      ...(useStream.value ? { stream_options: { include_usage: true } } : {})
    }

    let res: Response
    if (testTarget.value === 'channel') {
      res = await fetch(channelChatUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
    } else {
      const token = await ensurePlainKey()
      res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify(payload)
      })
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
      const who = testTarget.value === 'channel' ? t('chat.upstream') : t('chat.gateway')
      throw new Error(body?.error?.message ?? who + ' HTTP ' + res.status)
    }

    // 直连测试：记下这次是哪把上游 Key 出的力（多选时可能是备用号）
    const served = testTarget.value === 'channel' ? accountHeaders(res) : {}

    if (!useStream.value) {
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }
      assistant.content = body.choices?.[0]?.message?.content ?? t('chat.emptyResponse')
      meta = {
        ...meta,
        ...served,
        latencyMs: Date.now() - startedAt,
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
        totalTokens: body.usage?.total_tokens ?? 0
      }
    } else {
      meta = { ...meta, ...served }
      const reader = res.body?.getReader()
      if (!reader) throw new Error(t('chat.noStream'))

      const decoder = new TextDecoder()
      let buf = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (ttftMs === null) ttftMs = Date.now() - startedAt
        buf += decoder.decode(value, { stream: true })

        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const p = line.slice(5).trim()
          if (p === '[DONE]') continue
          try {
            const chunk = JSON.parse(p) as {
              choices?: { delta?: { content?: string } }[]
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
            }
            const delta = chunk.choices?.[0]?.delta?.content
            if (delta) {
              assistant.content += delta
              void scrollToBottom()
            }
            if (chunk.usage) {
              meta = {
                ...meta,
                promptTokens: chunk.usage.prompt_tokens ?? 0,
                completionTokens: chunk.usage.completion_tokens ?? 0,
                totalTokens: chunk.usage.total_tokens ?? 0
              }
            }
          } catch {
            /* 心跳等非 JSON 行 */
          }
        }
      }

      meta = { ...meta, latencyMs: Date.now() - startedAt, ttftMs }
      if (!assistant.content) assistant.content = t('chat.emptyResponse')
    }
  } catch (err) {
    assistant.failed = true
    assistant.content = err instanceof Error ? err.message : String(err)
  } finally {
    assistant.pending = false
    if (!assistant.failed && meta.latencyMs === 0) {
      meta.latencyMs = Date.now() - startedAt
      meta.ttftMs = ttftMs
    }
    if (!assistant.failed) assistant.meta = meta
    sending.value = false
    await scrollToBottom()
  }
}


// ---------------------------------------------------------------- 批量测试

interface BatchResult {
  model: string
  status: 'pending' | 'running' | 'ok' | 'error'
  statusCode?: number
  latencyMs?: number
  totalTokens?: number
  content?: string
  error?: string
  /** 直连测试时是哪个上游账户应答的（多选会回退，所以每条都可能不同） */
  account?: string
}

const batchOpen = ref(false)
const batchSelected = ref<string[]>([])
const batchPrompt = ref('')
const batchSearch = ref('')
const batchRunning = ref(false)
const batchStopped = ref(false)
const batchConcurrency = ref(3)
const batchResults = ref<BatchResult[]>([])

/** 可测试的模型：跟随当前测试对象（网关模式=该 Key 可见模型，渠道模式=该渠道声明模型） */
const batchCandidates = computed(() => {
  const q = batchSearch.value.trim().toLowerCase()
  const all = models.value
  return q ? all.filter((m) => m.toLowerCase().includes(q)) : all
})

const batchDoneCount = computed(
  () => batchResults.value.filter((r) => r.status === 'ok' || r.status === 'error').length
)

const batchSummary = computed(() => {
  const done = batchResults.value.filter((r) => r.status === 'ok' || r.status === 'error')
  const ok = done.filter((r) => r.status === 'ok')
  const fail = done.length - ok.length
  const avg =
    ok.length > 0
      ? Math.round(ok.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0) / ok.length)
      : 0
  return { ok: ok.length, fail, avg, total: batchResults.value.length }
})

/** 网关模式下可能触发限流时给出预警 */
const batchRpmWarning = computed(() => {
  if (testTarget.value !== 'gateway') return ''
  const rpm = selectedKey.value?.rpmLimit ?? 0
  if (rpm <= 0) return ''
  const n = batchSelected.value.length
  if (n <= rpm) return ''
  return t('chat.batchRpmWarning', { rpm, n })
})

function openBatch(): void {
  batchSelected.value = []
  batchResults.value = []
  batchSearch.value = ''
  batchPrompt.value = input.value.trim()
  batchRunning.value = false
  batchStopped.value = false
  batchOpen.value = true
}

function closeBatch(): void {
  if (batchRunning.value) batchStopped.value = true
  batchOpen.value = false
}

function toggleBatchModel(m: string): void {
  const i = batchSelected.value.indexOf(m)
  if (i >= 0) batchSelected.value.splice(i, 1)
  else batchSelected.value.push(m)
}

function selectAllBatch(): void {
  batchSelected.value = [...new Set([...batchSelected.value, ...batchCandidates.value])]
}

function invertBatch(): void {
  const set = new Set(batchSelected.value)
  batchSelected.value = batchCandidates.value.filter((m) => !set.has(m))
}

function clearBatch(): void {
  batchSelected.value = []
}

/** 单个模型的请求（批量统一用非流式，便于直接取到 usage） */
async function requestOne(
  model: string,
  prompt: string
): Promise<Partial<BatchResult>> {
  const started = Date.now()
  const payload = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false
  }

  let res: Response
  if (testTarget.value === 'channel') {
    res = await fetch(channelChatUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  } else {
    const token = await ensurePlainKey()
    res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(payload)
    })
  }

  const text = await res.text()
  let body: {
    choices?: { message?: { content?: string } }[]
    usage?: { total_tokens?: number }
    error?: { message?: string }
  } | null = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }

  const latencyMs = Date.now() - started

  const served = testTarget.value === 'channel' ? accountHeaders(res) : {}

  if (!res.ok) {
    return {
      status: 'error',
      statusCode: res.status,
      latencyMs,
      error: body?.error?.message ?? text.slice(0, 200) ?? 'HTTP ' + res.status,
      account: served.account
    }
  }

  return {
    status: 'ok',
    statusCode: res.status,
    latencyMs,
    totalTokens: body?.usage?.total_tokens ?? 0,
    content: body?.choices?.[0]?.message?.content ?? t('chat.emptyResponse'),
    account: served.account
  }
}

/** 有限并发地跑完所有选中模型 */
async function runBatch(): Promise<void> {
  const selected = [...batchSelected.value]
  if (selected.length === 0) {
    toast.error(t('chat.batchEmptySelection'))
    return
  }
  const prompt = batchPrompt.value.trim()
  if (!prompt) {
    toast.error(t('chat.batchNoPrompt'))
    return
  }

  batchResults.value = selected.map((m) => ({ model: m, status: 'pending' as const }))
  batchRunning.value = true
  batchStopped.value = false

  const queue = selected.map((model, index) => ({ model, index }))
  const workers = Math.max(1, Math.min(Number(batchConcurrency.value) || 1, queue.length))

  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        if (batchStopped.value) return
        const item = queue.shift()
        if (!item) return
        const row = batchResults.value[item.index]
        if (!row) return
        row.status = 'running'
        try {
          Object.assign(row, await requestOne(item.model, prompt))
        } catch (err) {
          row.status = 'error'
          row.error = err instanceof Error ? err.message : String(err)
        }
      }
    })
  )

  batchRunning.value = false
}

function stopBatch(): void {
  batchStopped.value = true
}

async function copyBatchJson(): Promise<void> {
  const data = batchResults.value.map((r) => ({
    model: r.model,
    status: r.status,
    statusCode: r.statusCode ?? null,
    latencyMs: r.latencyMs ?? null,
    totalTokens: r.totalTokens ?? null,
    response: r.content ?? null,
    error: r.error ?? null
  }))
  try {
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2))
    toast.success(t('toast.copied'))
  } catch {
    toast.error(t('toast.copyFailed'))
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
}

onMounted(async () => {
  await Promise.all([loadKeys(), loadChannels()])
  const first = keys.value.find((k) => k.status === 'active' && k.revealable) ?? keys.value[0]
  if (first) keyId.value = first.id
  const firstChannel = channels.value.find((ch) => ch.status === 'active') ?? channels.value[0]
  if (firstChannel) channelId.value = firstChannel.id
})
</script>

<template>
  <div v-if="!isAdmin" class="card">
    <div class="empty">
      {{ t('chat.adminOnly', { role: user?.role ?? '—' }) }}
    </div>
  </div>

  <div v-else class="stack">
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">{{ t('chat.title') }}</div>
          <div class="dim" style="font-size: 12px">
            <template v-if="testTarget === 'gateway'">{{ t('chat.subGateway') }}</template>
            <template v-else>
              {{ t('chat.subChannel', { url: selectedChannel?.baseUrl ?? '—' }) }}
            </template>
          </div>
        </div>
        <div class="row row-wrap">
          <button class="btn btn-sm" @click="loadModels">{{ t('chat.refreshModels') }}</button>
          <button
            class="btn btn-sm"
            :disabled="models.length === 0"
            @click="openBatch"
          >
            {{ t('chat.batchTest') }}
          </button>
          <button class="btn btn-sm" @click="newSession">{{ t('chat.newSession') }}</button>
        </div>
      </div>

      <div class="row row-wrap" style="margin-bottom: 14px">
        <span class="dim" style="font-size: 12.5px">{{ t('chat.target') }}</span>
        <div class="segmented">
          <button :class="{ on: testTarget === 'gateway' }" @click="testTarget = 'gateway'">
            {{ t('chat.targetGateway') }}
          </button>
          <button :class="{ on: testTarget === 'channel' }" @click="testTarget = 'channel'">
            {{ t('chat.targetChannel') }}
          </button>
        </div>
      </div>

      <div class="form-row">
        <div v-if="testTarget === 'gateway'" class="field">
          <label>{{ t('chat.keyLabel') }}</label>
          <PSelect v-model="keyId" :options="keyOptions" :placeholder="t('chat.pick')" />
          <span class="hint">{{ t('chat.keyHint') }}</span>
        </div>

        <div v-else class="field">
          <label>{{ t('chat.channelLabel') }}</label>
          <PSelect v-model="channelId" :options="channelOptions" :placeholder="t('chat.pick')" />
          <span class="hint">{{ t('chat.channelHint') }}</span>
        </div>

        <div class="field">
          <label>
            {{ t('chat.modelLabel') }}
            <span v-if="models.length" class="dim">（{{ models.length }}）</span>
            {{ loadingModels ? t('chat.modelLoading') : '' }}
          </label>
          <!-- 自绘 combobox：列出全部模型，且仍可手输任意模型名 -->
          <PCombobox
            v-model="model"
            :options="models"
            :placeholder="t('chat.modelPlaceholder')"
          />
          <span v-if="models.length === 0 && !loadingModels" class="hint">
            {{ t('chat.noModels') }}
          </span>
        </div>
      </div>

      <!--
        直连测试：测哪个（哪些）上游账户。
        多选时服务端按顺序逐个尝试、只在可重试的失败上换号 ——
        所以这里显示的勾选顺序就是回退顺序（按渠道账户列表排）。
      -->
      <div v-if="testTarget === 'channel'" class="field" style="margin-top: 12px">
        <label>
          {{ t('chat.accountLabel') }}
          <span v-if="channelAccounts.length > 1" class="dim">
            · {{ t('chat.accountSelected', { n: accountIds.length }) }}
          </span>
        </label>

        <div v-if="channelAccounts.length === 0" class="hint">{{ t('chat.accountEmpty') }}</div>

        <div v-else class="pick-chips">
          <button
            v-for="a in channelAccounts"
            :key="a.id"
            type="button"
            class="pick-chip"
            :class="{ on: accountIds.includes(a.id) }"
            :title="a.apiKeyMasked || t('channels.accountNoKey')"
            @click="toggleAccount(a.id)"
          >
            <span class="batch-pick-box">
              <svg v-if="accountIds.includes(a.id)" width="10" height="10" viewBox="0 0 12 12">
                <path
                  d="M2 6.4 4.6 9 10 3.4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            {{ a.name }}
            <span v-if="a.id === primaryAccountId" class="dim">{{ t('chat.accountPrimary') }}</span>
          </button>

          <button
            v-if="channelAccounts.length > 1"
            type="button"
            class="btn btn-sm btn-ghost"
            @click="toggleAllAccounts"
          >
            {{ allAccountsSelected ? t('chat.accountPrimaryOnly') : t('chat.accountAll') }}
          </button>
        </div>

        <span v-if="channelAccounts.length > 1" class="hint">{{ t('chat.accountHint') }}</span>
      </div>

      <div class="row row-wrap" style="margin-top: 12px">
        <PCheckbox v-model="useStream" :label="t('chat.streamToggle')" />
        <span class="spacer" />
        <span
          v-if="testTarget === 'channel' && selectedChannel"
          class="dim"
          style="font-size: 12px"
        >
          {{
            t('chat.channelInfo', {
              protocol:
                selectedChannel.protocol === 'openai'
                  ? t('channels.protocolOpenai')
                  : selectedChannel.protocol,
              vendor: selectedChannel.vendor,
              headers: Object.keys(selectedChannel.extraHeaders ?? {}).length
            })
          }}
        </span>
        <span v-else-if="selectedKey" class="dim" style="font-size: 12px">
          {{
            t('chat.keyInfo', {
              rpm: selectedKey.rpmLimit === 0 ? t('keys.unlimited') : selectedKey.rpmLimit + '/min',
              quota:
                selectedKey.quotaTokens === 0
                  ? t('keys.unlimited')
                  : formatCompact(selectedKey.quotaTokens),
              used: formatCompact(selectedKey.usedTokens)
            })
          }}
        </span>
      </div>

      <div v-if="keyError" class="alert" style="margin-top: 12px; margin-bottom: 0">
        {{ keyError }}
      </div>
    </div>

    <div class="card" style="padding: 0">
      <div
        ref="scroller"
        style="
          height: 440px;
          overflow-y: auto;
          padding: 18px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        "
      >
        <div v-if="messages.length === 0" class="empty">{{ t('chat.emptyHint') }}</div>

        <div
          v-for="m in messages"
          :key="m.id"
          :style="{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '82%' }"
        >
          <div
            :style="{
              background: m.role === 'user' ? 'var(--accent-soft)' : 'var(--bg-elev-2)',
              border:
                '1px solid ' +
                (m.failed ? 'color-mix(in srgb, var(--danger) 45%, transparent)' : 'var(--border-strong)'),
              color: m.failed ? 'var(--danger)' : 'var(--text)',
              borderRadius: '10px',
              padding: '10px 13px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: '13.5px'
            }"
          >
            <span v-if="m.pending && !m.content" class="dim">{{ t('chat.thinking') }}</span>
            {{ m.content }}
          </div>
          <div v-if="m.meta" class="dim" style="font-size: 11px; margin-top: 4px; padding-left: 2px">
            {{ t('chat.meta', { model: m.meta.model, latency: formatLatency(m.meta.latencyMs) }) }}
            <template v-if="m.meta.ttftMs !== null">
              · {{ t('chat.ttfb', { v: formatLatency(m.meta.ttftMs) }) }}
            </template>
            ·
            {{
              t('chat.tokensInOut', {
                total: m.meta.totalTokens,
                in: m.meta.promptTokens,
                out: m.meta.completionTokens
              })
            }}
            <!-- 直连测试：把「这次实际用了哪个上游账户」写出来，多选时才不会看糊涂 -->
            <template v-if="m.meta.account"> · {{ accountNote(m.meta) }}</template>
          </div>
        </div>
      </div>

      <div
        style="
          border-top: 1px solid var(--border);
          padding: 14px 18px;
          display: flex;
          gap: 10px;
          align-items: flex-end;
        "
      >
        <div class="field" style="flex: 1">
          <textarea
            v-model="input"
            rows="2"
            :placeholder="t('chat.placeholder')"
            @keydown="onKeydown"
          />
        </div>
        <button class="btn btn-primary" :disabled="!canSend" @click="send">
          {{ sending ? t('chat.sending') : t('chat.send') }}
        </button>
      </div>
    </div>
  </div>

  <Modal
    v-if="batchOpen"
    :title="t('chat.batchTitle')"
    wide
    @close="closeBatch"
  >
    <div class="alert alert-info">{{ t('chat.batchSub') }}</div>

    <div v-if="models.length === 0" class="empty">{{ t('chat.batchNoModels') }}</div>

    <template v-else>
      <div class="form-grid">
        <div class="field">
          <div class="row-between">
            <label>
              {{ t('chat.batchSelectModels') }} ·
              {{ t('chat.batchSelected', { n: batchSelected.length }) }}
            </label>
            <div class="row">
              <button class="btn btn-sm" @click="selectAllBatch">
                {{ t('chat.batchSelectAll') }}
              </button>
              <button class="btn btn-sm" @click="invertBatch">
                {{ t('chat.batchInvert') }}
              </button>
              <button class="btn btn-sm" @click="clearBatch">{{ t('chat.batchClear') }}</button>
            </div>
          </div>

          <input v-model="batchSearch" :placeholder="t('chat.batchSearch')" />

          <div class="batch-pick">
            <div
              v-for="m in batchCandidates"
              :key="m"
              class="batch-pick-item"
              :class="{ on: batchSelected.includes(m) }"
              @click="toggleBatchModel(m)"
            >
              <span class="batch-pick-box">
                <svg v-if="batchSelected.includes(m)" width="10" height="10" viewBox="0 0 12 12">
                  <path
                    d="M2 6.4 4.6 9 10 3.4"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </span>
              <span class="mono">{{ m }}</span>
            </div>
            <div v-if="batchCandidates.length === 0" class="empty" style="padding: 14px">
              {{ t('common.empty') }}
            </div>
          </div>
        </div>

        <div class="form-row">
          <div class="field">
            <label>{{ t('chat.batchPrompt') }}</label>
            <input
              v-model="batchPrompt"
              :placeholder="t('chat.batchPromptPlaceholder')"
              :disabled="batchRunning"
            />
          </div>
          <div class="field">
            <label>{{ t('chat.batchConcurrency') }}</label>
            <input
              v-model.number="batchConcurrency"
              type="number"
              min="1"
              max="10"
              :disabled="batchRunning"
            />
          </div>
        </div>

        <div v-if="batchRpmWarning" class="alert" style="margin-bottom: 0">
          {{ batchRpmWarning }}
        </div>

        <div v-if="batchResults.length > 0" class="field">
          <div class="row-between">
            <label>
              {{ t('chat.batchSummary', {
                ok: batchSummary.ok,
                fail: batchSummary.fail,
                avg: formatLatency(batchSummary.avg)
              }) }}
              <span v-if="batchRunning" class="dim">
                · {{ t('chat.batchRunning', {
                  done: batchDoneCount,
                  total: batchSummary.total
                }) }}
              </span>
            </label>
            <button class="btn btn-sm" @click="copyBatchJson">
              {{ t('chat.batchCopyJson') }}
            </button>
          </div>

          <div class="batch-scroll">
            <div
              class="batch-row batch-head"
              :class="{ 'has-account': testTarget === 'channel' }"
            >
              <span>{{ t('chat.batchModel') }}</span>
              <span v-if="testTarget === 'channel'">{{ t('chat.batchAccount') }}</span>
              <span>{{ t('chat.batchStatus') }}</span>
              <span>{{ t('chat.batchLatency') }}</span>
              <span>{{ t('chat.batchTokens') }}</span>
              <span>{{ t('chat.batchResponse') }}</span>
            </div>
            <div
              v-for="r in batchResults"
              :key="r.model"
              class="batch-row"
              :class="{ 'has-account': testTarget === 'channel' }"
            >
              <span class="mono" style="overflow: hidden; text-overflow: ellipsis">{{ r.model }}</span>
              <span
                v-if="testTarget === 'channel'"
                class="dim"
                style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap"
              >{{ r.account ?? '—' }}</span>
              <span>
                <span v-if="r.status === 'pending'" class="dim">—</span>
                <span v-else-if="r.status === 'running'" class="badge badge-info">…</span>
                <span v-else-if="r.status === 'ok'" class="badge badge-ok">{{ r.statusCode }}</span>
                <span v-else class="badge badge-err">{{ r.statusCode ?? 'ERR' }}</span>
              </span>
              <span class="nowrap">{{ r.latencyMs === undefined ? '—' : formatLatency(r.latencyMs) }}</span>
              <span class="nowrap">{{ r.totalTokens ?? '—' }}</span>
              <span
                :class="r.status === 'error' ? 'err-text' : 'dim'"
                style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap"
                :title="r.error || r.content || ''"
              >
                {{ r.error || r.content || '' }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div class="modal-foot">
      <button class="btn" @click="closeBatch">{{ t('common.close') }}</button>
      <button v-if="batchRunning" class="btn btn-danger" @click="stopBatch">
        {{ t('chat.batchStop') }}
      </button>
      <button
        v-else
        class="btn btn-primary"
        :disabled="batchSelected.length === 0"
        @click="runBatch"
      >
        {{ t('chat.batchRun') }}
      </button>
    </div>
  </Modal>

</template>
