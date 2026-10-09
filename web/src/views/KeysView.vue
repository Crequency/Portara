<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { api, ApiError, type ApiKey, type Channel, type User } from '../api'
import Modal from '../components/Modal.vue'
import { formatNumber, formatTime, parseList } from '../format'
import { toast } from '../toast'

const props = defineProps<{ user?: User }>()

const isAdmin = (): boolean => props.user?.role === 'admin'

const keys = ref<ApiKey[]>([])
const channels = ref<Channel[]>([])
const loading = ref(true)
const showForm = ref(false)
const saving = ref(false)

/** 明文只在创建/轮换那一刻拿到；此后需经 reveal 接口（仅管理员，留审计）*/
const issuedKey = ref('')
const issuedName = ref('')

const revealTarget = ref<ApiKey | null>(null)
const revealedKey = ref('')
const revealError = ref('')
const revealing = ref(false)

const form = reactive({
  name: '',
  channelId: '',
  modelAllowText: '',
  rpmLimit: 60,
  quotaTokens: 0,
  expiresAt: ''
})

const channelName = computed(() => {
  const map = new Map(channels.value.map((c) => [c.id, c.name]))
  return (id: string | null) => (id ? (map.get(id) ?? '（已删除）') : '自动路由')
})

async function load(): Promise<void> {
  loading.value = true
  try {
    const [k, c] = await Promise.all([
      api.get<{ keys: ApiKey[] }>('/api/keys'),
      api.get<{ channels: Channel[] }>('/api/channels')
    ])
    keys.value = k.keys
    channels.value = c.channels
  } catch {
    toast.error('加载密钥失败')
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  Object.assign(form, {
    name: '',
    channelId: '',
    modelAllowText: '',
    rpmLimit: 60,
    quotaTokens: 0,
    expiresAt: ''
  })
  issuedKey.value = ''
  showForm.value = true
}

async function submit(): Promise<void> {
  saving.value = true
  try {
    const res = await api.post<{ apiKey: ApiKey; key: string }>('/api/keys', {
      name: form.name.trim(),
      channelId: form.channelId || null,
      modelAllow: parseList(form.modelAllowText),
      rpmLimit: Number(form.rpmLimit),
      quotaTokens: Number(form.quotaTokens),
      expiresAt: form.expiresAt || null
    })
    issuedKey.value = res.key
    issuedName.value = res.apiKey.name
    toast.success('密钥已创建')
    await load()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '创建失败')
  } finally {
    saving.value = false
  }
}

async function rotate(k: ApiKey): Promise<void> {
  if (!confirm(`轮换「${k.name}」？旧密钥立即失效。`)) return
  try {
    const res = await api.post<{ apiKey: ApiKey; key: string }>(`/api/keys/${k.id}/rotate`)
    issuedKey.value = res.key
    issuedName.value = k.name
    showForm.value = true
    toast.success('已轮换，请立即复制新密钥')
    await load()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '轮换失败')
  }
}

async function toggle(k: ApiKey): Promise<void> {
  try {
    await api.patch(`/api/keys/${k.id}`, {
      status: k.status === 'active' ? 'disabled' : 'active'
    })
    toast.success(k.status === 'active' ? '已停用' : '已启用')
    await load()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '操作失败')
  }
}

async function remove(k: ApiKey): Promise<void> {
  if (!confirm(`确定删除密钥「${k.name}」？使用它的调用方会立即失去访问权限。`)) return
  try {
    await api.del(`/api/keys/${k.id}`)
    toast.success('已删除')
    await load()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '删除失败')
  }
}

async function reveal(k: ApiKey): Promise<void> {
  revealTarget.value = k
  revealedKey.value = ''
  revealError.value = ''
  revealing.value = true
  try {
    const res = await api.get<{ key: string }>(`/api/keys/${k.id}/reveal`)
    revealedKey.value = res.key
  } catch (err) {
    revealError.value =
      err instanceof ApiError ? err.message : '无法读取密钥，请稍后重试'
  } finally {
    revealing.value = false
  }
}

function closeReveal(): void {
  revealTarget.value = null
  revealedKey.value = ''
  revealError.value = ''
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('已复制到剪贴板')
  } catch {
    toast.error('复制失败，请手动选中复制')
  }
}

function quotaPercent(k: ApiKey): number {
  if (k.quotaTokens <= 0) return 0
  return Math.min(100, Math.round((k.usedTokens / k.quotaTokens) * 100))
}

onMounted(load)
</script>

