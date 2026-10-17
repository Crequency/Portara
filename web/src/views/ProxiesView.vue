<script setup lang="ts">
/**
 * 代理配置（仅管理员）。
 *
 * 两件事：
 *   ① 维护 HTTP 代理库（增删改查 + 查看密码，留审计）
 *   ② 延迟测试：对同一渠道分别测「直连」与「走代理」，给管理员一个可比的数据
 */
import { errorText, toastError } from '../error'
import { computed, onMounted, reactive, ref } from 'vue'
import { api, type Channel, type ProxyConfig, type User } from '../api'
import Modal from '../components/Modal.vue'
import PCheckbox from '../components/PCheckbox.vue'
import PSelect from '../components/PSelect.vue'
import { formatLatency, formatTime } from '../format'
import { useI18n } from '../i18n'
import { toast } from '../toast'

const props = defineProps<{ user?: User }>()

const { t } = useI18n()

const proxies = ref<ProxyConfig[]>([])
const channels = ref<Channel[]>([])
const loading = ref(true)

function emptyForm() {
  return {
    name: '',
    host: '',
    port: 8080,
    username: '',
    password: '',
    status: 'active' as 'active' | 'disabled',
    note: ''
  }
}

const form = reactive(emptyForm())
const showForm = ref(false)
const editingId = ref<string | null>(null)
const clearPassword = ref(false)
const saving = ref(false)

const revealOpen = ref(false)
const revealTarget = ref<ProxyConfig | null>(null)
const revealedPassword = ref('')
const revealError = ref('')
const revealing = ref(false)

// ---------------------------------------------------------------- 延迟测试

const testProxyId = ref('')
/** 勾选的渠道（可多选，批量测试） */
const selectedChannelIds = ref<string[]>([])
const channelSearch = ref('')
const testing = ref(false)
const progress = ref({ done: 0, total: 0 })

interface Probe {
  ok: boolean
  status: number
  latencyMs: number
  error?: string
}
interface LatencyRow {
  channelId: string
  channelName: string
  direct?: Probe
  proxied?: Probe
  deltaMs?: number
  comparable?: boolean
  error?: string
}
const results = ref<LatencyRow[]>([])

const proxyOptions = computed(() =>
  proxies.value.map((p) => ({
    value: p.id,
    label: p.name,
    hint: `${p.host}:${p.port}${p.status === 'disabled' ? ' · ' + t('common.disabled') : ''}`
  }))
)

/** 可勾选的渠道（按名字或地址过滤） */
const filteredChannels = computed(() => {
  const q = channelSearch.value.trim().toLowerCase()
  if (!q) return channels.value
  return channels.value.filter(
    (c) => c.name.toLowerCase().includes(q) || c.baseUrl.toLowerCase().includes(q)
  )
})

function toggleChannel(id: string): void {
  const i = selectedChannelIds.value.indexOf(id)
  if (i >= 0) selectedChannelIds.value.splice(i, 1)
  else selectedChannelIds.value.push(id)
}

function selectAllChannels(): void {
  selectedChannelIds.value = [
    ...new Set([...selectedChannelIds.value, ...filteredChannels.value.map((c) => c.id)])
  ]
}

function clearChannels(): void {
  selectedChannelIds.value = []
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const [p, c] = await Promise.all([
      api.get<{ proxies: ProxyConfig[] }>('/api/proxies'),
      api.get<{ channels: Channel[] }>('/api/channels')
    ])
    proxies.value = p.proxies
    channels.value = c.channels
    if (!testProxyId.value && proxies.value[0]) testProxyId.value = proxies.value[0].id
    // 渠道默认不预选：批量测试让用户自己决定要测哪些
    selectedChannelIds.value = selectedChannelIds.value.filter((id) =>
      channels.value.some((c) => c.id === id)
    )
  } catch (err) {
    toastError(err, t('proxies.loadFailed'))
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, emptyForm())
  clearPassword.value = false
  showForm.value = true
}

function openEdit(p: ProxyConfig): void {
  editingId.value = p.id
  Object.assign(form, {
    name: p.name,
    host: p.host,
    port: p.port,
    username: p.username,
    password: '',
    status: p.status,
    note: p.note
  })
  clearPassword.value = false
  showForm.value = true
}

