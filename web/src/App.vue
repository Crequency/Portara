<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, type User } from './api'
import ToastHost from './components/ToastHost.vue'
import ChannelsView from './views/ChannelsView.vue'
import KeysView from './views/KeysView.vue'
import LoginView from './views/LoginView.vue'
import LogsView from './views/LogsView.vue'
import OverviewView from './views/OverviewView.vue'
import UsersView from './views/UsersView.vue'

const user = ref<User | null>(null)
const ready = ref(false)
const route = ref(currentRoute())

const NAV = [
  { id: 'overview', label: '概览', icon: 'M3 12h4l3 8 4-16 3 8h4' },
  { id: 'channels', label: '上游渠道', icon: 'M4 7h16M4 12h16M4 17h10' },
  { id: 'keys', label: 'API 密钥', icon: 'M14 7a4 4 0 1 0-3.5 4L4 17v3h3v-2h2v-2h2l1.5-1.5' },
  { id: 'users', label: '用户', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21c0-3.3 3.6-5 8-5s8 1.7 8 5' },
  { id: 'logs', label: '请求日志', icon: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5' }
] as const

const PAGE_META: Record<string, { title: string; sub: string }> = {
  overview: { title: '概览', sub: '网关运行状态与今日用量' },
  channels: { title: '上游渠道', sub: '配置 OpenAI 兼容的上游服务' },
  keys: { title: 'API 密钥', sub: '签发与吊销调用方密钥' },
  users: { title: '用户', sub: '管理控制台账号与权限' },
  logs: { title: '请求日志', sub: '每一次转发的元数据（不含正文）' }
}

const currentView = computed(() => {
  switch (route.value) {
    case 'channels':
      return ChannelsView
    case 'keys':
      return KeysView
    case 'users':
      return UsersView
    case 'logs':
      return LogsView
    default:
      return OverviewView
  }
})

function currentRoute(): string {
  const raw = location.hash.replace(/^#\/?/, '')
  return raw || 'overview'
}

function onHash(): void {
  route.value = currentRoute()
}

window.addEventListener('hashchange', onHash)

onMounted(async () => {
  try {
    const res = await api.get<{ user: User }>('/api/auth/me')
    user.value = res.user
  } catch {
    user.value = null
  } finally {
    ready.value = true
  }
})

function onLoggedIn(u: User): void {
  user.value = u
  location.hash = '#/overview'
  route.value = 'overview'
}

async function logout(): Promise<void> {
  try {
    await api.post('/api/auth/logout')
  } finally {
    user.value = null
  }
}

function go(id: string): void {
  location.hash = `#/${id}`
}
</script>

<template>
  <div v-if="!ready" class="loading">正在加载…</div>

  <LoginView v-else-if="!user" @logged-in="onLoggedIn" />

  <div v-else class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
            <path
              d="M7 20V9a5 5 0 0 1 10 0v11"
              stroke="#fff"
              stroke-width="2.2"
              stroke-linecap="round"
            />
          </svg>
        </div>
        <div>
          <div class="brand-name">Portara</div>
          <div class="brand-sub">AI 网关控制台</div>
        </div>
      </div>

      <button
        v-for="item in NAV"
        :key="item.id"
        class="nav-item"
        :class="{ active: route === item.id }"
        @click="go(item.id)"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path
            :d="item.icon"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        {{ item.label }}
      </button>

      <div class="nav-spacer" />

      <div class="nav-foot">
        <div class="row-between">
          <span>{{ user.displayName || user.username }}</span>
          <span class="badge" :class="user.role === 'admin' ? 'badge-info' : 'badge-off'">
            {{ user.role === 'admin' ? '管理员' : '操作员' }}
          </span>
        </div>
        <button class="btn btn-ghost btn-sm" @click="logout">退出登录</button>
      </div>
    </aside>

    <main class="main">
      <div class="topbar">
        <div>
          <div class="page-title">{{ PAGE_META[route]?.title ?? '概览' }}</div>
          <div class="page-sub">{{ PAGE_META[route]?.sub ?? '' }}</div>
        </div>
        <a class="btn btn-sm" href="/v1/models" target="_blank" rel="noreferrer">
          /v1 端点
        </a>
      </div>

      <div class="content">
        <component :is="currentView" :user="user" />
      </div>
    </main>
  </div>

  <ToastHost />
</template>
