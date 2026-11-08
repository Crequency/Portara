<script setup lang="ts">
import { computed, onMounted, ref, watchEffect } from 'vue'
import type { Component } from 'vue'
import { Contrast, FileText, Github, Moon, Sun } from 'lucide-vue-next'
import {
  api,
  cancelScheduledRefresh,
  setSessionExpiredHandler,
  type User
} from './api'
import PSelect from './components/PSelect.vue'
import ToastHost from './components/ToastHost.vue'
import UserMenu from './components/UserMenu.vue'
import { diagState, enableDiag, setDiagDetail, setDiagLine } from './diag'
import { LOCALES, locale, setLocale, useI18n } from './i18n'
import { loadMeta, meta, siteName } from './meta'
import { setThemeMode, themeMode, type ThemeMode } from './theme'
import { toast } from './toast'
import BillingView from './views/BillingView.vue'
import ChannelDetailView from './views/ChannelDetailView.vue'
import ChannelFormView from './views/ChannelFormView.vue'
import ChannelsView from './views/ChannelsView.vue'
import ChatView from './views/ChatView.vue'
import KeysView from './views/KeysView.vue'
import LogoMark from './components/LogoMark.vue'
import AboutPage from './components/AboutPage.vue'
import LbLiveView from './views/LbLiveView.vue'
import LoginView from './views/LoginView.vue'
import LogsView from './views/LogsView.vue'
import OverviewView from './views/OverviewView.vue'
import ProfileView from './views/ProfileView.vue'
import ProxiesView from './views/ProxiesView.vue'
import RegisterView from './views/RegisterView.vue'
import SettingsView from './views/SettingsView.vue'
import UsageView from './views/UsageView.vue'
import UsersView from './views/UsersView.vue'

const { t } = useI18n()

const user = ref<User | null>(null)
const ready = ref(false)

/**
 * 极简路由：`#/<name>[/<param>[/<action>]]`
 *   `#/channels`             列表
 *   `#/channels/new`         新建渠道（子页面）
 *   `#/channels/<id>`        渠道详情
 *   `#/channels/<id>/edit`   编辑渠道（子页面）
 */
interface Route {
  name: string
  param: string
  action: string
}

