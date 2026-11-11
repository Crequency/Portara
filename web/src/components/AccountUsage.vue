<script setup lang="ts">
/**
 * 单个上游账户的余额与用量限额。
 *
 * 抽成组件是因为它要出现在两处（渠道详情页、余额用量页）——
 * 同一个账户的数值在两处长得不一样，是很容易让人怀疑"哪边是准的"的那类问题。
 */
import type { UsageAccountSnapshot } from '../api'
import { formatNumber, formatTime, quotaColor, quotaPercent } from '../format'
import { useI18n } from '../i18n'
import PInfo from './PInfo.vue'
import UsageWindowRow from './UsageWindowRow.vue'

defineProps<{
  account: UsageAccountSnapshot
  /** 是否显示账户名（余额页按渠道分组时显示，详情页每行也要显示） */
  showName?: boolean
}>()

const { t } = useI18n()

/** 窗口名本地化；MiniMax 的键形如 `MiniMax-M*:interval`，模型名作为前缀 */
function windowLabel(key: string): string {
  const cut = key.indexOf(':')
  const model = cut >= 0 ? key.slice(0, cut) : ''
  const base = cut >= 0 ? key.slice(cut + 1) : key
  const map: Record<string, string> = {
    fiveHour: t('usage.windowFiveHour'),
    weekly: t('usage.windowWeekly'),
    monthly: t('usage.windowMonthly'),
    interval: t('usage.windowInterval')
  }
  const label = map[base] ?? base
  return model ? `${model} · ${label}` : label
}
</script>

<template>
  <div class="acct-usage">
    <div class="acct-usage-head">
      <span v-if="showName" class="acct-usage-name">{{ account.accountName }}</span>
      <span class="tag">{{ account.adapter }}</span>
      <span v-if="!account.ok" class="badge badge-err">
        {{ account.error }}
      </span>
    </div>

    <template v-if="account.ok">
      <div v-if="account.balances.length > 0" class="acct-usage-balances">
        <span v-for="b in account.balances" :key="b.currency" class="acct-usage-balance">
          <span class="mono">
            {{ b.remaining.toLocaleString('en-US', { maximumFractionDigits: 4 }) }}
          </span>
          <span class="dim">{{ b.currency }}</span>
        </span>
      </div>

      <div v-if="account.windows.length > 0" class="acct-usage-windows">
        <div v-for="w in account.windows" :key="w.key">
          <!--
            窗口行分三层：标签 + 用量 / 进度条 / 时间信息。
            以前「用量 + 开始 + 重置」挤在同一行且 nowrap —— 账户一多，
            每张卡变窄，右侧文字直接顶出卡片被裁切。
          -->
          <UsageWindowRow
            :usage-text="formatNumber(Math.round(w.used)) + ' / ' + formatNumber(Math.round(w.total)) + ' (' + quotaPercent(w.used, w.total) + '%)'"
            :usage-color="quotaColor(quotaPercent(w.used, w.total), w.exceeded)"
            :exceeded="w.exceeded"
            :percent="quotaPercent(w.used, w.total)"
            :bar-color="quotaColor(quotaPercent(w.used, w.total), w.exceeded)"
            :start-text="w.startAt ? t('usage.startAt') + ' ' + formatTime(w.startAt) : undefined"
            :reset-text="w.resetAt ? t('usage.resetAt') + ' ' + formatTime(w.resetAt) : undefined"
          >
            <template #label>
              {{ windowLabel(w.key) }}
              <PInfo v-if="w.inferred" :text="t('usage.inferredHint')" />
            </template>
          </UsageWindowRow>
        </div>
      </div>
    </template>
  </div>
</template>
