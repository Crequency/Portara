<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { api, ApiError, type Channel, type ChannelTestResult, type User } from '../api'
import Modal from '../components/Modal.vue'
import { formatTime, headerLines, parseHeaderLines, parseList } from '../format'
import { toast } from '../toast'

const props = defineProps<{ user?: User }>()

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

const VENDORS = [
  { id: 'generic', label: '通用（标准 OpenAI 兼容）' },
  { id: 'opencode-go', label: 'OpenCode（需 x-opencode-session 头）' }
]

const isAdmin = () => props.user?.role === 'admin'

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await api.get<{ channels: Channel[] }>('/api/channels')
    channels.value = res.channels
  } catch {
    toast.error('加载渠道失败')
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
  saving.value = true
  try {
    const parsedHeaders = parseHeaderLines(form.headersText)
    if (parsedHeaders.errors.length > 0) {
      toast.error(`固定请求头格式有问题：${parsedHeaders.errors[0]}`)
      return
    }

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
      await api.patch(`/api/channels/${editingId.value}`, {
        ...body,
        ...(form.apiKey ? { apiKey: form.apiKey } : {})
      })
      toast.success('渠道已更新')
    } else {
      await api.post('/api/channels', { ...body, apiKey: form.apiKey })
      toast.success('渠道已创建')
    }
    showForm.value = false
    await load()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '保存失败')
  } finally {
    saving.value = false
  }
}

async function test(ch: Channel): Promise<void> {
  testResults[ch.id] = 'loading'
  try {
    const res = await api.post<ChannelTestResult>(`/api/channels/${ch.id}/test`)
    testResults[ch.id] = res
    // 同步到行数据：延迟列立即显示最新值（服务端也已落库，刷新后仍在）
    ch.lastLatencyMs = res.latencyMs
    ch.lastTestAt = res.testedAt ?? new Date().toISOString()
    ch.lastTestOk = res.ok
    if (res.ok) toast.success(`「${ch.name}」连通正常（${res.latencyMs}ms）`)
    else toast.error(`「${ch.name}」${res.message}`)
  } catch (err) {
    testResults[ch.id] = {
      ok: false,
      status: 0,
      latencyMs: 0,
      models: [],
      message: err instanceof ApiError ? err.message : '测试失败'
    }
    ch.lastLatencyMs = 0
    ch.lastTestAt = new Date().toISOString()
    ch.lastTestOk = false
    toast.error('连通性测试失败')
  }
}

async function remove(ch: Channel): Promise<void> {
  if (!confirm(`确定删除渠道「${ch.name}」？绑定了该渠道的密钥将回退为自动路由。`)) return
  try {
    await api.del(`/api/channels/${ch.id}`)
    toast.success('已删除')
    await load()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '删除失败')
  }
}

/** 延迟展示：优先本次会话刚测出的值，其次用服务端持久化的最近一次 */
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

onMounted(load)
</script>

