<script setup lang="ts">
/**
 * 上游账户详情：最近会话缩略 + 用量消耗。
 *
 * 数据两条来源：
 *   - GET /api/channels/:id/accounts/:aid/activity —— 最近请求、近 24h/7d 汇总、近 7 天日消耗
 *   - GET /api/channels/:id/usage —— 该账户当前的余额与额度窗口（复用 AccountUsage）
 *
 * 为什么拆成独立组件：渠道详情页的账户行已经很挤，弹窗内部又要排版好几块，
 * 塞进页面会让那个文件继续膨胀。
 */
import { computed, onMounted, ref } from 'vue'
import { api, type AccountActivity, type ChannelAccount, type UsageAccountSnapshot } from '../api'
import { errorText } from '../error'
import { formatCompact, formatLatency, formatNumber, formatTime } from '../format'
import { useI18n } from '../i18n'
import AccountUsage from './AccountUsage.vue'

const props = defineProps<{
  channelId: string
  account: ChannelAccount
}>()

const { t } = useI18n()

const activity = ref<AccountActivity | null>(null)
const usageAccount = ref<UsageAccountSnapshot | null>(null)
const usageUnavailable = ref(false)
const loading = ref(true)
const error = ref('')

/** 近 7 天里最大的 token 值，用来把条形画成相对长度 */
const dailyPeak = computed(() => {
  const peaks = (activity.value?.daily ?? []).map((d) => d.tokens)
  return peaks.length ? Math.max(...peaks, 1) : 1
})

