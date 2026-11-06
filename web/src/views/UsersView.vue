<script setup lang="ts">
import { toastError } from '../error'
import { computed, onMounted, reactive, ref } from 'vue'
import {
  api,
  type RegistrationApplication,
  type RegistrationListResponse,
  type RegistrationStatus,
  type User
} from '../api'
import Modal from '../components/Modal.vue'
import PSelect from '../components/PSelect.vue'
import { formatTime } from '../format'
import { useI18n } from '../i18n'
import { toast } from '../toast'

const props = defineProps<{ user?: User }>()

const { t } = useI18n()

const users = ref<User[]>([])
const loading = ref(true)
const showForm = ref(false)
const saving = ref(false)
const editing = ref<User | null>(null)

/* ---------------------------------------------------------- 页签 */

const tab = ref<'users' | 'applications'>('users')

/* ---------------------------------------------------------- 用户列表 */

const form = reactive({
  username: '',
  displayName: '',
  password: '',
  role: 'operator' as 'admin' | 'operator',
  status: 'active' as 'active' | 'disabled'
})

const roleOptions = computed(() => [
  { value: 'operator', label: t('users.operator') },
  { value: 'admin', label: t('users.admin') }
])

const statusOptions = computed(() => [
  { value: 'active', label: t('common.enabled') },
  { value: 'disabled', label: t('common.disabled') }
])

const isAdmin = (): boolean => props.user?.role === 'admin'

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await api.get<{ users: User[] }>('/api/users')
    users.value = res.users
  } catch {
    toast.error(t('users.loadFailed'))
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  editing.value = null
  Object.assign(form, {
    username: '',
    displayName: '',
    password: '',
    role: 'operator',
    status: 'active'
  })
  showForm.value = true
}

function openEdit(u: User): void {
  editing.value = u
  Object.assign(form, {
    username: u.username,
    displayName: u.displayName,
    password: '',
    role: u.role,
    status: u.status
  })
  showForm.value = true
}

