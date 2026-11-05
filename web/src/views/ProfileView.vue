<script setup lang="ts">
/**
 * 个人资料页。
 *
 * 入口在顶栏用户卡片（不在侧栏 NAV）：这里展示的是「当前账号」的
 * 资料 + 用户范围统计，不是一项功能模块。
 *
 * 统计口径与概览页不同 —— 只看自己名下的 API Key，详见后端 profile 路由。
 */
import { computed, onMounted, ref } from 'vue'
import { api, type ProfileResponse, type User } from '../api'
import UsageTrendCard from '../components/UsageTrendCard.vue'
import { formatCompact, formatNumber, formatPercent, formatTime } from '../format'
import { useI18n } from '../i18n'
import { toast } from '../toast'

/**
 * user 由 App.vue 传入（已登录用户），只作为接口返回前的兜底：
 * 即使 /api/profile 失败，页头与账户信息也还能显示。
 */
const props = defineProps<{ user?: User }>()

const { t } = useI18n()

const data = ref<ProfileResponse | null>(null)
const loading = ref(true)

const user = computed<User | null>(() => data.value?.user ?? props.user ?? null)
const stats = computed(() => data.value?.stats ?? null)

/** 头像圆点：用户名首字母（中文取第一个字，英文取首字母大写） */
const initial = computed(
  () => Array.from((user.value?.username ?? '').trim())[0]?.toUpperCase() ?? '?'
)

const roleLabel = computed(() =>
  user.value?.role === 'admin' ? t('nav.admin') : t('nav.operator')
)
const statusLabel = computed(() =>
  user.value?.status === 'active' ? t('common.active') : t('common.disabled')
)

/**
 * 错误率：没有请求时按 0% 显示。
 *
 * 不能直接用 formatPercent(0) —— 它会输出 "0.0%"，而口径要求是 "0%"。
 */
const errorRateText = computed(() => {
  const s = stats.value
  if (!s || s.requests === 0 || s.errors === 0) return '0%'
  return formatPercent(s.errors / s.requests)
})