async function submit(): Promise<void> {
  saving.value = true
  try {
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      host: form.host.trim(),
      port: Number(form.port),
      username: form.username.trim(),
      status: form.status,
      note: form.note
    }
    if (form.password) body.password = form.password
    if (clearPassword.value) body.clearPassword = true

    if (editingId.value) await api.patch('/api/proxies/' + editingId.value, body)
    else await api.post('/api/proxies', body)

    toast.success(t('proxies.saved'))
    showForm.value = false
    await load()
  } catch (err) {
    toastError(err, t('proxies.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function remove(p: ProxyConfig): Promise<void> {
  const msg = t('proxies.deleteConfirm', { name: p.name, n: p.channelCount })
  if (!window.confirm(msg)) return
  try {
    const res = await api.del<{ unboundChannels: string[] }>('/api/proxies/' + p.id)
    toast.success(t('proxies.deletedUnbound', { n: res.unboundChannels.length }))
    await load()
  } catch (err) {
    toastError(err, t('proxies.saveFailed'))
  }
}

async function revealPassword(p: ProxyConfig): Promise<void> {
  revealTarget.value = p
  revealOpen.value = true
  revealedPassword.value = ''
  revealError.value = ''
  revealing.value = true
  try {
    const res = await api.get<{ password: string }>('/api/proxies/' + p.id + '/reveal')
    revealedPassword.value = res.password
  } catch (err) {
    revealError.value = errorText(err, t('proxies.saveFailed'))
  } finally {
    revealing.value = false
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

/**
 * 批量延迟测试。
 *
 * **逐条顺序执行**，不并发 —— 并发探测会互相抢带宽，测出来的差值没有意义。
 * 顺序执行也顺带给了进度反馈（第 n/共 m 个）。
 */
async function runLatencyTest(): Promise<void> {
  if (!testProxyId.value) {
    toast.error(t('proxies.latencyNeedBoth'))
    return
  }
  if (selectedChannelIds.value.length === 0) {
    toast.error(t('proxies.latencyNoChannel'))
    return
  }

  const ids = [...selectedChannelIds.value]
  testing.value = true
  results.value = []
  progress.value = { done: 0, total: ids.length }

  for (const channelId of ids) {
    const name = channels.value.find((c) => c.id === channelId)?.name ?? channelId
    try {
      const r = await api.post<{
        direct: Probe
        proxied: Probe
        deltaMs: number
        comparable: boolean
      }>('/api/proxies/latency-test', { channelId, proxyId: testProxyId.value })
      results.value.push({
        channelId,
        channelName: name,
        direct: r.direct,
        proxied: r.proxied,
        deltaMs: r.deltaMs,
        comparable: r.comparable
      })
    } catch (err) {
      // 单个失败不中断整批 —— 批量测试的价值就在于一次看完
      results.value.push({
        channelId,
        channelName: name,
        error: errorText(err, t('proxies.latencyFailed'))
      })
    }
    progress.value.done += 1
  }

  testing.value = false
  await load() // 刷新「最近延迟」
}

/** 批量的汇总：可比的对数 */
const comparableCount = computed(() => results.value.filter((r) => r.comparable).length)

/** 差值配色：变快为绿、变慢为橙（都只是提示，不是结论） */
function deltaClass(row: LatencyRow): string {
  if (!row.comparable || row.deltaMs === undefined) return 'dim'
  return row.deltaMs > 0 ? 'delta-slow' : 'delta-fast'
}

onMounted(load)
</script>

<template>
  <div v-if="loading" class="loading">{{ t('common.loading') }}</div>

  <div v-else class="stack">
    <!-- 代理列表 -->
    <div class="card">
      <div class="card-head">
        <div class="card-title">{{ t('proxies.list') }}</div>
        <button class="btn btn-primary btn-sm" @click="openCreate">
          {{ t('proxies.create') }}
        </button>
      </div>

      <div v-if="proxies.length === 0" class="empty">
        {{ t('proxies.empty') }}
        <div class="dim" style="font-size: 12px; margin-top: 6px">{{ t('proxies.emptyHint') }}</div>
      </div>

      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('proxies.name') }}</th>
              <th>{{ t('proxies.address') }}</th>
              <th>{{ t('proxies.auth') }}</th>
              <th>{{ t('proxies.status') }}</th>
              <th>{{ t('proxies.channelCount') }}</th>
              <th>{{ t('proxies.lastLatency') }}</th>
              <th>{{ t('proxies.note') }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in proxies" :key="p.id">
              <td>{{ p.name }}</td>
              <td class="mono">{{ p.host }}:{{ p.port }}</td>
              <td class="dim">
                <template v-if="p.hasPassword">
                  {{ p.username || '—' }} · {{ p.passwordMasked }}
                  <button class="btn btn-ghost btn-sm" @click="revealPassword(p)">
                    {{ t('proxies.revealPassword') }}
                  </button>
                </template>
                <template v-else>{{ t('proxies.noAuth') }}</template>
              </td>
              <td>
                <span class="badge" :class="p.status === 'active' ? 'badge-ok' : 'badge-off'">
                  {{ p.status === 'active' ? t('common.enabled') : t('common.disabled') }}
                </span>
              </td>
              <td class="nowrap">{{ t('proxies.channelCountValue', { n: p.channelCount }) }}</td>
              <td class="nowrap">
                <span v-if="p.lastLatencyMs === null" class="dim">—</span>
                <span
                  v-else
                  class="badge"
                  :class="p.lastTestOk === false ? 'badge-err' : 'badge-ok'"
                >
                  {{ formatLatency(p.lastLatencyMs) }}
                </span>
                <div v-if="p.lastTestAt" class="dim" style="font-size: 11px">
                  {{ formatTime(p.lastTestAt) }}
                </div>
              </td>
              <td class="dim">{{ p.note || '—' }}</td>
              <td>
                <div class="row">
                  <button class="btn btn-sm" @click="openEdit(p)">{{ t('common.edit') }}</button>
                  <button class="btn btn-sm btn-danger" @click="remove(p)">
                    {{ t('common.delete') }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 延迟测试 -->
    <div class="card">
      <div class="card-head">
        <div class="card-title">{{ t('proxies.latencyTitle') }}</div>
        <span class="dim" style="font-size: 12px">{{ t('proxies.latencyHint') }}</span>
      </div>

      <div class="row row-wrap" style="align-items: flex-start">
        <div class="field" style="min-width: 240px">
          <label>{{ t('proxies.latencyProxy') }}</label>
          <PSelect v-model="testProxyId" :options="proxyOptions" />
          <span class="hint">{{ t('proxies.latencyBatchHint') }}</span>
        </div>
      </div>

      <!-- 渠道多选：复用批量选择列表的样式，名称与地址都能完整显示 -->
      <div class="field" style="margin-top: 12px">
        <div class="row-between">
          <label>
            {{ t('proxies.latencyChannels') }}
            · {{ t('proxies.latencySelected', { n: selectedChannelIds.length }) }}
          </label>
          <div class="row">
            <button class="btn btn-sm" @click="selectAllChannels">
              {{ t('proxies.latencySelectAll') }}
            </button>
            <button class="btn btn-sm" @click="clearChannels">{{ t('proxies.latencyClear') }}</button>
            <button
              class="btn btn-primary btn-sm"
              :disabled="testing || !testProxyId || selectedChannelIds.length === 0"
              @click="runLatencyTest"
            >
              {{
                testing
                  ? t('proxies.latencyProgress', progress)
                  : t('proxies.latencyRun')
              }}
            </button>
          </div>
        </div>

        <input v-model="channelSearch" :placeholder="t('proxies.latencySearch')" />

        <div class="batch-pick">
          <div
            v-for="c in filteredChannels"
            :key="c.id"
            class="batch-pick-item"
            :class="{ on: selectedChannelIds.includes(c.id) }"
            @click="toggleChannel(c.id)"
          >
            <span class="batch-pick-box">
              <svg
                v-if="selectedChannelIds.includes(c.id)"
                width="10" height="10" viewBox="0 0 12 12"
              >
                <path d="M2 6.4 4.6 9 10 3.4" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <span class="batch-name">{{ c.name }}</span>
            <span class="spacer" />
            <span class="batch-hint mono">{{ c.baseUrl }}</span>
          </div>
          <div v-if="filteredChannels.length === 0" class="psel-option-disabled" style="padding: 10px">
            —
          </div>
        </div>
      </div>

      <!-- 结果表：一行一个渠道 -->
      <div v-if="results.length > 0" class="table-wrap" style="margin-top: 14px">
        <table>
          <thead>
            <tr>
              <th>{{ t('proxies.latencyResultChannel') }}</th>
              <th>{{ t('proxies.latencyDirect') }}</th>
              <th>{{ t('proxies.latencyProxied') }}</th>
              <th>{{ t('proxies.latencyDelta') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in results" :key="row.channelId">
              <td>{{ row.channelName }}</td>
              <template v-if="row.error">
                <td colspan="3" class="err-text">{{ row.error }}</td>
              </template>
              <template v-else>
                <td class="nowrap">
                  {{ formatLatency(row.direct?.latencyMs) }}
                  <span :class="row.direct?.ok ? 'delta-fast' : 'delta-slow'">
                    {{ row.direct?.ok ? t('proxies.ok') : t('proxies.fail') }}
                  </span>
                  <!-- 失败原因必须给出来：只说「不可用」等于让用户去猜 -->
                  <div v-if="!row.direct?.ok && row.direct?.error" class="probe-error">
                    {{ row.direct.error }}
                  </div>
                </td>
                <td class="nowrap">
                  {{ formatLatency(row.proxied?.latencyMs) }}
                  <span :class="row.proxied?.ok ? 'delta-fast' : 'delta-slow'">
                    {{ row.proxied?.ok ? t('proxies.ok') : t('proxies.fail') }}
                  </span>
                  <div v-if="!row.proxied?.ok && row.proxied?.error" class="probe-error">
                    {{ row.proxied.error }}
                  </div>
                </td>
                <td class="nowrap" :class="deltaClass(row)">
                  <template v-if="row.deltaMs === undefined">—</template>
                  <template v-else>
                    {{ row.deltaMs > 0 ? '+' : '' }}{{ formatLatency(Math.abs(row.deltaMs)) }}
                    <span v-if="!row.comparable" class="dim">
                      · {{ t('proxies.latencyUncomparable') }}
                    </span>
                  </template>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="dim" style="font-size: 12px; margin-top: 12px">
        {{ t('proxies.latencyEmptyResult') }}
      </div>
      <div v-if="comparableCount > 0" class="dim" style="font-size: 11.5px; margin-top: 6px">
        {{ comparableCount }} / {{ results.length }}
      </div>
    </div>
  </div>

  <!-- 新建 / 编辑 -->
  <Modal
    v-if="showForm"
    :title="editingId ? t('proxies.edit') : t('proxies.create')"
    @close="showForm = false"
  >
    <div class="form-grid">
      <div class="field">
        <label>{{ t('proxies.name') }}</label>
        <input v-model="form.name" maxlength="64" placeholder="office-proxy" />
      </div>
      <div class="grid grid-2">
        <div class="field">
          <label>{{ t('proxies.host') }}</label>
          <input v-model="form.host" placeholder="127.0.0.1" />
        </div>
        <div class="field">
          <label>{{ t('proxies.port') }}</label>
          <input v-model.number="form.port" type="number" min="1" max="65535" />
        </div>
      </div>
      <div class="grid grid-2">
        <div class="field">
          <label>{{ t('proxies.username') }}</label>
          <input v-model="form.username" autocomplete="off" />
        </div>
        <div class="field">
          <label>{{ t('proxies.password') }}</label>
          <input
            v-model="form.password"
            type="password"
            autocomplete="new-password"
            :placeholder="editingId ? t('proxies.passwordKeep') : ''"
          />
        </div>
      </div>
      <span class="hint">{{ t('proxies.passwordHint') }}</span>

      <div v-if="editingId" class="field">
        <label class="row" style="gap: 8px; display: inline-flex; cursor: pointer">
          <PCheckbox v-model="clearPassword" />
          {{ t('proxies.clearPassword') }}
        </label>
      </div>

      <div class="field">
        <label>{{ t('proxies.status') }}</label>
        <PSelect
          v-model="form.status"
          :options="[
            { value: 'active', label: t('common.enabled') },
            { value: 'disabled', label: t('common.disabled') }
          ]"
        />
      </div>

      <div class="field">
        <label>{{ t('proxies.note') }}</label>
        <input v-model="form.note" maxlength="500" />
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn" @click="showForm = false">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" :disabled="saving" @click="submit">
        {{ saving ? t('common.saving') : t('common.save') }}
      </button>
    </div>
  </Modal>

  <!-- 查看密码 -->
  <Modal
    v-if="revealOpen && revealTarget"
    :title="t('proxies.revealPassword') + ' · ' + revealTarget.name"
    wide
    @close="revealOpen = false"
  >
    <div class="alert">{{ t('proxies.revealWarning') }}</div>
    <div v-if="revealing" class="loading">{{ t('common.loading') }}</div>
    <div v-else-if="revealError" class="err-text">{{ revealError }}</div>
    <template v-else>
      <div class="code-box">{{ revealedPassword }}</div>
      <div class="row" style="margin-top: 12px">
        <button class="btn btn-primary btn-sm" @click="copy(revealedPassword)">
          {{ t('channels.copyFullKey') }}
        </button>
      </div>
    </template>
    <div class="modal-foot">
      <button class="btn" @click="revealOpen = false">{{ t('common.close') }}</button>
    </div>
  </Modal>
</template>

<style scoped>
.probe-error {
  font-size: 11px;
  color: var(--danger);
  max-width: 260px;
  white-space: normal;
  line-height: 1.35;
}
.delta-fast {
  color: var(--success);
}
.delta-slow {
  color: var(--warn);
}
</style>
