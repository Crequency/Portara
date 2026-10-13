<script setup lang="ts">
import { computed, onMounted, ref, watchEffect } from 'vue'
import {
  api,
  cancelScheduledRefresh,
  setSessionExpiredHandler,
  type User
} from './api'
import PSelect from './components/PSelect.vue'
import ToastHost from './components/ToastHost.vue'
import { LOCALES, locale, setLocale, useI18n } from './i18n'
import { loadMeta, meta, siteName } from './meta'
import { THEME_MODES, setThemeMode, themeMode } from './theme'
import { toast } from './toast'
import ChannelDetailView from './views/ChannelDetailView.vue'
import ChannelsView from './views/ChannelsView.vue'
import ChatView from './views/ChatView.vue'
import KeysView from './views/KeysView.vue'
import LogoMark from './components/LogoMark.vue'
import LoginView from './views/LoginView.vue'
import LogsView from './views/LogsView.vue'
import OverviewView from './views/OverviewView.vue'
import ProxiesView from './views/ProxiesView.vue'
import SettingsView from './views/SettingsView.vue'
import UsageView from './views/UsageView.vue'
import UsersView from './views/UsersView.vue'

const { t } = useI18n()

const user = ref<User | null>(null)
const ready = ref(false)

/**
 * 极简路由：`#/<name>[/<param>]`
 * 例如 `#/channels` 与 `#/channels/<id>`（渠道详情子页面）
 */
interface Route {
  name: string
  param: string
}