<template>
  <div class="card">
    <div class="card-head">
      <div>
        <div class="card-title">上游渠道</div>
        <div class="dim" style="font-size: 12px">
          同一优先级组内按权重轮转；模型留空表示该渠道通吃所有模型
        </div>
      </div>
      <div class="row">
        <button class="btn btn-sm" @click="load">刷新</button>
        <button v-if="isAdmin()" class="btn btn-primary btn-sm" @click="openCreate">
          ＋ 新建渠道
        </button>
      </div>
    </div>

    <div v-if="loading" class="loading">加载中…</div>
    <div v-else-if="channels.length === 0" class="empty">
      还没有上游渠道。点击「新建渠道」填入 OpenAI 兼容的 Base URL 与密钥。
    </div>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>Base URL</th>
            <th>上游密钥</th>
            <th>模型</th>
            <th>优先级 / 权重</th>
            <th>状态</th>
            <th style="min-width: 108px">延迟</th>
            <th style="width: 190px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ch in channels" :key="ch.id">
            <td>
              <div>{{ ch.name }}</div>
              <div class="tag-list" style="margin-top: 3px">
                <span class="tag">{{ ch.protocol === 'openai' ? 'OpenAI 兼容' : ch.protocol }}</span>
                <span v-if="ch.vendor !== 'generic'" class="tag" style="color: #9db9ff">
                  {{ ch.vendor }}
                </span>
                <span
                  v-if="Object.keys(ch.extraHeaders ?? {}).length > 0"
                  class="tag"
                  :title="Object.keys(ch.extraHeaders).join(', ')"
                >
                  +{{ Object.keys(ch.extraHeaders).length }} 头
                </span>
              </div>
              <div v-if="ch.note" class="dim" style="font-size: 11.5px; margin-top: 3px">
                {{ ch.note }}
              </div>
            </td>
            <td class="mono" style="max-width: 240px; word-break: break-all">
              {{ ch.baseUrl }}
            </td>
            <td class="mono dim">{{ ch.apiKeyMasked || '（未设置）' }}</td>
            <td>
              <span v-if="ch.models.length === 0" class="badge badge-info">全部</span>
              <span v-else class="tag-list">
                <span v-for="m in ch.models.slice(0, 3)" :key="m" class="tag">{{ m }}</span>
                <span v-if="ch.models.length > 3" class="tag">
                  +{{ ch.models.length - 3 }}
                </span>
              </span>
            </td>
            <td class="nowrap">{{ ch.priority }} / {{ ch.weight }}</td>
            <td>
              <span class="badge" :class="ch.status === 'active' ? 'badge-ok' : 'badge-off'">
                {{ ch.status === 'active' ? '启用' : '停用' }}
              </span>
            </td>
            <td class="nowrap">
              <span v-if="testResults[ch.id] === 'loading'" class="dim">测试中…</span>
              <template v-else-if="latencyOf(ch) !== null">
                <span
                  class="badge"
                  :class="latencyOk(ch) ? 'badge-ok' : 'badge-err'"
                  :title="latencyOk(ch) ? '连通正常' : '连接失败'"
                >
                  {{ latencyOf(ch) }} ms
                </span>
                <div v-if="latencyAt(ch)" class="dim" style="font-size: 11px">
                  {{ formatTime(latencyAt(ch)) }}
                </div>
              </template>
              <span v-else class="dim">未测试</span>
            </td>
            <td>
              <div class="row">
                <button
                  class="btn btn-sm"
                  :disabled="testResults[ch.id] === 'loading'"
                  @click="test(ch)"
                >
                  {{ testResults[ch.id] === 'loading' ? '测试中…' : '测试' }}
                </button>
                <template v-if="isAdmin()">
                  <button class="btn btn-sm" @click="openEdit(ch)">编辑</button>
                  <button class="btn btn-sm btn-danger" @click="remove(ch)">删除</button>
                </template>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <Modal
    v-if="showForm"
    :title="editingId ? '编辑渠道' : '新建渠道'"
    wide
    @close="showForm = false"
  >
    <div class="form-grid">
      <div class="form-row">
        <div class="field">
          <label>名称</label>
          <input v-model="form.name" placeholder="openai-main" />
        </div>
        <div class="field">
          <label>状态</label>
          <select v-model="form.status">
            <option value="active">启用</option>
            <option value="disabled">停用</option>
          </select>
        </div>
      </div>

      <div class="form-row">
        <div class="field">
          <label>协议</label>
          <select v-model="form.protocol">
            <option value="openai">OpenAI 兼容</option>
          </select>
          <span class="hint">首批仅提供 OpenAI 兼容协议。</span>
        </div>
        <div class="field">
          <label>厂商兼容</label>
          <select v-model="form.vendor">
            <option v-for="v in VENDORS" :key="v.id" :value="v.id">{{ v.label }}</option>
          </select>
          <span v-if="form.vendor === 'opencode-go'" class="hint">
            会自动补 <span class="mono">x-opencode-session</span>（值随机）；
            若你在下面自行指定该头，则以你填的为准。
          </span>
        </div>
      </div>

      <div class="field">
        <label>Base URL</label>
        <input v-model="form.baseUrl" placeholder="https://api.openai.com/v1" />
        <span class="hint">需包含版本段（如 /v1）。Portara 会拼接 /chat/completions。</span>
      </div>

      <div class="field">
        <label>上游 API Key</label>
        <input
          v-model="form.apiKey"
          type="password"
          :placeholder="editingId ? '留空表示不修改' : 'sk-…'"
        />
        <span class="hint">使用 AES-256-GCM 加密存储，页面上只显示掩码。</span>
      </div>

      <div class="field">
        <label>固定请求头</label>
        <textarea
          v-model="form.headersText"
          rows="3"
          placeholder="X-Custom-Header: value&#10;# 每行一条，可留空"
        />
        <span class="hint">
          每行一条 <span class="mono">名称: 值</span>，会附加到发往该上游的每个请求。
          <b>此处为明文保存</b> —— 密钥请填上面的「上游 API Key」（加密存储）；
          <span class="mono">authorization</span> 等由 Portara 管理的头不允许自定义。
        </span>
      </div>

      <div class="field">
        <label>模型列表</label>
        <textarea
          v-model="form.modelsText"
          rows="3"
          placeholder="gpt-4o&#10;gpt-4o-mini"
        />
        <span class="hint">逗号或换行分隔。留空 = 该渠道接受任何模型。</span>
      </div>

      <div class="form-row">
        <div class="field">
          <label>优先级（越小越先）</label>
          <input v-model.number="form.priority" type="number" min="1" />
        </div>
        <div class="field">
          <label>权重（同优先级轮转比例）</label>
          <input v-model.number="form.weight" type="number" min="1" />
        </div>
      </div>

      <div class="form-row">
        <div class="field">
          <label>超时（毫秒）</label>
          <input v-model.number="form.timeoutMs" type="number" min="1000" />
        </div>
        <div class="field">
          <label>备注</label>
          <input v-model="form.note" placeholder="可选" />
        </div>
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn" @click="showForm = false">取消</button>
      <button class="btn btn-primary" :disabled="saving" @click="submit">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </div>
  </Modal>
</template>
