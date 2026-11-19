<script setup lang="ts">
/**
 * 单个渠道的用量卡片（余额 / 额度窗口 / 逐账户 / 账期累计）。
 *
 * 从余额用量页抽出来的原因：概览页也要展示同一份内容（点渠道标题弹窗）。
 * 两处共用一套渲染，避免数字口径或排版各写一份后慢慢漂移。
 *
 * 只负责渲染与事件：取数（各自页面逐卡 /api/channels/:id/usage）仍留在调用方，
 * 因为两边的并发与骨架策略不同。
 */
import { useI18n } from '../i18n'
import { formatCompact, formatNumber, formatTime, quotaColor, quotaPercent, remainingPercent } from '../format'
import type { UsageSnapshot } from '../api'
import AccountUsage from './AccountUsage.vue'
import PInfo from './PInfo.vue'
import UsageWindowRow from './UsageWindowRow.vue'

/** 一张卡需要的数据（与两处页面的逐渠道取数结果一致） */
export interface ChannelUsageItem {
  channelId: string
  channelName: string
  adapter: string
  /** 已取到的快照；null = 还没回来 */
  snapshot: UsageSnapshot | null
  /** 该卡片是否正在取数（首次加载 / 单卡刷新） */
  loading: boolean
  /** 请求本身失败（网络/权限）；上游失败在 snapshot.ok=false 里 */
  error: string
}

defineProps<{ item: ChannelUsageItem }>()

const emit = defineEmits<{
  /** 请求方刷新这张卡 */
  (e: 'refresh'): void
  /** 查看原始响应 */
  (e: 'raw', snapshot: UsageSnapshot): void
}>()

const { t } = useI18n()

/** 窗口百分比：与区间统计同一口径 */
function windowPercent(w: { used: number; total: number }): number {
  return quotaPercent(w.used, w.total)
}

/** 窗口名称本地化：形如 `MiniMax-M*:interval` 要拆出模型名 */
function windowLabel(key: string): string {
  const base = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
  const model = key.includes(':') ? key.slice(0, key.indexOf(':')) : ''
  const map: Record<string, string> = {
    fiveHour: t('usage.windowFiveHour'),
    weekly: t('usage.windowWeekly'),
    monthly: t('usage.windowMonthly'),
    interval: t('usage.windowInterval')
  }
  const label = map[base] ?? base
  return model ? model + ' · ' + label : label
}

/**
 * 金额展示：credits 与 currency 目前都直接带单位后缀。
 * 刻意不用模板字符串拼接 —— 两分支完全一样，加法已经足够。
 */
function money(v: number, unit: 'currency' | 'credits', currency: string): string {
  void unit
  const n = v.toLocaleString('en-US', { maximumFractionDigits: 4 })
  return n + ' ' + currency
}
</script>

