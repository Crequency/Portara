<script setup lang="ts">
/**
 * 对话测试 —— 用 Portara 自己签发的 Key 走一遍真实网关链路。
 *
 * 关键点：请求直接打到本站的 /v1（同源，无 CORS 问题），
 * 因此鉴权、限流、配额、模型白名单、选路、转发、计量**全部真实生效**，
 * 不是模拟。页面不做会话管理：每次进入即一个新会话，刷新即清空。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { api, ApiError, type ApiKey, type Channel, type User } from '../api'
import { formatCompact, formatLatency } from '../format'
import { toast } from '../toast'

const props = defineProps<{ user?: User }>()

const isAdmin = computed(() => props.user?.role === 'admin')

interface ChatMeta {
  model: string
  latencyMs: number
  ttftMs: number | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  failed?: boolean
  pending?: boolean
  meta?: ChatMeta
}

/** 测试对象：gateway = 从网关入口走整条链路；channel = 直连上游渠道（绕过网关治理） */
type TestTarget = 'gateway' | 'channel'

const testTarget = ref<TestTarget>('gateway')
const keys = ref<ApiKey[]>([])
const keyId = ref('')
const channels = ref<Channel[]>([])
const channelId = ref('')
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

/** 明文密钥只在本页内存中驻留，不写 localStorage/sessionStorage */
let plainKey = ''
let plainKeyFor = ''

const selectedKey = computed(() => keys.value.find((k) => k.id === keyId.value) ?? null)
const selectedChannel = computed(
  () => channels.value.find((ch) => ch.id === channelId.value) ?? null
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

async function loadKeys(): Promise<void> {
  try {
    const res = await api.get<{ keys: ApiKey[] }>('/api/keys')
    keys.value = res.keys
  } catch {
    toast.error('加载密钥列表失败')
  }
}

async function loadChannels(): Promise<void> {
  try {
    const res = await api.get<{ channels: Channel[] }>('/api/channels')
    channels.value = res.channels
  } catch {
    toast.error('加载渠道列表失败')
  }
}

/** 取明文密钥：仅管理员可用，服务端会写审计日志 */
async function ensurePlainKey(): Promise<string> {
  if (!keyId.value) throw new Error('请先选择一把密钥')
  if (plainKey && plainKeyFor === keyId.value) return plainKey

  const res = await api.get<{ key: string }>(`/api/keys/${keyId.value}/reveal`)
  plainKey = res.key
  plainKeyFor = keyId.value
  return plainKey
}

async function loadModels(): Promise<void> {
  models.value = []
  keyError.value = ''

  // 直连渠道：模型就是该渠道声明的模型，不需要经过网关
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
    const res = await fetch('/v1/models', {
      headers: { authorization: `Bearer ${token}` }
    })
    const json = (await res.json()) as { data?: { id: string }[]; error?: { message: string } }
    if (!res.ok) {
      keyError.value = json?.error?.message ?? `获取模型列表失败（HTTP ${res.status}）`
      return
    }
    models.value = (json.data ?? []).map((m) => m.id)
    if (models.value.length > 0 && !models.value.includes(model.value)) {
      model.value = models.value[0]!
    }
  } catch (err) {
    keyError.value = err instanceof ApiError ? err.message : '该密钥无法读取，请轮换后再用'
  } finally {
    loadingModels.value = false
  }
}

