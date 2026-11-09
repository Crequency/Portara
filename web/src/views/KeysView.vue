<script setup lang="ts">
import { errorText, toastError } from '../error'
import { computed, onMounted, reactive, ref } from 'vue'
import { api, type ApiKey, type Channel, type User } from '../api'
import Modal from '../components/Modal.vue'
import PCheckbox from '../components/PCheckbox.vue'
import PSelect from '../components/PSelect.vue'
import { formatNumber, formatTime, parseList } from '../format'
import { useI18n } from '../i18n'
import { toast } from '../toast'

const props = defineProps<{ user?: User }>()

const { t } = useI18n()

const keys = ref<ApiKey[]>([])
const channels = ref<Channel[]>([])
const users = ref<User[]>([])
const loading = ref(true)
const showForm = ref(false)
const saving = ref(false)

const issuedKey = ref('')
const issuedName = ref('')

const revealTarget = ref<ApiKey | null>(null)
const revealedKey = ref('')
const revealError = ref('')
const revealing = ref(false)

const form = reactive({
  name: '',
  userId: '',
  channelId: '',
  modelAllowText: '',
  /** 余额读取权限（默认关闭：余额反映账户资金状况） */
  usageAllow: false,
  usageRefresh: false,
  /**
   * 可见渠道的两种模式：
   *   'all'  = 全部渠道（**含以后新增**），提交空数组
   *   'pick' = 指定渠道，提交显式 id 列表（新渠道不会自动纳入）
   *
   * 为什么要有这个开关：旧实现把「全选」写成一串当前 id，
   * 那其实是"此刻的快照" —— 之后新增的渠道（如 OpenDesign）就永远看不到，
   * 直到有人再点一次全选。语义必须显式化，不能靠数组是否为空来猜。
   */
  usageScope: 'all' as 'all' | 'pick',
  usageChannels: [] as string[],
  rpmLimit: 60,
  quotaTokens: 0,
  expiresAt: ''
})

/** 正在编辑的密钥 id；null = 新建 */
const editingKeyId = ref<string | null>(null)

const isAdmin = (): boolean => props.user?.role === 'admin'

const ownerOptions = computed(() => [
  { value: '', label: t('keys.ownerNone') },
  ...users.value.map((u) => ({
    value: u.id,
    label: u.displayName || u.username,
    hint: u.username
  }))
])

const channelOptions = computed(() => [
  { value: '', label: t('keys.autoRouteHint') },
  ...channels.value.map((c) => ({ value: c.id, label: c.name, hint: c.baseUrl }))
])

const channelName = computed(() => {
  const map = new Map(channels.value.map((c) => [c.id, c.name]))
  return (id: string | null) => (id ? (map.get(id) ?? t('keys.deletedChannel')) : t('keys.autoRoute'))
})

async function load(): Promise<void> {
  loading.value = true
  try {
    const k = await api.get<{ keys: ApiKey[] }>('/api/keys')
    keys.value = k.keys

    /*
     * 渠道 / 用户列表是管理面数据（非管理员拿到 403）：操作员不请求，
     * 渠道选择器与「绑定渠道」列也就不会以空列表的形式误显示。
     */
    channels.value = []
    users.value = []
    if (isAdmin()) {
      try {
        const [c, u] = await Promise.all([
          api.get<{ channels: Channel[] }>('/api/channels'),
          api.get<{ users: User[] }>('/api/users')
        ])
        channels.value = c.channels
        users.value = u.users
      } catch {
        /* 管理面辅助数据拿不到不影响密钥列表本身 */
      }
    }
  } catch {
    toast.error(t('keys.loadFailed'))
  } finally {
    loading.value = false
  }
}

/** 系统设置里的「新建密钥默认每分钟上限」 */
const keyDefaults = ref<{ defaultKeyRpmLimit: number } | null>(null)

async function loadKeyDefaults(): Promise<void> {
  // /api/settings 仅管理员可读；操作员直接用表单默认值
  if (!isAdmin()) {
    keyDefaults.value = null
    return
  }
  try {
    const res = await api.get<{ settings: { defaultKeyRpmLimit: number } }>('/api/settings')
    keyDefaults.value = res.settings
  } catch {
    keyDefaults.value = null
  }
}