function parseRoute(): Route {
  const raw = location.hash.replace(/^#\/?/, '')
  const [name = '', param = '', action = ''] = raw.split('/')
  return { name: name || 'overview', param, action }
}

const route = ref<Route>(parseRoute())

/**
 * 渠道的新建 / 编辑子页面。
 *
 * `new` 与 `edit` 是两条不同的入口但共用一个页面：新建时没有 channelId，
 * 页面自己去拉默认值；编辑时按 channelId 载入现有配置。
 */
const isChannelForm = computed(
  () =>
    route.value.name === 'channels' &&
    (route.value.param === 'new' || route.value.action === 'edit')
)
/** `new` 视为「没有 id」 */
const channelFormId = computed(() =>
  route.value.param === 'new' ? '' : route.value.param
)
const isChannelDetail = computed(
  () =>
    route.value.name === 'channels' &&
    route.value.param.length > 0 &&
    !isChannelForm.value
)

const NAV = [
  { id: 'overview', icon: 'M3 12h4l3 8 4-16 3 8h4', adminOnly: false },
  { id: 'channels', icon: 'M4 7h16M4 12h16M4 17h10', adminOnly: true },
  { id: 'keys', icon: 'M14 7a4 4 0 1 0-3.5 4L4 17v3h3v-2h2v-2h2l1.5-1.5', adminOnly: false },
  { id: 'chat', icon: 'M4 5h16v11H8l-4 4z', adminOnly: true },
  { id: 'users', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21c0-3.3 3.6-5 8-5s8 1.7 8 5', adminOnly: true },
  { id: 'logs', icon: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5', adminOnly: false },
  { id: 'usage', icon: 'M4 19V9M9 19V5M14 19v-7M19 19v-4', adminOnly: true },
  // 计费管理：套餐 / 费率 / 限额模板 / 用户余额，仅管理员
  { id: 'billing', icon: 'M3 7h18v10H3zM3 11h18M7 15h3', adminOnly: true },
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
    case 'billing':
      return BillingView
    case 'proxies':
      return ProxiesView
    // 负载均衡实况：入口在负载均衡页里，不占侧栏位置
    case 'lb-live':
      return LbLiveView
    case 'settings':
      return SettingsView
    // 个人资料不在侧栏 NAV 里，入口是顶栏用户卡片
    case 'profile':
      return ProfileView
    default:
      return OverviewView
  }
})

const pageTitle = computed(() => {
  if (isChannelForm.value) {
    return channelFormId.value ? t('channels.editChannel') : t('channels.newChannel')
  }
  // 公开注册页不属于 NAV，标题单独取；未登录时不会渲染顶栏，但浏览器标签要用
  if (route.value.name === 'register') return t('register.title')
  // 实况页是隐藏路由（入口在负载均衡页），没有 nav.* 文案
  if (route.value.name === 'lb-live') return t('lbLive.title')
  return isChannelDetail.value ? t('channelDetail.title') : t('nav.' + route.value.name)
})
const pageSub = computed(() => {
  if (isChannelForm.value) return t('channels.formSub')
  if (route.value.name === 'register') return t('register.subtitle')
  if (route.value.name === 'lb-live') return t('lbLive.sub')
  return isChannelDetail.value ? t('channelDetail.sub') : t(route.value.name + '.sub')
})

/**
 * 当前路由是否对该用户可见。
 *
 * 仅靠「隐藏导航项」是不够的 —— 手动改 hash 就能进到页面壳子。
 * 管理专属页面必须在这里拦住，否则是「看不见但进得去」，
 * 既误导用户（页面显示着默认值），也让人以为权限控制只管导航。
 */
/**
 * 不在侧栏 NAV 里的隐藏管理员路由。
 *
 * 这些页面只能从别的页面里的入口按钮进入（负载均衡 → 查看实况），
 * 但仍要参与权限判定：仅靠「不在 NAV 里」会让手动改 hash 的操作员直接进来。
 */
const HIDDEN_ADMIN_ROUTES = new Set(['lb-live'])

const routeAllowed = computed(() => {
  if (HIDDEN_ADMIN_ROUTES.has(route.value.name)) return user.value?.role === 'admin'
  const item = NAV.find((i) => i.id === route.value.name)
  if (!item) return true
  return !item.adminOnly || user.value?.role === 'admin'
})

/** 左上角副标题：设置了网关名称就显示它，否则回落到默认文案 */
const brandSub = computed(() => meta.gatewayName.trim() || t('nav.appSub'))

/** 构建指纹（由 vite define 注入）：页脚显示，用来确认浏览器跑的是哪次构建 */
const buildId = __BUILD_ID__

/*
 * 侧栏页脚的两个外链：仓库与许可证。
 *
 * 许可证指向仓库里的 LICENSE 文件，而不是 AGPL 官网 —— 用户要确认的是
 * 「这份代码以什么协议发布」，跳到本仓库的许可证全文更直接。
 * 版本号仍只从 /api/meta 来（见 meta.ts），这里不写死任何版本。
 */
const REPO_URL = 'https://github.com/Crequency/Portara'
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`

/*
 * 全屏「关于」页。
 *
 * 它不是路由页面：hash 完全不变，关闭后回到原来那一页。
 * 关闭时把焦点还给 Brand 按钮 —— 打开时焦点被移进了弹层，
 * 不还回去的话键盘用户会掉到 document.body 上。
 */
const aboutOpen = ref(false)
const brandBtn = ref<HTMLButtonElement | null>(null)

function openAbout(): void {
  aboutOpen.value = true
}

function closeAbout(): void {
  aboutOpen.value = false
  // 等 180ms 淡出结束、弹层卸载后再给焦点，避免焦点落在即将消失的节点上
  window.setTimeout(() => brandBtn.value?.focus(), 190)
}

/**
 * 浏览器标签标题：`网关名 · 当前页面`。
 * 用 watchEffect 而不是 onMounted，这样在设置页改完名称能立刻反映到标签上。
 */
watchEffect(() => {
  document.title = `${siteName()} · ${pageTitle.value}`
})

/*
 * 顶栏的语言入口是「地球 + 短标签」（中文 / EN），下拉里仍是完整语言名。
 * PSelect 用加法加出来的 triggerLabel / #prefix 实现，复用它已有的
 * 弹层定位、键盘与 ARIA 逻辑。
 */
const languageOptions = computed(() =>
  LOCALES.map((l) => ({ value: l.value, label: l.label }))
)
const localeShort = computed(
  () => LOCALES.find((l) => l.value === locale.value)?.short ?? locale.value
)

/*
 * 主题：点击循环 system → light → dark → system。
 * 顺序是刻意的 —— 「跟随系统」放回原位只需再点一次，不会在两种固定色之间来回卡住。
 */
const THEME_CYCLE: ThemeMode[] = ['system', 'light', 'dark']
/*
 * 图标一律来自 lucide（与侧栏 nav 的内联 path 同源风格）。
 * system 用 Contrast —— lucide 里「圆 + 半圆」的那枚（CircleHalf 并不存在，
 * 导出名查过：lucide-vue-next 0.x / 1.0 都只有 contrast）；light = Sun，dark = Moon。
 * 尺寸与描边跟侧栏 nav 对齐：16px / 1.7 / currentColor。
 */
const THEME_ICONS: Record<ThemeMode, Component> = {
  system: Contrast,
  light: Sun,
  dark: Moon
}
const themeLabel = computed(() => t('theme.' + themeMode.value))
const themeTitle = computed(() => `${t('nav.theme')} · ${themeLabel.value}`)
const themeIcon = computed(() => THEME_ICONS[themeMode.value])

function cycleTheme(): void {
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(themeMode.value) + 1) % THEME_CYCLE.length]
  setThemeMode(next!)
}

function onHash(): void {
  route.value = parseRoute()
}

window.addEventListener('hashchange', onHash)

/*
 * 诊断模式：?diag=1
 *
 * 线上"点了没反应"最难查的一点是：我们看不到用户的浏览器。
 * 打开后会在右上角挂一条小浮条，实时显示「最后一次点击命中的元素」，
 * 并把未捕获异常 / Promise 拒绝也显示出来：
 *   - 点按钮时浮条完全没有更新 → 点击根本没到达页面（被某个浮层挡住）
 *   - 浮条显示的是别的元素 → 命中测试被覆盖物拦了
 *   - 浮条显示按钮但没弹窗 → 处理函数内部出错（浮条会同时显示异常）
 * 只在带参数时启用，正常访问零开销。
 */
function initDiag(): void {
  if (!new URLSearchParams(location.search).has('diag')) return
  enableDiag()
  document.addEventListener(
    'click',
    (event) => {
      const el = event.target as HTMLElement | null
      const label = (el?.innerText || el?.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()
      setDiagLine(
        'click → ' + (el?.tagName?.toLowerCase() ?? '?') + ' .' +
          String(el?.className ?? '').split(' ').filter(Boolean).slice(0, 2).join('.') +
          (label ? ' 「' + label.slice(0, 24) + '」' : '')
      )
      setDiagDetail('…')
      // 350ms 后看弹窗到底有没有被创建、尺寸层级是否正常（这是"点了没弹窗"的关键证据）
      setTimeout(() => {
        const overlay = document.querySelector('.overlay') as HTMLElement | null
        if (!overlay) {
          setDiagDetail('350ms 后：没有 .overlay（弹窗从未创建）')
          return
        }
        const rect = overlay.getBoundingClientRect()
        const cs = getComputedStyle(overlay)
        const modal = document.querySelector('.modal') as HTMLElement | null
        const mr = modal?.getBoundingClientRect()
        setDiagDetail(
          '350ms 后：overlay ' + Math.round(rect.width) + '×' + Math.round(rect.height) +
            ' @(' + Math.round(rect.left) + ',' + Math.round(rect.top) + ')' +
            ' z=' + cs.zIndex + ' pos=' + cs.position +
            ' vis=' + cs.visibility + ' op=' + cs.opacity +
            (mr ? ' modal=' + Math.round(mr.width) + '×' + Math.round(mr.height) : ' modal=none')
        )
      }, 350)
    },
    true
  )
  window.addEventListener('error', (event) => {
    setDiagLine('JS error → ' + String(event.message).slice(0, 140))
  })
  window.addEventListener('unhandledrejection', (event) => {
    setDiagLine('Promise → ' + String(event.reason).slice(0, 140))
  })
}

onMounted(async () => {
  initDiag()
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

/*
 * 已登录用户手动访问 #/register 时回概览 —— 申请页对已有账号的人没有意义，
 * 留在那里只会看到一个能重复提交的表单（提交也会被 409 挡住）。
 * 用 watchEffect 而不是 onMounted：hash 变化、登录完成两个时机都要覆盖。
 */
watchEffect(() => {
  if (ready.value && user.value && route.value.name === 'register') {
    location.hash = '#/overview'
    route.value = { name: 'overview', param: '', action: '' }
  }
})

function onLoggedIn(u: User): void {
  user.value = u
  location.hash = '#/overview'
  route.value = { name: 'overview', param: '', action: '' }
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

  <!-- 未登录：申请页是公开的，其余路径都渲染登录页 -->
  <LoginView v-else-if="!user && route.name !== 'register'" @logged-in="onLoggedIn" />
  <RegisterView v-else-if="!user" />

  <div v-else class="shell">
    <aside class="sidebar">
      <!-- Brand 整块是一个按钮：点击展开全屏关于页（不改 hash） -->
      <button
        ref="brandBtn"
        type="button"
        class="brand brand-btn"
        :aria-label="t('about.open')"
        @click="openAbout"
      >
        <LogoMark :size="30" />
        <div>
          <div class="brand-name">{{ t('nav.appName') }}</div>
          <div class="brand-sub">{{ brandSub }}</div>
        </div>
      </button>

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
        <a
          class="nav-foot-link"
          :href="REPO_URL"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Github :size="12" :stroke-width="1.7" aria-hidden="true" />
          <span class="nav-foot-text">{{ meta.productName }}<template v-if="meta.version"> v{{ meta.version }}</template></span>
        </a>
        <!--
          构建指纹：排查"改了没生效"时，看一眼它就知道浏览器是不是还在跑旧产物。
          与导航链接分开一行，避免把仓库链接的文字撑长。
        -->
        <div class="nav-foot-text" :title="'build ' + buildId">build {{ buildId }}</div>
        <a
          class="nav-foot-link"
          :href="LICENSE_URL"
          target="_blank"
          rel="noopener noreferrer"
        >
          <FileText :size="12" :stroke-width="1.7" aria-hidden="true" />
          <span class="nav-foot-text">AGPL-3.0</span>
        </a>
      </div>
    </aside>

    <main class="main">
      <div class="topbar">
        <div>
          <div class="page-title">{{ pageTitle }}</div>
          <div class="page-sub">{{ pageSub }}</div>
        </div>

        <div class="topbar-tools">
          <!-- 语言：地球图标 + 当前语言短标签（中文 / EN），下拉里是完整语言名 -->
          <div class="lang-pick" :title="t('nav.language')">
            <PSelect
              :model-value="locale"
              :options="languageOptions"
              :trigger-label="localeShort"
              size="sm"
              align="end"
              @update:model-value="(v) => setLocale(v as 'zh' | 'en')"
            >
              <template #prefix>
                <svg
                  class="lang-globe"
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" />
                  <path
                    d="M3 12h18M12 3c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3Z"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </template>
            </PSelect>
          </div>

          <!-- 主题：圆形按钮，点击循环 system → light → dark -->
          <button
            type="button"
            class="icon-btn"
            :title="themeTitle"
            :aria-label="themeTitle"
            @click="cycleTheme"
          >
            <component
              :is="themeIcon"
              :size="16"
              :stroke-width="1.7"
              color="currentColor"
              aria-hidden="true"
            />
          </button>

          <!-- 用户：圆形图标 + 悬浮卡片（资料、角色、退出） -->
          <UserMenu :user="user" @logout="logout" />
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

        <ChannelFormView
          v-else-if="isChannelForm"
          :key="channelFormId || 'new'"
          :user="user"
          :channel-id="channelFormId"
        />
        <ChannelDetailView
          v-else-if="isChannelDetail"
          :user="user"
          :channel-id="route.param"
        />
        <component :is="currentView" v-else :user="user" />
      </div>
    </main>
  </div>

  <AboutPage :open="aboutOpen" @close="closeAbout" />
  <ToastHost />

  <!-- 诊断浮条：仅 ?diag=1 时出现，见 initDiag() 的注释 -->
  <div v-if="diagState.on" class="diag-bar" role="status" aria-live="polite">
    <span class="diag-bar-tag">DIAG</span>
    <span class="diag-bar-text">{{ diagState.line || '等待点击…' }}</span>
    <span v-if="diagState.detail" class="diag-bar-detail">{{ diagState.detail }}</span>
  </div>
</template>