watch([keyId, channelId, testTarget], () => {
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
  const assistant: ChatMessage = {
    id: ++seq,
    role: 'assistant',
    content: '',
    pending: true
  }
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

    // 两条路径：
    //  gateway —— 带 Bearer Key 打 /v1，鉴权/限流/配额/选路/计量全部生效
    //  channel —— 带会话 Cookie 打 /api/channels/:id/chat，服务端用渠道自己的
    //             Key 与固定请求头直连上游，绕过网关治理（诊断用途）
    let res: Response
    if (testTarget.value === 'channel') {
      res = await fetch(`/api/channels/${channelId.value}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
    } else {
      const token = await ensurePlainKey()
      res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      })
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null
      const who = testTarget.value === 'channel' ? '上游渠道' : '网关'
      throw new Error(body?.error?.message ?? `${who}返回 HTTP ${res.status}`)
    }

    if (!useStream.value) {
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }
      assistant.content = body.choices?.[0]?.message?.content ?? '（上游返回了空内容）'
      meta = {
        ...meta,
        latencyMs: Date.now() - startedAt,
        ttftMs: null,
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
        totalTokens: body.usage?.total_tokens ?? 0
      }
    } else {
      const reader = res.body?.getReader()
      if (!reader) throw new Error('网关未返回响应流')

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

          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue

          try {
            const chunk = JSON.parse(payload) as {
              choices?: { delta?: { content?: string } }[]
              usage?: {
                prompt_tokens?: number
                completion_tokens?: number
                total_tokens?: number
              }
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
            /* 忽略无法解析的行（心跳等） */
          }
        }
      }

      meta = { ...meta, latencyMs: Date.now() - startedAt, ttftMs }
      if (!assistant.content) assistant.content = '（上游返回了空内容）'
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

function onKeydown(e: KeyboardEvent): void {
  // Enter 发送，Shift+Enter 换行
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
      对话测试会读取密钥明文，<b>仅管理员可用</b>。当前账号角色：{{ user?.role ?? '未知' }}。
    </div>
  </div>

  <div v-else class="grid" style="grid-template-columns: 1fr; gap: 14px">
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">对话测试</div>
          <div class="dim" style="font-size: 12px">
            <template v-if="testTarget === 'gateway'">
              从网关入口发起 <span class="mono">POST /v1/chat/completions</span>，
              鉴权 / 限流 / 配额 / 白名单 / 选路 / 计量<b>全部真实生效</b>
            </template>
            <template v-else>
              直连上游 <span class="mono">{{ selectedChannel?.baseUrl ?? '—' }}</span>，
              使用该渠道自己的 Key 与固定请求头，<b>绕过网关治理</b>（用于区分「渠道不通」与「网关不通」）
            </template>
          </div>
        </div>
        <div class="row">
          <button class="btn btn-sm" @click="loadModels">刷新模型</button>
          <button class="btn btn-sm" @click="newSession">新会话</button>
        </div>
      </div>

      <div class="row row-wrap" style="margin-bottom: 14px">
        <span class="dim" style="font-size: 12.5px">测试对象：</span>
        <button
          class="btn btn-sm"
          :class="{ 'btn-primary': testTarget === 'gateway' }"
          @click="testTarget = 'gateway'"
        >
          网关自身测试
        </button>
        <button
          class="btn btn-sm"
          :class="{ 'btn-primary': testTarget === 'channel' }"
          @click="testTarget = 'channel'"
        >
          上游渠道测试
        </button>
      </div>

      <div class="form-row">
        <div v-if="testTarget === 'gateway'" class="field">
          <label>使用哪把密钥</label>
          <select v-model="keyId">
            <option value="">请选择…</option>
            <option v-for="k in keys" :key="k.id" :value="k.id">
              {{ k.name }} · {{ k.keyPrefix }}…{{ k.status === 'active' ? '' : '（已停用）'
              }}{{ k.revealable ? '' : '（不可查看，需轮换）' }}
            </option>
          </select>
          <span class="hint">走网关会消耗该 Key 的配额与限速。</span>
        </div>

        <div v-else class="field">
          <label>测试哪个渠道</label>
          <select v-model="channelId">
            <option value="">请选择…</option>
            <option v-for="ch in channels" :key="ch.id" :value="ch.id">
              {{ ch.name }} · {{ ch.baseUrl }}{{ ch.status === 'active' ? '' : '（已停用）' }}
            </option>
          </select>
          <span class="hint">
            直接用渠道的上游 Key 请求，不经过限流与配额 —— 会消耗上游额度。
          </span>
        </div>
        <div class="field">
          <label>模型 {{ loadingModels ? '（加载中…）' : '' }}</label>
          <input v-model="model" list="model-options" placeholder="gpt-4o-mini" />
          <datalist id="model-options">
            <option v-for="m in models" :key="m" :value="m" />
          </datalist>
          <span v-if="models.length === 0 && !loadingModels" class="hint">
            该密钥下未发现可用模型，可直接手动输入模型名
          </span>
        </div>
      </div>

      <div class="row row-wrap" style="margin-top: 10px">
        <label class="checkbox">
          <input v-model="useStream" type="checkbox" />
          流式输出（SSE）
        </label>
        <span class="spacer" />
        <span v-if="testTarget === 'channel' && selectedChannel" class="dim" style="font-size: 12px">
          {{ selectedChannel.protocol === 'openai' ? 'OpenAI 兼容' : selectedChannel.protocol }} ·
          厂商 {{ selectedChannel.vendor }} ·
          固定头 {{ Object.keys(selectedChannel.extraHeaders ?? {}).length }} 个
        </span>
        <span v-else-if="selectedKey" class="dim" style="font-size: 12px">
          限速 {{ selectedKey.rpmLimit === 0 ? '不限' : `${selectedKey.rpmLimit}/min` }} ·
          配额 {{ selectedKey.quotaTokens === 0 ? '不限' : formatCompact(selectedKey.quotaTokens) }}
          · 已用 {{ formatCompact(selectedKey.usedTokens) }}
        </span>
      </div>

      <div v-if="keyError" class="alert" style="margin-top: 12px">{{ keyError }}</div>
    </div>

    <div class="card" style="padding: 0">
      <div
        ref="scroller"
        style="
          height: 420px;
          overflow-y: auto;
          padding: 18px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        "
      >
        <div v-if="messages.length === 0" class="empty">
          这是一个新会话（页面不做会话管理，刷新即清空）。<br />
          选好密钥与模型，发一句话试试。
        </div>

        <div
          v-for="m in messages"
          :key="m.id"
          :style="{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '82%'
          }"
        >
          <div
            :style="{
              background: m.role === 'user' ? 'rgba(91,140,255,0.16)' : 'var(--bg-elev-2)',
              border:
                '1px solid ' + (m.failed ? 'rgba(244,85,95,0.45)' : 'var(--border-strong)'),
              color: m.failed ? '#ffb3b8' : 'var(--text)',
              borderRadius: '10px',
              padding: '10px 13px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: '13.5px'
            }"
          >
            <span v-if="m.pending && !m.content" class="dim">思考中…</span>
            {{ m.content }}
          </div>
          <div
            v-if="m.meta"
            class="dim"
            style="font-size: 11px; margin-top: 4px; padding-left: 2px"
          >
            {{ m.meta.model }} · {{ formatLatency(m.meta.latencyMs) }}
            <template v-if="m.meta.ttftMs !== null">· 首字节 {{ formatLatency(m.meta.ttftMs) }}</template>
            · token {{ m.meta.totalTokens }}（入 {{ m.meta.promptTokens }} / 出
            {{ m.meta.completionTokens }}）
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
            placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
            @keydown="onKeydown"
          />
        </div>
        <button class="btn btn-primary" :disabled="!canSend" @click="send">
          {{ sending ? '发送中…' : '发送' }}
        </button>
      </div>
    </div>
  </div>
</template>