function openCreate(): void {
  Object.assign(form, {
    name: '',
    userId: props.user?.id ?? '',
    channelId: '',
    modelAllowText: '',
    usageAllow: false,
    usageRefresh: false,
    usageScope: 'all',
    usageChannels: [],
    rpmLimit: keyDefaults.value?.defaultKeyRpmLimit ?? 60,
    quotaTokens: 0,
    expiresAt: ''
  })
  editingKeyId.value = null
  issuedKey.value = ''
  showForm.value = true
}

/** 编辑已有密钥（权限只能在这里改 —— 新建后不给入口就永远改不了） */
function openEdit(k: ApiKey): void {
  editingKeyId.value = k.id
  Object.assign(form, {
    name: k.name,
    userId: k.userId ?? '',
    channelId: k.channelId ?? '',
    modelAllowText: (k.modelAllow ?? []).join('\n'),
    usageAllow: k.usageAllow ?? false,
    usageRefresh: k.usageRefresh ?? false,
    usageScope: (k.usageChannels ?? []).length === 0 ? 'all' : 'pick',
    usageChannels: [...(k.usageChannels ?? [])],
    rpmLimit: k.rpmLimit,
    quotaTokens: k.quotaTokens,
    expiresAt: k.expiresAt ? k.expiresAt.slice(0, 10) : ''
  })
  issuedKey.value = ''
  showForm.value = true
}

async function submit(): Promise<void> {
  saving.value = true
  try {
    /*
     * 速率限制 / Token 配额是管理员下发的资源额度：非管理员**不提交**这两个字段。
     *
     * 创建时后端会静默使用系统默认值（defaultKeyRpmLimit / quotaTokens=0）；
     * 更新时后端对这两个字段直接 400。以前这里无条件带上，导致普通用户
     * 能把自己的密钥改成 999999 rpm / 无限配额。
     */
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      userId: isAdmin() ? form.userId || null : null,
      // 渠道绑定是管理面配置：操作员不传（后端也会忽略）
      channelId: isAdmin() ? form.channelId || null : undefined,
      modelAllow: parseList(form.modelAllowText),
      expiresAt: form.expiresAt || null
    }
    /*
     * usageAllow / usageRefresh / usageChannels 是管理面能力（读上游账目），
     * 与 rpm/quota 一样：非管理员不提交 —— 创建时后端回落 false，更新时后端直接 400。
     */
    if (isAdmin()) {
      body.rpmLimit = Number(form.rpmLimit)
      body.quotaTokens = Number(form.quotaTokens)
      body.usageAllow = form.usageAllow
      body.usageRefresh = form.usageRefresh
      /*
       * 'all' 提交空数组（= 全部渠道，含以后新增）；
       * 'pick' 提交显式 id 列表 —— 并拦掉"指定但一个都没选"，
       * 否则会退化成"全部"，与用户意图相反。
       */
      if (form.usageAllow && form.usageScope === 'pick' && form.usageChannels.length === 0) {
        // finally 会收敛 saving，这里直接退出即可
        toast.error(t('usage.pickChannelsRequired'))
        return
      }
      body.usageChannels = form.usageScope === 'all' ? [] : form.usageChannels
    }

    if (editingKeyId.value) {
      await api.patch('/api/keys/' + editingKeyId.value, body)
      toast.success(t('keys.updated'))
      showForm.value = false
      await load()
      return
    }

    const res = await api.post<{ apiKey: ApiKey; key: string }>('/api/keys', body)
    issuedKey.value = res.key
    issuedName.value = res.apiKey.name
    toast.success(t('keys.created'))
    await load()
  } catch (err) {
    toastError(err, t('keys.createFailed'))
  } finally {
    saving.value = false
  }
}

async function reveal(k: ApiKey): Promise<void> {
  revealTarget.value = k
  revealedKey.value = ''
  revealError.value = ''
  revealing.value = true
  try {
    const res = await api.get<{ key: string }>('/api/keys/' + k.id + '/reveal')
    revealedKey.value = res.key
  } catch (err) {
    revealError.value = errorText(err, t('keys.revealFailed'))
  } finally {
    revealing.value = false
  }
}

function closeReveal(): void {
  revealTarget.value = null
  revealedKey.value = ''
  revealError.value = ''
}

