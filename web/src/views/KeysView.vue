<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { api, ApiError, type ApiKey, type Channel, type User } from '../api'
import Modal from '../components/Modal.vue'
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
  rpmLimit: 60,
  quotaTokens: 0,
  expiresAt: ''
})

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
    const [k, c] = await Promise.all([
      api.get<{ keys: ApiKey[] }>('/api/keys'),
      api.get<{ channels: Channel[] }>('/api/channels')
    ])
    keys.value = k.keys
    channels.value = c.channels

    if (isAdmin()) {
      try {
        const u = await api.get<{ users: User[] }>('/api/users')
        users.value = u.users
      } catch {
        users.value = []
      }
    }
  } catch {
    toast.error(t('keys.loadFailed'))
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  Object.assign(form, {
    name: '',
    userId: props.user?.id ?? '',
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
      userId: isAdmin() ? form.userId || null : null,
      channelId: form.channelId || null,
      modelAllow: parseList(form.modelAllowText),
      rpmLimit: Number(form.rpmLimit),
      quotaTokens: Number(form.quotaTokens),
      expiresAt: form.expiresAt || null
    })
    issuedKey.value = res.key
    issuedName.value = res.apiKey.name
    toast.success(t('keys.created'))
    await load()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : t('keys.createFailed'))
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
    revealError.value = err instanceof ApiError ? err.message : t('keys.revealFailed')
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
    toast.error(err instanceof ApiError ? err.message : t('keys.rotateFailed'))
  }
}

async function toggle(k: ApiKey): Promise<void> {
  try {
    await api.patch('/api/keys/' + k.id, {
      status: k.status === 'active' ? 'disabled' : 'active'
    })
    await load()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : t('keys.opFailed'))
  }
}

async function remove(k: ApiKey): Promise<void> {
  if (!confirm(t('keys.deleteConfirm', { name: k.name }))) return
  try {
    await api.del('/api/keys/' + k.id)
    toast.success(t('keys.deleted'))
    await load()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : t('keys.deleteFailed'))
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

onMounted(load)
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
              <th>{{ t('keys.boundChannel') }}</th>
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
              <td>{{ channelName(k.channelId) }}</td>
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
    :title="issuedKey ? t('keys.saveTitle') : t('keys.issueTitle')"
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

        <div class="field">
          <label>{{ t('keys.boundChannel') }}</label>
          <PSelect v-model="form.channelId" :options="channelOptions" />
          <span class="hint">{{ t('keys.boundHint') }}</span>
        </div>

        <div class="field">
          <label>{{ t('keys.modelAllow') }}</label>
          <textarea v-model="form.modelAllowText" rows="2" placeholder="gpt-4o-mini" />
          <span class="hint">{{ t('keys.modelAllowHint') }}</span>
        </div>

        <div class="form-row">
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
