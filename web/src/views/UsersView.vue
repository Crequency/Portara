<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { api, ApiError, type User } from '../api'
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
    toast.error(err instanceof ApiError ? err.message : t('users.saveFailed'))
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
    toast.error(err instanceof ApiError ? err.message : t('users.deleteFailed'))
  }
}

onMounted(load)
</script>

<template>
  <div class="card">
    <div class="card-head">
      <div>
        <div class="card-title">{{ t('nav.users') }}</div>
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
</template>