async function rotate(k: ApiKey): Promise<void> {
  if (!confirm(t('keys.rotateConfirm', { name: k.name }))) return
  try {
    const res = await api.post<{ apiKey: ApiKey; key: string }>('/api/keys/' + k.id + '/rotate')
    issuedKey.value = res.key
    issuedName.value = k.name
    showForm.value = true
    toast.success(t('keys.rotated'))
    await load()
  } catch (err) {
    toastError(err, t('keys.rotateFailed'))
  }
}

async function toggle(k: ApiKey): Promise<void> {
  try {
    await api.patch('/api/keys/' + k.id, {
      status: k.status === 'active' ? 'disabled' : 'active'
    })
    await load()
  } catch (err) {
    toastError(err, t('keys.opFailed'))
  }
}

async function remove(k: ApiKey): Promise<void> {
  if (!confirm(t('keys.deleteConfirm', { name: k.name }))) return
  try {
    await api.del('/api/keys/' + k.id)
    toast.success(t('keys.deleted'))
    await load()
  } catch (err) {
    toastError(err, t('keys.deleteFailed'))
  }
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('toast.copied'))
  } catch {
    toast.error(t('toast.copyFailed'))
  }
}

function canManage(k: ApiKey): boolean {
  return isAdmin() || k.userId === props.user?.id
}

function quotaPercent(k: ApiKey): number {
  if (k.quotaTokens <= 0) return 0
  return Math.min(100, Math.round((k.usedTokens / k.quotaTokens) * 100))
}

onMounted(() => {
  void loadKeyDefaults()
  void load()
})
</script>

