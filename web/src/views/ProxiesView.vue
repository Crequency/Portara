<script setup lang="ts">
/**
 * 代理配置（仅管理员）。
 *
 * 两件事：
 *   ① 维护 HTTP 代理库（增删改查 + 查看密码，留审计）
 *   ② 延迟测试：对同一渠道分别测「直连」与「走代理」，给管理员一个可比的数据
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { api, ApiError, type Channel, type ProxyConfig, type User } from '../api'
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
const testChannelId = ref('')
const testing = ref(false)
const testResult = ref<{
  channel: { id: string; name: string }
  proxy: { id: string; name: string }
  direct: { ok: boolean; status: number; latencyMs: number; error?: string }
  proxied: { ok: boolean; status: number; latencyMs: number; error?: string }
  deltaMs: number
  comparable: boolean
} | null>(null)

const proxyOptions = computed(() =>
  proxies.value.map((p) => ({
    value: p.id,
    label: p.name,
    hint: `${p.host}:${p.port}${p.status === 'disabled' ? ' · ' + t('common.disabled') : ''}`
  }))
)
const channelOptions = computed(() =>
  channels.value.map((c) => ({ value: c.id, label: c.name, hint: c.baseUrl }))
)

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
    if (!testChannelId.value && channels.value[0]) testChannelId.value = channels.value[0].id
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : t('proxies.loadFailed'))
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
    toast.error(err instanceof ApiError ? err.message : t('proxies.saveFailed'))
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
    toast.error(err instanceof ApiError ? err.message : t('proxies.saveFailed'))
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
    revealError.value = err instanceof ApiError ? err.message : t('proxies.saveFailed')
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

async function runLatencyTest(): Promise<void> {
  if (!testProxyId.value || !testChannelId.value) {
    toast.error(t('proxies.latencyNeedBoth'))
    return
  }
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await api.post('/api/proxies/latency-test', {
      channelId: testChannelId.value,
      proxyId: testProxyId.value
    })
    await load() // 刷新「最近延迟」
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : t('proxies.latencyFailed'))
  } finally {
    testing.value = false
  }
}

/** 差值配色：变快为绿、变慢为橙（都只是提示，不是结论） */
function deltaClass(ms: number): string {
  if (!testResult.value?.comparable) return 'dim'
  return ms > 0 ? 'delta-slow' : 'delta-fast'
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

      <div class="row row-wrap">
        <div class="field" style="min-width: 220px">
          <label>{{ t('proxies.latencyProxy') }}</label>
          <PSelect v-model="testProxyId" :options="proxyOptions" />
        </div>
        <div class="field" style="min-width: 220px">
          <label>{{ t('proxies.latencyChannel') }}</label>
          <PSelect v-model="testChannelId" :options="channelOptions" />
        </div>
        <button
          class="btn btn-primary"
          style="align-self: flex-end"
          :disabled="testing"
          @click="runLatencyTest"
        >
          {{ testing ? t('proxies.latencyRunning') : t('proxies.latencyRun') }}
        </button>
      </div>

      <div v-if="testResult" style="margin-top: 14px">
        <div class="grid grid-3">
          <div class="stat">
            <div class="stat-label">{{ t('proxies.latencyDirect') }}</div>
            <div class="stat-value">{{ formatLatency(testResult.direct.latencyMs) }}</div>
            <div class="stat-hint">
              <span :class="testResult.direct.ok ? 'delta-fast' : 'delta-slow'">
                {{ testResult.direct.ok ? t('proxies.ok') : t('proxies.fail') }}
              </span>
              <span v-if="testResult.direct.error" class="dim">
                · {{ testResult.direct.error }}
              </span>
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">{{ t('proxies.latencyProxied') }}</div>
            <div class="stat-value">{{ formatLatency(testResult.proxied.latencyMs) }}</div>
            <div class="stat-hint">
              <span :class="testResult.proxied.ok ? 'delta-fast' : 'delta-slow'">
                {{ testResult.proxied.ok ? t('proxies.ok') : t('proxies.fail') }}
              </span>
              <span v-if="testResult.proxied.error" class="dim">
                · {{ testResult.proxied.error }}
              </span>
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">{{ t('proxies.latencyDelta') }}</div>
            <div class="stat-value" :class="deltaClass(testResult.deltaMs)">
              {{ testResult.deltaMs > 0 ? '+' : '' }}{{ formatLatency(Math.abs(testResult.deltaMs)) }}
            </div>
            <div v-if="!testResult.comparable" class="stat-hint delta-slow">
              {{ t('proxies.latencyUncomparable') }}
            </div>
          </div>
        </div>
        <div class="dim" style="font-size: 12px; margin-top: 8px">
          {{ testResult.channel.name }} → {{ testResult.proxy.name }}
        </div>
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
.delta-fast {
  color: var(--success);
}
.delta-slow {
  color: var(--warn);
}
</style>