onMounted(async () => {
  try {
    const activityUrl =
      '/api/channels/' + props.channelId + '/accounts/' + props.account.id + '/activity?limit=10'
    const usageUrl = '/api/channels/' + props.channelId + '/usage'
    const [act, usage] = await Promise.allSettled([
      api.get<AccountActivity>(activityUrl),
      api.get<{ accounts: UsageAccountSnapshot[] }>(usageUrl)
    ])
    if (act.status === 'fulfilled') activity.value = act.value
    else error.value = errorText(act.reason, t('common.loading'))

    if (usage.status === 'fulfilled') {
      const found = usage.value.accounts.find((a) => a.accountId === props.account.id)
      usageAccount.value = found ?? null
      usageUnavailable.value = found === undefined
    } else {
      usageUnavailable.value = true
    }
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div v-if="loading" class="dim" style="font-size: 12.5px">{{ t('common.loading') }}</div>
  <div v-else-if="error" class="alert">{{ error }}</div>
  <template v-else-if="activity">
    <!-- 账户基础状态 -->
    <div class="row" style="gap: 8px; flex-wrap: wrap; margin-bottom: 14px">
      <span class="tag">{{ account.name }}</span>
      <span class="badge" :class="account.status === 'active' ? 'badge-ok' : 'badge-off'">
        {{ account.status === 'active' ? t('common.enabled') : t('common.disabled') }}
      </span>
      <span class="dim" style="font-size: 12px">
        {{ t('channels.accountPriority', { p: account.priority, w: account.weight }) }}
      </span>
      <span class="dim" style="font-size: 12px">
        {{ t('channels.lastUsed') }}
        {{ account.lastUsedAt ? formatTime(account.lastUsedAt) : t('channels.never') }}
      </span>
      <span v-if="activity.account.consecutiveFailures > 0" class="badge badge-warn">
        {{ t('channels.consecutiveFailures') }} {{ activity.account.consecutiveFailures }}
      </span>
    </div>

    <!-- 近 24h / 近 7 天 -->
    <div class="grid grid-2" style="gap: 12px; margin-bottom: 16px">
      <div class="acct-metric">
        <div class="dim" style="font-size: 11.5px">{{ t('channels.last24h') }}</div>
        <div class="mono" style="font-size: 15px; font-weight: 600">
          {{ formatCompact(activity.h24.tokens) }}
          <span class="dim" style="font-weight: 400; font-size: 12px">tok</span>
        </div>
        <div class="dim" style="font-size: 11.5px">
          {{ formatNumber(activity.h24.requests) }} {{ t('usage.requests') }}
          <span v-if="activity.h24.errors > 0" style="color: var(--danger)">
            · {{ formatNumber(activity.h24.errors) }} {{ t('channels.errorsLabel') }}
          </span>
        </div>
      </div>
      <div class="acct-metric">
        <div class="dim" style="font-size: 11.5px">{{ t('channels.last7d') }}</div>
        <div class="mono" style="font-size: 15px; font-weight: 600">
          {{ formatCompact(activity.d7.tokens) }}
          <span class="dim" style="font-weight: 400; font-size: 12px">tok</span>
        </div>
        <div class="dim" style="font-size: 11.5px">
          {{ formatNumber(activity.d7.requests) }} {{ t('usage.requests') }}
          <span v-if="activity.d7.errors > 0" style="color: var(--danger)">
            · {{ formatNumber(activity.d7.errors) }} {{ t('channels.errorsLabel') }}
          </span>
        </div>
      </div>
    </div>

    <!-- 近 7 天日消耗 -->
    <div class="dim" style="font-size: 12px; margin-bottom: 8px">{{ t('channels.dailyUsage') }}</div>
    <div class="acct-daily" style="margin-bottom: 16px">
      <div
        v-for="d in activity.daily"
        :key="d.date"
        class="acct-daily-col"
        :title="d.date + ' · ' + formatCompact(d.tokens) + ' tok · ' + d.requests + ' req'"
      >
        <div class="acct-daily-track">
          <div
            class="acct-daily-fill"
            :class="{ 'is-error': d.errors > 0 }"
            :style="{ height: Math.max(2, Math.round((d.tokens / dailyPeak) * 100)) + '%' }"
          />
        </div>
        <div class="acct-daily-date">{{ d.date.slice(5) }}</div>
      </div>
    </div>

    <!-- 最近会话 -->
    <div class="row" style="gap: 8px; margin-bottom: 8px; flex-wrap: wrap">
      <div class="dim" style="font-size: 12px">{{ t('channels.recentSessions') }}</div>
      <span class="dim" style="font-size: 11px">{{ t('channels.recentSessionsHint') }}</span>
    </div>
    <div v-if="activity.recent.length === 0" class="dim" style="font-size: 12px; margin-bottom: 16px">
      {{ t('channels.recentSessionsEmpty') }}
    </div>
    <div v-else class="acct-recent" style="margin-bottom: 16px">
      <div
        v-for="r in activity.recent"
        :key="r.id"
        class="acct-recent-row"
        :class="{ 'is-error': r.statusCode >= 400 }"
      >
        <span class="nowrap" style="font-size: 11.5px">{{ formatTime(r.ts) }}</span>
        <span class="mono acct-recent-model" style="font-size: 11.5px">{{ r.model || '—' }}</span>
        <span class="nowrap mono" style="font-size: 11.5px">
          {{ formatCompact(r.totalTokens) }} tok
        </span>
        <span class="nowrap" :class="r.statusCode >= 400 ? 'acct-recent-err' : 'dim'">
          {{ r.statusCode }}
        </span>
        <span class="nowrap dim" style="font-size: 11px">{{ formatLatency(r.latencyMs) }}</span>
        <span class="dim nowrap" style="font-size: 11px">
          {{ r.sessionHash || t('channels.noSession') }}
        </span>
        <span class="dim nowrap acct-recent-key" style="font-size: 11px">{{ r.apiKeyName }}</span>
      </div>
    </div>

    <!-- 当前余额与额度 -->
    <div class="dim" style="font-size: 12px; margin-bottom: 8px">{{ t('channels.currentUsage') }}</div>
    <div v-if="usageAccount" class="acct-usage">
      <AccountUsage :account="usageAccount" />
    </div>
    <div v-else-if="usageUnavailable" class="dim" style="font-size: 12px">
      {{ t('channels.usageUnavailable') }}
    </div>
  </template>
</template>