<template>
  <div class="stack">
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">{{ t('nav.keys') }}</div>
          <div class="dim" style="font-size: 12px">
            {{ isAdmin() ? t('keys.subAdmin') : t('keys.subSelf') }} · {{ t('keys.subSuffix') }}
          </div>
        </div>
        <div class="row">
          <button class="btn btn-sm" @click="load">{{ t('common.refresh') }}</button>
          <button class="btn btn-primary btn-sm" @click="openCreate">＋ {{ t('keys.issue') }}</button>
        </div>
      </div>

      <div v-if="loading" class="loading">{{ t('common.loading') }}</div>
      <div v-else-if="keys.length === 0" class="empty">{{ t('keys.emptyHint') }}</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('common.name') }}</th>
              <th>{{ t('keys.owner') }}</th>
              <th>{{ t('keys.prefix') }}</th>
              <!-- 渠道绑定由管理员配置；操作员既看不到渠道列表也不应改绑定 -->
              <th v-if="isAdmin()">{{ t('keys.boundChannel') }}</th>
              <th>{{ t('keys.rateLimit') }}</th>
              <th>{{ t('keys.quota') }}</th>
              <th>{{ t('keys.lastUsed') }}</th>
              <th>{{ t('common.status') }}</th>
              <th style="width: 260px">{{ t('common.actions') }}</th>
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
              <td>
                <span v-if="k.ownerName">{{ k.ownerName }}</span>
                <span v-else class="dim">{{ t('keys.ownerNone') }}</span>
                <span v-if="k.userId === user?.id" class="tag" style="margin-left: 5px">
                  {{ t('keys.ownerMe') }}
                </span>
              </td>
              <td class="mono">{{ k.keyPrefix }}…</td>
              <td v-if="isAdmin()">{{ channelName(k.channelId) }}</td>
              <td class="nowrap">
                {{ k.rpmLimit === 0 ? t('keys.unlimited') : t('keys.perMin', { n: k.rpmLimit }) }}
              </td>
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
                        width: quotaPercent(k) + '%',
                        height: '100%',
                        background: quotaPercent(k) > 85 ? 'var(--danger)' : 'var(--accent)'
                      }"
                    />
                  </div>
                </template>
                <span v-else class="dim">
                  {{ t('keys.usedOnly', { n: formatNumber(k.usedTokens) }) }}
                </span>
              </td>
              <td class="nowrap dim">{{ formatTime(k.lastUsedAt) }}</td>
              <td>
                <span class="badge" :class="k.status === 'active' ? 'badge-ok' : 'badge-off'">
                  {{ k.status === 'active' ? t('common.enabled') : t('common.disabled') }}
                </span>
              </td>
              <td>
                <div class="row">
                  <button
                    v-if="canManage(k)"
                    class="btn btn-sm"
                    :disabled="!k.revealable"
                    :title="k.revealable ? t('keys.revealTooltip') : t('keys.revealDisabled')"
                    @click="reveal(k)"
                  >
                    {{ t('keys.reveal') }}
                  </button>
                  <button class="btn btn-sm" :disabled="!canManage(k)" @click="openEdit(k)">
                    {{ t('common.edit') }}
                  </button>
                  <button class="btn btn-sm" :disabled="!canManage(k)" @click="rotate(k)">
                    {{ t('keys.rotate') }}
                  </button>
                  <button class="btn btn-sm" :disabled="!canManage(k)" @click="toggle(k)">
                    {{ k.status === 'active' ? t('keys.disable') : t('keys.enable') }}
                  </button>
                  <button
                    class="btn btn-sm btn-danger"
                    :disabled="!canManage(k)"
                    @click="remove(k)"
                  >
                    {{ t('common.delete') }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <Modal
    v-if="revealTarget"
    :title="t('keys.revealTitle', { name: revealTarget.name })"
    wide
    @close="closeReveal"
  >
    <div class="alert">{{ t('keys.revealWarning') }}</div>

    <div v-if="revealing" class="loading">{{ t('keys.revealReading') }}</div>
    <div v-else-if="revealError" class="err-text">{{ revealError }}</div>
    <template v-else>
      <div class="code-box">{{ revealedKey }}</div>
      <div class="row row-wrap" style="margin-top: 12px">
        <button class="btn btn-primary btn-sm" @click="copy(revealedKey)">
          {{ t('keys.copyFull') }}
        </button>
        <span class="dim" style="font-size: 12px">
          {{ t('keys.usedFor', { prefix: revealTarget.keyPrefix }) }}
        </span>
      </div>
    </template>

    <div class="modal-foot">
      <button class="btn" @click="closeReveal">{{ t('common.close') }}</button>
    </div>
  </Modal>

  <Modal
    v-if="showForm"
    :title="
      editingKeyId ? t('keys.editTitle') : issuedKey ? t('keys.saveTitle') : t('keys.issueTitle')
    "
    wide
    @close="showForm = false"
  >
    <template v-if="issuedKey">
      <div class="alert alert-info">{{ t('keys.onlyOnce', { name: issuedName }) }}</div>
      <div class="code-box">{{ issuedKey }}</div>
      <div class="row" style="margin-top: 12px">
        <button class="btn btn-primary btn-sm" @click="copy(issuedKey)">{{ t('common.copy') }}</button>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="showForm = false">{{ t('keys.iSaved') }}</button>
      </div>
    </template>

    <template v-else>
      <div class="form-grid">
        <div class="field">
          <label>{{ t('common.name') }}</label>
          <input v-model="form.name" :placeholder="t('keys.namePlaceholder')" />
        </div>

        <div v-if="isAdmin()" class="field">
          <label>{{ t('keys.owner') }}</label>
          <PSelect v-model="form.userId" :options="ownerOptions" />
          <span class="hint">{{ t('keys.ownerHint') }}</span>
        </div>

        <div v-if="isAdmin()" class="field">
          <label>{{ t('keys.boundChannel') }}</label>
          <PSelect v-model="form.channelId" :options="channelOptions" />
          <span class="hint">{{ t('keys.boundHint') }}</span>
        </div>

        <div class="field">
          <label>{{ t('keys.modelAllow') }}</label>
          <textarea v-model="form.modelAllowText" rows="2" placeholder="gpt-4o-mini" />
          <span class="hint">{{ t('keys.modelAllowHint') }}</span>
        </div>

        <!-- 余额读取权限：只有管理员能授予（否则客户可读上游账目） -->
        <template v-if="isAdmin()">
          <div class="field">
            <label class="row" style="gap: 8px; display: inline-flex; cursor: pointer">
              <PCheckbox v-model="form.usageAllow" />
              {{ t('usage.canRead') }}
            </label>
            <span class="hint">{{ t('usage.canReadHint') }}</span>
          </div>

          <div class="field">
            <label class="row" style="gap: 8px; display: inline-flex; cursor: pointer">
              <PCheckbox v-model="form.usageRefresh" :disabled="!form.usageAllow" />
              {{ t('usage.canRefresh') }}
            </label>
            <span class="hint">{{ t('usage.canRefreshHint') }}</span>
          </div>
        </template>

        <!--
          可见渠道：**两种模式显式区分**。
          「全部渠道」= 空数组，含以后新增的渠道；「指定渠道」= 固定白名单。
          旧实现把全选写成一串当前 id，相当于快照 —— 新增渠道永远看不到。
        -->
        <div v-if="form.usageAllow && isAdmin()" class="field">
          <label>{{ t('usage.visibleChannels') }}</label>
          <div class="row" style="gap: 16px; align-items: center">
            <label class="row" style="gap: 6px; display: inline-flex; cursor: pointer">
              <input v-model="form.usageScope" type="radio" value="all" />
              {{ t('usage.scopeAll') }}
            </label>
            <label class="row" style="gap: 6px; display: inline-flex; cursor: pointer">
              <input v-model="form.usageScope" type="radio" value="pick" />
              {{ t('usage.scopePick') }}
            </label>
          </div>
          <span class="hint">
            {{ form.usageScope === 'all' ? t('usage.scopeAllHint') : t('usage.scopePickHint') }}
          </span>

          <template v-if="form.usageScope === 'pick'">
            <div class="row" style="gap: 8px; margin: 8px 0 6px">
              <button
                class="btn btn-sm"
                @click="form.usageChannels = channels.filter((x) => x.usageAdapter).map((c) => c.id)"
              >
                {{ t('usage.allChannels') }}
              </button>
              <button class="btn btn-sm" @click="form.usageChannels = []">
                {{ t('usage.clearChannels') }}
              </button>
            </div>
          </template>
          <div v-if="form.usageScope === 'pick'" class="batch-pick" style="max-height: 180px">
            <div
              v-for="c in channels.filter((x) => x.usageAdapter)"
              :key="c.id"
              class="batch-pick-item"
              :class="{ on: form.usageChannels.includes(c.id) }"
              @click="
                form.usageChannels.includes(c.id)
                  ? (form.usageChannels = form.usageChannels.filter((i) => i !== c.id))
                  : form.usageChannels.push(c.id)
              "
            >
              <span class="batch-pick-box">
                <svg
                  v-if="form.usageChannels.includes(c.id)"
                  width="10" height="10" viewBox="0 0 12 12"
                >
                  <path d="M2 6.4 4.6 9 10 3.4" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
              <span class="batch-name">{{ c.name }}</span>
              <span class="spacer" />
              <span class="batch-hint">{{ c.usageAdapter }}</span>
            </div>
            <div
              v-if="channels.filter((x) => x.usageAdapter).length === 0"
              class="psel-option-disabled"
              style="padding: 10px"
            >
              {{ t('usage.notConfigured') }}
            </div>
          </div>
          <span v-if="form.usageScope === 'pick'" class="hint">
            {{ t('usage.visibleChannelsHint') }}
          </span>
        </div>

        <!--
          限速 / 配额是管理员统一下发的资源额度：普通用户不显示输入框，
          否则界面上能改、提交却被后端拒绝（或更糟：静默忽略）。
          表格里仍会显示当前值，只是只读。
        -->
        <div v-if="isAdmin()" class="form-row">
          <div class="field">
            <label>{{ t('keys.rpm') }}</label>
            <input v-model.number="form.rpmLimit" type="number" min="0" />
            <span class="hint">{{ t('keys.rpmHint') }}</span>
          </div>
          <div class="field">
            <label>{{ t('keys.quotaTokens') }}</label>
            <input v-model.number="form.quotaTokens" type="number" min="0" />
            <span class="hint">{{ t('keys.quotaHint') }}</span>
          </div>
        </div>
        <div v-else class="field">
          <span class="hint">{{ t('keys.limitsAdminOnly') }}</span>
        </div>

        <div class="field">
          <label>{{ t('keys.expiresAt') }}</label>
          <input v-model="form.expiresAt" type="datetime-local" />
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="showForm = false">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" :disabled="saving" @click="submit">
          {{ saving ? t('common.saving') : t('common.create') }}
        </button>
      </div>
    </template>
  </Modal>
</template>
