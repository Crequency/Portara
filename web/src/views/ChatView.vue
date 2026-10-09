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
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { api, ApiError, type ApiKey, type Channel, type User } from '../api'
import PCheckbox from '../components/PCheckbox.vue'
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
    keyError.value = err instanceof ApiError ? err.message : t('keys.revealFailed')
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
      res = await fetch('/api/channels/' + channelId.value + '/chat', {
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

    if (!useStream.value) {
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }
      assistant.content = body.choices?.[0]?.message?.content ?? t('chat.emptyResponse')
      meta = {
        ...meta,
        latencyMs: Date.now() - startedAt,
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
        totalTokens: body.usage?.total_tokens ?? 0
      }
    } else {
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
        <div class="row">
          <button class="btn btn-sm" @click="loadModels">{{ t('chat.refreshModels') }}</button>
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
            {{ t('chat.modelLabel') }} {{ loadingModels ? t('chat.modelLoading') : '' }}
          </label>
          <input v-model="model" list="model-options" :placeholder="t('chat.modelPlaceholder')" />
          <datalist id="model-options">
            <option v-for="m in models" :key="m" :value="m" />
          </datalist>
          <span v-if="models.length === 0 && !loadingModels" class="hint">
            {{ t('chat.noModels') }}
          </span>
        </div>
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
</template>