async function submit(): Promise<void> {
  if (!isAdmin()) return
  saving.value = true
  try {
    if (editing.value) {
      await api.patch('/api/users/' + editing.value.id, {
        displayName: form.displayName,
        role: form.role,
        status: form.status,
        ...(form.password ? { password: form.password } : {})
      })
      toast.success(t('users.updated'))
    } else {
      await api.post('/api/users', {
        username: form.username.trim(),
        displayName: form.displayName || form.username.trim(),
        password: form.password,
        role: form.role
      })
      toast.success(t('users.created'))
    }
    showForm.value = false
    await load()
  } catch (err) {
    toastError(err, t('users.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function remove(u: User): Promise<void> {
  if (!confirm(t('users.deleteConfirm', { username: u.username }))) return
  try {
    await api.del('/api/users/' + u.id)
    toast.success(t('users.deleted'))
    await load()
  } catch (err) {
    toastError(err, t('users.deleteFailed'))
  }
}

/* ---------------------------------------------------------- 注册申请 */

const applications = ref<RegistrationApplication[]>([])
const applicationsLoading = ref(false)
const appStatus = ref<RegistrationStatus>('pending')
const pendingCount = ref(0)
const rejectTarget = ref<RegistrationApplication | null>(null)
const rejectReason = ref('')
const rejectSaving = ref(false)
const actingId = ref('')

const statusFilters = computed(() => [
  { value: 'pending' as RegistrationStatus, label: t('registrations.pending') },
  { value: 'approved' as RegistrationStatus, label: t('registrations.approved') },
  { value: 'rejected' as RegistrationStatus, label: t('registrations.rejected') }
])

function statusLabel(status: RegistrationStatus): string {
  if (status === 'approved') return t('registrations.approved')
  if (status === 'rejected') return t('registrations.rejected')
  return t('registrations.pending')
}

function statusBadgeClass(status: RegistrationStatus): string {
  if (status === 'approved') return 'badge-ok'
  if (status === 'rejected') return 'badge-err'
  return 'badge-warn'
}

async function loadApplications(): Promise<void> {
  if (!isAdmin()) return
  applicationsLoading.value = true
  try {
    const res = await api.get<RegistrationListResponse>(
      '/api/registrations?status=' + appStatus.value
    )
    applications.value = res.applications
    pendingCount.value = res.pendingCount ?? 0
  } catch {
    toast.error(t('registrations.loadFailed'))
  } finally {
    applicationsLoading.value = false
  }
}

function selectTab(next: 'users' | 'applications'): void {
  tab.value = next
  if (next === 'applications') void loadApplications()
}

function setAppStatus(next: RegistrationStatus): void {
  if (appStatus.value === next) return
  appStatus.value = next
  void loadApplications()
}

async function approve(a: RegistrationApplication): Promise<void> {
  if (!confirm(t('registrations.approveConfirm', { username: a.username }))) return
  actingId.value = a.id
  try {
    await api.post('/api/registrations/' + a.id + '/approve')
    toast.success(t('registrations.approvedToast', { username: a.username }))
    // 用户列表也要刷新：刚刚建出来的账号必须立刻可见
    await Promise.all([loadApplications(), load()])
  } catch (err) {
    toastError(err, t('registrations.approveFailed'))
  } finally {
    actingId.value = ''
  }
}

function openReject(a: RegistrationApplication): void {
  rejectTarget.value = a
  rejectReason.value = ''
}

function closeReject(): void {
  rejectTarget.value = null
  rejectSaving.value = false
}

async function submitReject(): Promise<void> {
  const target = rejectTarget.value
  if (!target) return
  rejectSaving.value = true
  try {
    await api.post('/api/registrations/' + target.id + '/reject', {
      reason: rejectReason.value.trim()
    })
    toast.success(t('registrations.rejectedToast'))
    closeReject()
    await loadApplications()
  } catch (err) {
    toastError(err, t('registrations.rejectFailed'))
  } finally {
    rejectSaving.value = false
  }
}

onMounted(async () => {
  await load()
  // 页签徽标要的是「一进来就能看到待审批数」，所以加载用户列表时顺带取一次
  if (isAdmin()) await loadApplications()
})
</script>

<template>
  <div class="view-tabs">
    <div class="view-tabbar">
      <div class="segmented">
        <button :class="{ on: tab === 'users' }" @click="selectTab('users')">
          {{ t('users.tabUsers') }}
        </button>
        <button
          v-if="isAdmin()"
          :class="{ on: tab === 'applications' }"
          @click="selectTab('applications')"
        >
          {{ t('users.tabApplications') }}
          <span
            v-if="pendingCount > 0"
            class="badge badge-warn tab-badge"
            :title="t('registrations.pendingBadge', { n: pendingCount })"
          >
            {{ pendingCount }}
          </span>
        </button>
      </div>
    </div>

    <!-- 用户列表 -->
    <div v-show="tab === 'users'" class="card fill-view view-panel">
      <div class="card-head panel-head">
        <div>
          <div class="card-title">{{ t('users.tabUsers') }}</div>
          <div class="dim" style="font-size: 12px">{{ t('users.sub') }}</div>
        </div>
        <div class="row">
          <button class="btn btn-sm" @click="load">{{ t('common.refresh') }}</button>
          <button v-if="isAdmin()" class="btn btn-primary btn-sm" @click="openCreate">
            ＋ {{ t('users.newUser') }}
          </button>
        </div>
      </div>

      <div v-if="loading" class="loading">{{ t('common.loading') }}</div>
      <div v-else-if="users.length === 0" class="empty">{{ t('users.empty') }}</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('users.username') }}</th>
              <th>{{ t('users.displayName') }}</th>
              <th>{{ t('users.role') }}</th>
              <th>{{ t('users.status') }}</th>
              <th>{{ t('users.lastLogin') }}</th>
              <th style="width: 150px">{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <td class="mono">{{ u.username }}</td>
              <td>{{ u.displayName || '—' }}</td>
              <td>
                <span class="badge" :class="u.role === 'admin' ? 'badge-info' : 'badge-off'">
                  {{ u.role === 'admin' ? t('users.admin') : t('users.operator') }}
                </span>
              </td>
              <td>
                <span class="badge" :class="u.status === 'active' ? 'badge-ok' : 'badge-err'">
                  {{ u.status === 'active' ? t('common.enabled') : t('common.disabled') }}
                </span>
              </td>
              <td class="dim nowrap">{{ formatTime(u.lastLoginAt) }}</td>
              <td>
                <div v-if="isAdmin()" class="row">
                  <button class="btn btn-sm" @click="openEdit(u)">{{ t('common.edit') }}</button>
                  <button
                    class="btn btn-sm btn-danger"
                    :disabled="u.id === user?.id"
                    @click="remove(u)"
                  >
                    {{ t('common.delete') }}
                  </button>
                </div>
                <span v-else class="dim">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 注册申请（仅管理员可见，与后端 requireAdmin 一致） -->
    <div
      v-if="isAdmin()"
      v-show="tab === 'applications'"
      class="card fill-view view-panel registrations-panel"
    >
      <div class="card-head panel-head">
        <div>
          <div class="card-title">{{ t('registrations.title') }}</div>
          <div class="dim" style="font-size: 12px">{{ t('registrations.sub') }}</div>
        </div>
        <div class="row">
          <div class="segmented segmented-sm" role="group">
            <button
              v-for="opt in statusFilters"
              :key="opt.value"
              :class="{ on: appStatus === opt.value }"
              @click="setAppStatus(opt.value)"
            >
              {{ opt.label }}
            </button>
          </div>
          <button class="btn btn-sm" @click="loadApplications">{{ t('common.refresh') }}</button>
        </div>
      </div>

      <div v-if="applicationsLoading" class="loading">{{ t('common.loading') }}</div>
      <div v-else-if="applications.length === 0" class="empty">
        {{ t('registrations.empty') }}
      </div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('users.username') }}</th>
              <th>{{ t('users.displayName') }}</th>
              <th>{{ t('registrations.contact') }}</th>
              <th>{{ t('registrations.note') }}</th>
              <th>{{ t('registrations.submittedAt') }}</th>
              <th>{{ t('users.status') }}</th>
              <th style="width: 160px">{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in applications" :key="a.id">
              <td class="mono">{{ a.username }}</td>
              <td>{{ a.displayName || '—' }}</td>
              <td>{{ a.contact || '—' }}</td>
              <td class="dim" style="max-width: 240px; white-space: normal">
                {{ a.note || '—' }}
              </td>
              <td class="dim nowrap">{{ formatTime(a.createdAt) }}</td>
              <td>
                <span class="badge" :class="statusBadgeClass(a.status)">
                  {{ statusLabel(a.status) }}
                </span>
                <div
                  v-if="a.status === 'rejected' && a.rejectReason"
                  class="dim"
                  style="font-size: 11px; margin-top: 3px; max-width: 200px; white-space: normal"
                >
                  {{ a.rejectReason }}
                </div>
              </td>
              <td>
                <div v-if="a.status === 'pending'" class="row">
                  <button
                    class="btn btn-sm btn-primary"
                    :disabled="actingId === a.id"
                    @click="approve(a)"
                  >
                    {{ t('registrations.approve') }}
                  </button>
                  <button
                    class="btn btn-sm btn-danger"
                    :disabled="actingId === a.id"
                    @click="openReject(a)"
                  >
                    {{ t('registrations.reject') }}
                  </button>
                </div>
                <span v-else class="dim">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <Modal
    v-if="showForm"
    :title="editing ? t('users.editUser') : t('users.newUser')"
    @close="showForm = false"
  >
    <div class="form-grid">
      <div v-if="!editing" class="field">
        <label>{{ t('users.username') }}</label>
        <input v-model="form.username" placeholder="alice" />
        <span class="hint">{{ t('users.usernameHint') }}</span>
      </div>

      <div class="field">
        <label>{{ t('users.displayName') }}</label>
        <input v-model="form.displayName" placeholder="Alice" />
      </div>

      <div class="field">
        <label>{{ editing ? t('users.resetPassword') : t('users.password') }}</label>
        <input v-model="form.password" type="password" :placeholder="t('users.passwordHint')" />
      </div>

      <div class="form-row">
        <div class="field">
          <label>{{ t('users.role') }}</label>
          <PSelect v-model="form.role" :options="roleOptions" />
        </div>
        <div v-if="editing" class="field">
          <label>{{ t('users.status') }}</label>
          <PSelect v-model="form.status" :options="statusOptions" />
        </div>
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn" @click="showForm = false">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" :disabled="saving" @click="submit">
        {{ saving ? t('common.saving') : t('common.save') }}
      </button>
    </div>
  </Modal>

  <Modal
    v-if="rejectTarget"
    :title="t('registrations.rejectTitle')"
    @close="closeReject"
  >
    <div class="form-grid">
      <div class="field">
        <label for="reject-reason">{{ t('registrations.rejectReasonLabel') }}</label>
        <textarea
          id="reject-reason"
          v-model="rejectReason"
          rows="3"
          :placeholder="t('registrations.rejectReasonPlaceholder')"
        />
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn" @click="closeReject">{{ t('common.cancel') }}</button>
      <button class="btn btn-danger" :disabled="rejectSaving" @click="submitReject">
        {{ rejectSaving ? t('common.saving') : t('registrations.reject') }}
      </button>
    </div>
  </Modal>
</template>