function parseRoute(): Route {
  const raw = location.hash.replace(/^#\/?/, '')
  const [name = '', param = ''] = raw.split('/')
  return { name: name || 'overview', param }
}

const route = ref<Route>(parseRoute())
const isChannelDetail = computed(
  () => route.value.name === 'channels' && route.value.param.length > 0
)

const NAV = [
  { id: 'overview', icon: 'M3 12h4l3 8 4-16 3 8h4', adminOnly: false },
  { id: 'channels', icon: 'M4 7h16M4 12h16M4 17h10', adminOnly: false },
  { id: 'keys', icon: 'M14 7a4 4 0 1 0-3.5 4L4 17v3h3v-2h2v-2h2l1.5-1.5', adminOnly: false },
  { id: 'chat', icon: 'M4 5h16v11H8l-4 4z', adminOnly: true },
  { id: 'users', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21c0-3.3 3.6-5 8-5s8 1.7 8 5', adminOnly: false },
  { id: 'logs', icon: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5', adminOnly: false },
  { id: 'usage', icon: 'M4 19V9M9 19V5M14 19v-7M19 19v-4', adminOnly: true },
  { id: 'proxies', icon: 'M4 7h16v10H4zM8 11a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0M13 11h4M8 15h9', adminOnly: true },
  { id: 'settings', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z', adminOnly: true }
] as const

/** 对话测试需要读取密钥明文，仅管理员可见 */
const navItems = computed(() =>
  NAV.map((item) => ({ ...item, label: t('nav.' + item.id) })).filter(
    (item) => !item.adminOnly || user.value?.role === 'admin'
  )
)

const currentView = computed(() => {
  switch (route.value.name) {
    case 'channels':
      return ChannelsView
    case 'keys':
      return KeysView
    case 'chat':
      return ChatView
    case 'users':
      return UsersView
    case 'logs':
      return LogsView
    case 'usage':
      return UsageView
    case 'proxies':
      return ProxiesView
    case 'settings':
      return SettingsView
    default:
      return OverviewView
  }
})

const pageTitle = computed(() =>
  isChannelDetail.value ? t('channelDetail.title') : t('nav.' + route.value.name)
)
const pageSub = computed(() =>
  isChannelDetail.value ? t('channelDetail.sub') : t(route.value.name + '.sub')
)

/**
 * 当前路由是否对该用户可见。
 *
 * 仅靠「隐藏导航项」是不够的 —— 手动改 hash 就能进到页面壳子。
 * 管理专属页面必须在这里拦住，否则是「看不见但进得去」，
 * 既误导用户（页面显示着默认值），也让人以为权限控制只管导航。
 */
const routeAllowed = computed(() => {
  const item = NAV.find((i) => i.id === route.value.name)
  if (!item) return true
  return !item.adminOnly || user.value?.role === 'admin'
})

/** 左上角副标题：设置了网关名称就显示它，否则回落到默认文案 */
const brandSub = computed(() => meta.gatewayName.trim() || t('nav.appSub'))

/**
 * 浏览器标签标题：`网关名 · 当前页面`。
 * 用 watchEffect 而不是 onMounted，这样在设置页改完名称能立刻反映到标签上。
 */
watchEffect(() => {
  document.title = `${siteName()} · ${pageTitle.value}`
})

const languageOptions = computed(() =>
  LOCALES.map((l) => ({ value: l.value, label: l.label, hint: l.short }))
)
const themeOptions = computed(() =>
  THEME_MODES.map((m) => ({ value: m.value, label: t(m.labelKey) }))
)

function onHash(): void {
  route.value = parseRoute()
}

window.addEventListener('hashchange', onHash)

onMounted(async () => {
  // 与登录态并行拉取：登录页也要显示网关名称
  void loadMeta()
  try {
    const res = await api.get<{ user: User }>('/api/auth/me')
    user.value = res.user
  } catch {
    user.value = null
  } finally {
    ready.value = true
  }
})

// 会话彻底失效（refresh 也失败）→ 直接回登录页。
// 没有这个回调，用户会在各个页面看到零散的 401 错误提示，
// 却不知道自己已经掉线了。
setSessionExpiredHandler(() => {
  if (user.value) {
    user.value = null
    toast.error(t('auth.sessionExpired'))
  }
})

function onLoggedIn(u: User): void {
  user.value = u
  location.hash = '#/overview'
  route.value = { name: 'overview', param: '' }
}

async function logout(): Promise<void> {
  try {
    await api.post('/api/auth/logout')
  } finally {
    cancelScheduledRefresh()
    user.value = null
  }
}

function go(id: string): void {
  location.hash = '#/' + id
}
</script>

<template>
  <div v-if="!ready" class="loading">{{ t('common.loading') }}</div>

  <LoginView v-else-if="!user" @logged-in="onLoggedIn" />

  <div v-else class="shell">
    <aside class="sidebar">
      <div class="brand">
        <LogoMark :size="30" />
        <div>
          <div class="brand-name">{{ t('nav.appName') }}</div>
          <div class="brand-sub">{{ brandSub }}</div>
        </div>
      </div>

      <button
        v-for="item in navItems"
        :key="item.id"
        class="nav-item"
        :class="{ active: route.name === item.id }"
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
        <span>Portara v0.1.0</span>
        <span>AGPL-3.0</span>
      </div>
    </aside>

    <main class="main">
      <div class="topbar">
        <div>
          <div class="page-title">{{ pageTitle }}</div>
          <div class="page-sub">{{ pageSub }}</div>
        </div>

        <div class="topbar-tools">
          <div style="width: 136px">
            <PSelect
              :model-value="locale"
              :options="languageOptions"
              size="sm"
              align="end"
              @update:model-value="(v) => setLocale(v as 'zh' | 'en')"
            />
          </div>
          <div style="width: 132px">
            <PSelect
              :model-value="themeMode"
              :options="themeOptions"
              size="sm"
              align="end"
              @update:model-value="(v) => setThemeMode(v as 'system' | 'light' | 'dark')"
            />
          </div>

          <span class="badge" :class="user.role === 'admin' ? 'badge-info' : 'badge-off'">
            {{ user.displayName || user.username }} ·
            {{ user.role === 'admin' ? t('nav.admin') : t('nav.operator') }}
          </span>

          <button class="btn btn-sm" @click="logout">{{ t('nav.logout') }}</button>
        </div>
      </div>

      <div class="content">
        <div v-if="!routeAllowed" class="card">
          <div class="empty">{{ t('nav.noPermission') }}</div>
          <div class="row" style="justify-content: center">
            <button class="btn btn-sm" @click="go('overview')">
              {{ t('nav.backToOverview') }}
            </button>
          </div>
        </div>

        <ChannelDetailView
          v-else-if="isChannelDetail"
          :user="user"
          :channel-id="route.param"
        />
        <component :is="currentView" v-else :user="user" />
      </div>
    </main>
  </div>

  <ToastHost />
</template>