<template>
  <div class="card">
    <div class="card-head">
      <div>
        <div class="card-title">API 密钥</div>
        <div class="dim" style="font-size: 12px">
          调用方用 <span class="mono">Authorization: Bearer &lt;key&gt;</span> 访问
          <span class="mono">/v1</span>
        </div>
      </div>
      <div class="row">
        <button class="btn btn-sm" @click="load">刷新</button>
        <button class="btn btn-primary btn-sm" @click="openCreate">＋ 派发密钥</button>
      </div>
    </div>

    <div v-if="loading" class="loading">加载中…</div>
    <div v-else-if="keys.length === 0" class="empty">
      还没有密钥。点击「派发密钥」为调用方签发一个。
    </div>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>密钥前缀</th>
            <th>绑定渠道</th>
            <th>限速</th>
            <th>配额用量</th>
            <th>最近使用</th>
            <th>状态</th>
            <th style="width: 250px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="k in keys" :key="k.id">
            <td>
              <div>{{ k.name }}</div>
              <div v-if="k.modelAllow.length" class="tag-list" style="margin-top: 3px">
                <span v-for="m in k.modelAllow.slice(0, 2)" :key="m" class="tag">{{ m }}</span>
                <span v-if="k.modelAllow.length > 2" class="tag">
                  +{{ k.modelAllow.length - 2 }}
                </span>
              </div>
            </td>
            <td class="mono">{{ k.keyPrefix }}…</td>
            <td>{{ channelName(k.channelId) }}</td>
            <td class="nowrap">{{ k.rpmLimit === 0 ? '不限' : `${k.rpmLimit}/min` }}</td>
            <td style="min-width: 150px">
              <template v-if="k.quotaTokens > 0">
                <div style="font-size: 12px">
                  {{ formatNumber(k.usedTokens) }} / {{ formatNumber(k.quotaTokens) }}
                </div>
                <div
                  style="
                    height: 4px;
                    background: var(--bg-elev-2);
                    border-radius: 3px;
                    margin-top: 4px;
                    overflow: hidden;
                  "
                >
                  <div
                    :style="{
                      width: `${quotaPercent(k)}%`,
                      height: '100%',
                      background:
                        quotaPercent(k) > 85 ? 'var(--danger)' : 'var(--accent)'
                    }"
                  />
                </div>
              </template>
              <span v-else class="dim">不限（已用 {{ formatNumber(k.usedTokens) }}）</span>
            </td>
            <td class="nowrap dim">{{ formatTime(k.lastUsedAt) }}</td>
            <td>
              <span class="badge" :class="k.status === 'active' ? 'badge-ok' : 'badge-off'">
                {{ k.status === 'active' ? '启用' : '停用' }}
              </span>
            </td>
            <td>
              <div class="row">
                <button
                  v-if="isAdmin()"
                  class="btn btn-sm"
                  :disabled="!k.revealable"
                  :title="k.revealable ? '查看完整密钥（会记入审计日志）' : '该密钥创建于启用可查看之前，无法找回'"
                  @click="reveal(k)"
                >
                  查看
                </button>
                <button class="btn btn-sm" @click="rotate(k)">轮换</button>
                <button class="btn btn-sm" @click="toggle(k)">
                  {{ k.status === 'active' ? '停用' : '启用' }}
                </button>
                <button class="btn btn-sm btn-danger" @click="remove(k)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <Modal
    v-if="revealTarget"
    :title="`查看密钥 · ${revealTarget.name}`"
    wide
    @close="closeReveal"
  >
    <div class="alert">
      <b>安全风险提示：</b>完整密钥等同于该调用方的全部权限。请勿截图、勿粘贴到聊天工具或工单系统、
      勿写入前端代码或公开仓库。每次查看都会<b>记录审计日志</b>（谁、何时、哪把密钥、来源 IP）。
    </div>

    <div v-if="revealing" class="loading">读取中…</div>
    <div v-else-if="revealError" class="err-text">{{ revealError }}</div>
    <template v-else>
      <div class="code-box">{{ revealedKey }}</div>
      <div class="row" style="margin-top: 12px">
        <button class="btn btn-primary btn-sm" @click="copy(revealedKey)">复制完整密钥</button>
        <span class="dim" style="font-size: 12px">
          前缀 {{ revealTarget.keyPrefix }}· 用于
          <span class="mono">Authorization: Bearer &lt;key&gt;</span>
        </span>
      </div>
    </template>

    <div class="modal-foot">
      <button class="btn" @click="closeReveal">关闭</button>
    </div>
  </Modal>

  <Modal
    v-if="showForm"
    :title="issuedKey ? '请立即保存密钥' : '派发密钥'"
    wide
    @close="showForm = false"
  >
    <template v-if="issuedKey">
      <div class="alert alert-info">
        「{{ issuedName }}」的明文密钥<b>只显示这一次</b>，关闭后无法再次查看。丢失请轮换。
      </div>
      <div class="code-box">{{ issuedKey }}</div>
      <div class="row" style="margin-top: 12px">
        <button class="btn btn-primary btn-sm" @click="copy(issuedKey)">复制</button>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="showForm = false">我已保存，关闭</button>
      </div>
    </template>

    <template v-else>
      <div class="form-grid">
        <div class="field">
          <label>名称</label>
          <input v-model="form.name" placeholder="生产环境-订单服务" />
        </div>

        <div class="field">
          <label>绑定渠道</label>
          <select v-model="form.channelId">
            <option value="">自动路由（按优先级与权重选择）</option>
            <option v-for="c in channels" :key="c.id" :value="c.id">
              {{ c.name }}
            </option>
          </select>
          <span class="hint">绑定后该 Key 只走指定渠道，不做回退。</span>
        </div>

        <div class="field">
          <label>允许的模型</label>
          <textarea v-model="form.modelAllowText" rows="2" placeholder="gpt-4o-mini" />
          <span class="hint">留空 = 不限制。</span>
        </div>

        <div class="form-row">
          <div class="field">
            <label>速率限制（次/分钟）</label>
            <input v-model.number="form.rpmLimit" type="number" min="0" />
            <span class="hint">0 表示不限。</span>
          </div>
          <div class="field">
            <label>Token 配额</label>
            <input v-model.number="form.quotaTokens" type="number" min="0" />
            <span class="hint">0 表示不限。</span>
          </div>
        </div>

        <div class="field">
          <label>过期时间（可选）</label>
          <input v-model="form.expiresAt" type="datetime-local" />
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="showForm = false">取消</button>
        <button class="btn btn-primary" :disabled="saving" @click="submit">
          {{ saving ? '创建中…' : '创建' }}
        </button>
      </div>
    </template>
  </Modal>
</template>