<template>
  <div class="card">
    <div class="card-head">
      <div>
        <div class="card-title row" style="gap: 8px">
          {{ item.channelName }}
          <span class="tag">{{ item.snapshot?.adapter || item.adapter }}</span>
          <span v-if="item.snapshot?.cached" class="badge badge-off">{{ t('usage.cached') }}</span>
        </div>
        <div class="dim" style="font-size: 11.5px">
          <template v-if="item.snapshot">
            {{ t('usage.fetchedAt') }} {{ formatTime(item.snapshot.fetchedAt) }}
          </template>
          <template v-else>{{ t('common.loading') }}</template>
        </div>
      </div>
      <div class="row" style="gap: 8px">
        <!-- 原始响应放刷新左边：先看数据、再决定要不要刷 -->
        <button
          v-if="item.snapshot"
          class="btn btn-ghost btn-sm"
          @click="emit('raw', item.snapshot!)"
        >
          {{ t('usage.viewRaw') }}
        </button>
        <button class="btn btn-sm" :disabled="item.loading" @click="emit('refresh')">
          {{ item.loading ? t('common.loading') : t('common.refresh') }}
        </button>
      </div>
    </div>

    <!-- 该卡自己的骨架：数据回来就换成真内容，不等别的卡 -->
    <div v-if="item.loading && !item.snapshot" aria-hidden="true">
      <div class="grid grid-3" style="margin-bottom: 14px">
        <div v-for="b in 2" :key="'bal' + b" class="stat">
          <div class="stat-label"><span class="sk sk-stat-line" /></div>
          <div class="stat-value"><span class="sk sk-stat-value" /></div>
        </div>
      </div>
      <div class="form-grid" style="gap: 10px">
        <div v-for="w in 2" :key="'win' + w">
          <div class="row-between">
            <span class="sk sk-stat-line" style="width: 80px" />
            <span class="sk sk-stat-line" style="width: 120px" />
          </div>
          <div class="sk sk-window-track" style="margin-top: 6px" />
        </div>
      </div>
    </div>

    <!-- 请求本身失败（网络/权限） -->
    <div v-else-if="item.error" class="alert">{{ item.error }}</div>

    <!-- 上游取数失败（快照本身 ok=false） -->
    <div v-else-if="item.snapshot && !item.snapshot.ok" class="alert">
      <b>{{ t('usage.error') }}：</b>{{ item.snapshot.error }}
      <div v-if="item.snapshot.adapter" class="dim" style="font-size: 12px; margin-top: 4px">
        <button class="btn btn-ghost btn-sm" @click="emit('raw', item.snapshot!)">
          {{ t('usage.viewRaw') }}
        </button>
      </div>
    </div>

    <template v-else>
      <div v-if="item.snapshot!.stale" class="alert">{{ t('usage.stale') }}</div>

      <!--
        余额与额度窗口**并排**：余额在左、窗口在右。
        以前窗口另起一段铺满整行，余额右侧空出 3/4 屏宽，卡还被拉得很高。
        只有窗口没有余额的渠道（例如按额度计费的订阅型）仍让窗口占满整行 ——
        is-stacked 类会把它变成单列。
      -->
      <div
        class="usage-head-grid"
        :class="{ 'is-stacked': item.snapshot!.balances.length === 0 }"
      >
        <!-- 金额余额 -->
        <div v-if="item.snapshot!.balances.length > 0" class="usage-head-balance">
          <div v-for="b in item.snapshot!.balances" :key="b.currency" class="stat">
            <div class="stat-label">{{ t('usage.balance') }} · {{ b.currency }}</div>
            <div class="stat-value">{{ money(b.remaining, b.unit, b.currency) }}</div>
            <div class="stat-hint">
              <template v-if="b.granted !== undefined">
                {{ t('usage.granted') }} {{ formatNumber(b.granted) }}
              </template>
              <template v-if="b.toppedUp !== undefined">
                · {{ t('usage.toppedUp') }} {{ formatNumber(b.toppedUp) }}
              </template>
            </div>
          </div>
        </div>

        <!-- 额度窗口 -->
        <div v-if="item.snapshot!.windows.length > 0" class="usage-head-windows">
        <div class="dim" style="font-size: 12px; margin-bottom: 8px">{{ t('usage.windows') }}</div>
        <div class="form-grid" style="gap: 10px">
          <UsageWindowRow
            v-for="w in item.snapshot!.windows"
            :key="w.key"
            :usage-text="
              t('usage.used') + ' ' + formatNumber(Math.round(w.used)) + ' / ' +
              formatNumber(Math.round(w.total)) + ' (' + windowPercent(w) + '%)' +
              (w.exceeded ? ' · ' + t('usage.exceeded') : '')
            "
            :usage-color="quotaColor(windowPercent(w), w.exceeded)"
            :exceeded="w.exceeded"
            :percent="windowPercent(w)"
            :remaining-text="t('usage.remainingPct', { p: remainingPercent(w.used, w.total) })"
            :bar-color="quotaColor(windowPercent(w), w.exceeded)"
            :start-text="w.startAt ? t('usage.startAt') + ' ' + formatTime(w.startAt) : undefined"
            :reset-text="w.resetAt ? t('usage.resetAt') + ' ' + formatTime(w.resetAt) : undefined"
          >
            <template #label>
              <span class="row" style="gap: 5px; font-size: 12.5px">
                {{ windowLabel(w.key) }}
                <PInfo v-if="w.inferred" :text="t('usage.inferredHint')" />
                <span v-if="w.inferred" class="tag" style="color: var(--warn)">
                  {{ t('usage.inferred') }}
                </span>
              </span>
            </template>
          </UsageWindowRow>
        </div>
        </div>
      </div>

      <!--
        按账户：渠道有多把 Key 时，各自的钱包与限额是分开的。
        聚合值在上，逐账户在下 —— 两处用同一个组件渲染，不会出现"两处数字不一致"的疑心。
      -->
      <div v-if="item.snapshot!.accounts.length > 1" class="usage-acct-section">
        <div class="dim" style="font-size: 12px; margin-bottom: 10px">
          {{ t('usage.byAccount') }}
        </div>
        <div class="acct-card-grid">
          <div v-for="a in item.snapshot!.accounts" :key="a.accountId" class="acct-card">
            <AccountUsage :account="a" show-name />
          </div>
        </div>
      </div>

      <!-- 账期累计 -->
      <div v-if="item.snapshot!.period" class="grid grid-4">
        <div class="stat">
          <div class="stat-label">{{ t('usage.requests') }}</div>
          <div class="stat-value">{{ formatNumber(item.snapshot!.period.requests) }}</div>
          <div class="stat-hint">
            {{ t('usage.successRate') }}
            {{ item.snapshot!.period.successRate === undefined ? '—' : item.snapshot!.period.successRate.toFixed(2) + '%' }}
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">{{ t('usage.tokens') }}</div>
          <div class="stat-value">
            {{ formatCompact(item.snapshot!.period.tokensIn) }} / {{ formatCompact(item.snapshot!.period.tokensOut) }}
          </div>
          <div class="stat-hint">in / out</div>
        </div>
        <div class="stat">
          <div class="stat-label">{{ t('usage.cost') }}</div>
          <div class="stat-value">{{ formatNumber(item.snapshot!.period.cost) }}</div>
          <div class="stat-hint">{{ item.snapshot!.period.costCurrency ?? '' }}</div>
        </div>
        <div v-if="item.snapshot!.plan" class="stat">
          <div class="stat-label">{{ t('usage.plan') }}</div>
          <div class="stat-value row" style="gap: 5px; font-size: 15px">
            {{ item.snapshot!.plan!.id }}
            <PInfo v-if="item.snapshot!.plan!.inferred" :text="t('usage.inferredHint')" />
          </div>
          <div class="stat-hint">
            {{ item.snapshot!.plan!.status }} · {{ t('usage.renewAt') }} {{ formatTime(item.snapshot!.plan!.renewAt ?? null) }}
          </div>
        </div>
      </div>

      <div v-if="item.snapshot!.warnings.length > 0" style="margin-top: 12px">
        <div v-for="(w, i) in item.snapshot!.warnings" :key="i" class="dim" style="font-size: 12px">
          · {{ w }}
        </div>
      </div>

    </template>
  </div>
</template>
