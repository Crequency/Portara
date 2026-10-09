<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { api, ApiError, type User } from '../api'
import Modal from '../components/Modal.vue'
import { formatTime } from '../format'
import { toast } from '../toast'

const props = defineProps<{ user?: User }>()

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

const isAdmin = () => props.user?.role === 'admin'

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await api.get<{ users: User[] }>('/api/users')
    users.value = res.users
  } catch {
    toast.error('加载用户失败')
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
      await api.patch(`/api/users/${editing.value.id}`, {
        displayName: form.displayName,
        role: form.role,
        status: form.status,
        ...(form.password ? { password: form.password } : {})
      })
      toast.success('用户已更新')
    } else {
      await api.post('/api/users', {
        username: form.username.trim(),
        displayName: form.displayName || form.username.trim(),
        password: form.password,
        role: form.role
      })
      toast.success('用户已创建')
    }
    showForm.value = false
    await load()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '保存失败')
  } finally {
    saving.value = false
  }
}

async function remove(u: User): Promise<void> {
  if (!confirm(`确定删除用户「${u.username}」？其签发的密钥不会被删除。`)) return
  try {
    await api.del(`/api/users/${u.id}`)
    toast.success('已删除')
    await load()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '删除失败')
  }
}

onMounted(load)
</script>

<template>
  <div class="card">
    <div class="card-head">
      <div>
        <div class="card-title">控制台用户</div>
        <div class="dim" style="font-size: 12px">
          管理员可管理渠道、用户与密钥；操作员只能查看与派发密钥
        </div>
      </div>
      <div class="row">
        <button class="btn btn-sm" @click="load">刷新</button>
        <button v-if="isAdmin()" class="btn btn-primary btn-sm" @click="openCreate">
          ＋ 新建用户
        </button>
      </div>
    </div>

    <div v-if="loading" class="loading">加载中…</div>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>用户名</th>
            <th>显示名</th>
            <th>角色</th>
            <th>状态</th>
            <th>最近登录</th>
            <th style="width: 150px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td class="mono">{{ u.username }}</td>
            <td>{{ u.displayName || '—' }}</td>
            <td>
              <span class="badge" :class="u.role === 'admin' ? 'badge-info' : 'badge-off'">
                {{ u.role === 'admin' ? '管理员' : '操作员' }}
              </span>
            </td>
            <td>
              <span class="badge" :class="u.status === 'active' ? 'badge-ok' : 'badge-err'">
                {{ u.status === 'active' ? '启用' : '禁用' }}
              </span>
            </td>
            <td class="dim nowrap">{{ formatTime(u.lastLoginAt) }}</td>
            <td>
              <div v-if="isAdmin()" class="row">
                <button class="btn btn-sm" @click="openEdit(u)">编辑</button>
                <button
                  class="btn btn-sm btn-danger"
                  :disabled="u.id === user?.id"
                  @click="remove(u)"
                >
                  删除
                </button>
              </div>
              <span v-else class="dim">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <Modal v-if="showForm" :title="editing ? '编辑用户' : '新建用户'" @close="showForm = false">
    <div class="form-grid">
      <div v-if="!editing" class="field">
        <label>用户名</label>
        <input v-model="form.username" placeholder="alice" />
        <span class="hint">字母、数字、. _ -，创建后不可修改。</span>
      </div>

      <div class="field">
        <label>显示名</label>
        <input v-model="form.displayName" placeholder="张三" />
      </div>

      <div class="field">
        <label>{{ editing ? '重置密码（留空不改）' : '密码' }}</label>
        <input v-model="form.password" type="password" placeholder="至少 8 位" />
      </div>

      <div class="form-row">
        <div class="field">
          <label>角色</label>
          <select v-model="form.role">
            <option value="operator">操作员</option>
            <option value="admin">管理员</option>
          </select>
        </div>
        <div v-if="editing" class="field">
          <label>状态</label>
          <select v-model="form.status">
            <option value="active">启用</option>
            <option value="disabled">禁用</option>
          </select>
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