async function load(): Promise<void> {
  loading.value = true
  try {
    data.value = await api.get<ProfileResponse>('/api/profile')
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('profile.loadFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <div class="stack">
    <div v-if="loading" class="loading">{{ t('common.loading') }}</div>

    <template v-else>
      <div v-if="user" class="card profile-head">
        <div class="profile-id">
          <span class="profile-avatar" aria-hidden="true">{{ initial }}</span>
          <div class="profile-meta">
            <div class="profile-name">{{ user.displayName || user.username }}</div>
            <div class="profile-handle">@{{ user.username }}</div>
            <div class="profile-badges">
              <span class="badge" :class="user.role === 'admin' ? 'badge-info' : 'badge-off'">
                {{ roleLabel }}
              </span>
              <span class="badge" :class="user.status === 'active' ? 'badge-ok' : 'badge-off'">
                {{ statusLabel }}
              </span>
            </div>
          </div>
        </div>

        <div class="profile-dates">
          <div>
            <span class="dim">{{ t('profile.joinedAt') }}</span>
            {{ formatTime(user.createdAt) }}
          </div>
          <div>
            <span class="dim">{{ t('profile.lastLogin') }}</span>
            {{ user.lastLoginAt ? formatTime(user.lastLoginAt) : t('profile.never') }}
          </div>
        </div>
      </div>

      <div v-if="stats" class="grid grid-4">
        <div class="stat">
          <div class="stat-label">{{ t('profile.keys') }}</div>
          <div class="stat-value">
            {{ formatNumber(stats.keys.active) }} / {{ formatNumber(stats.keys.total) }}
          </div>
          <div class="stat-hint">{{ t('profile.keysValueHint') }}</div>
        </div>

        <div class="stat">
          <div class="stat-label">{{ t('profile.requests30d') }}</div>
          <div class="stat-value">{{ formatNumber(stats.last30d.requests) }}</div>
          <div class="stat-hint">
            {{ t('profile.errorsCount', { errors: formatNumber(stats.last30d.errors) }) }}
          </div>
        </div>

        <div class="stat">
          <div class="stat-label">{{ t('profile.tokens30d') }}</div>
          <div class="stat-value">{{ formatCompact(stats.last30d.tokens) }}</div>
          <div class="stat-hint">{{ formatNumber(stats.last30d.tokens) }}</div>
        </div>

        <div class="stat">
          <div class="stat-label">{{ t('profile.requestsTotal') }}</div>
          <div class="stat-value">{{ formatNumber(stats.requests) }}</div>
          <div class="stat-hint">
            <template v-if="stats.firstRequestAt">
              {{ t('profile.firstRequest') }} {{ formatTime(stats.firstRequestAt) }}
            </template>
            <template v-else>{{ t('profile.never') }}</template>
          </div>
          <div v-if="stats.lastRequestAt" class="stat-hint">
            {{ t('profile.lastRequest') }} {{ formatTime(stats.lastRequestAt) }}
          </div>
        </div>

        <div class="stat">
          <div class="stat-label">{{ t('profile.tokensTotal') }}</div>
          <div class="stat-value">{{ formatCompact(stats.tokens) }}</div>
          <div class="stat-hint">{{ formatNumber(stats.tokens) }}</div>
        </div>

        <div class="stat">
          <div class="stat-label">{{ t('profile.errorRate') }}</div>
          <div class="stat-value">{{ errorRateText }}</div>
          <div class="stat-hint">
            {{ t('profile.requestsCount', { requests: formatNumber(stats.requests) }) }}
          </div>
        </div>
      </div>

      <!--
        用户范围的用量趋势：数据只统计当前用户名下的 Key（mine=1）。
        卡片内部自带范围选择 / 双视图 / 骨架屏，与概览页互不影响。
      -->
      <UsageTrendCard mine />

      <div v-if="user" class="card">
        <div class="card-title">{{ t('profile.accountInfo') }}</div>
        <div class="table-wrap profile-table-wrap">
          <table class="profile-table">
            <tbody>
              <tr>
                <th scope="row">{{ t('profile.username') }}</th>
                <td class="mono">{{ user.username }}</td>
              </tr>
              <tr>
                <th scope="row">{{ t('profile.displayName') }}</th>
                <td>{{ user.displayName || user.username }}</td>
              </tr>
              <tr>
                <th scope="row">{{ t('profile.role') }}</th>
                <td>
                  <span
                    class="badge"
                    :class="user.role === 'admin' ? 'badge-info' : 'badge-off'"
                  >
                    {{ roleLabel }}
                  </span>
                </td>
              </tr>
              <tr>
                <th scope="row">{{ t('profile.status') }}</th>
                <td>
                  <span
                    class="badge"
                    :class="user.status === 'active' ? 'badge-ok' : 'badge-off'"
                  >
                    {{ statusLabel }}
                  </span>
                </td>
              </tr>
              <tr>
                <th scope="row">{{ t('profile.createdAt') }}</th>
                <td>{{ formatTime(user.createdAt) }}</td>
              </tr>
              <tr>
                <th scope="row">{{ t('profile.lastLogin') }}</th>
                <td>
                  {{ user.lastLoginAt ? formatTime(user.lastLoginAt) : t('profile.never') }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 页头卡：左侧身份、右侧时间；颜色全部走主题变量 */
.profile-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
}

.profile-id {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.profile-avatar {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent);
  color: var(--accent);
  font-size: 24px;
  font-weight: 650;
  line-height: 1;
}

.profile-meta {
  min-width: 0;
}

.profile-name {
  font-size: 18px;
  font-weight: 650;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-handle {
  font-size: 12.5px;
  color: var(--text-faint);
}

.profile-badges {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.profile-dates {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-dim);
  text-align: right;
}

.profile-dates .dim {
  margin-right: 6px;
}

.profile-table-wrap {
  margin-top: 12px;
}

.profile-table {
  min-width: 0;
}

.profile-table th {
  width: 180px;
  font-weight: 560;
}

@media (max-width: 720px) {
  .profile-dates {
    text-align: left;
  }

  .profile-table th {
    width: 120px;
  }
}
</style>
