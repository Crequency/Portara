<script setup lang="ts">
/**
 * 余额用量页（仅管理员）。
 *
 * 上游的余额接口各说各话（金额 / 额度窗口 / 账期累计），
 * 服务端已归一化成统一快照，这里只负责呈现。
 */
import { toastError } from '../error'
import { computed, onMounted, ref } from 'vue'
import { api, type UsageSnapshot, type User } from '../api'
import AccountUsage from '../components/AccountUsage.vue'
import Modal from '../components/Modal.vue'
import PInfo from '../components/PInfo.vue'
import {
  formatCompact,
  formatNumber,
  formatTime,
  quotaColor,
  quotaPercent
} from '../format'
import { useI18n } from '../i18n'
import { toast } from '../toast'

const props = defineProps<{ user?: User }>()

const { t } = useI18n()

const snapshots = ref<UsageSnapshot[]>([])
const loading = ref(true)
const refreshing = ref(false)

const rawOpen = ref(false)
const rawTarget = ref<UsageSnapshot | null>(null)

/** 页内概览：按币种汇总金额余额 + 汇总窗口超限数 */
const summary = computed(() => {
  const byCurrency = new Map<string, number>()
  let okCount = 0
  let failCount = 0
  let exceeded = 0
  let inferred = 0

  for (const s of snapshots.value) {
    if (s.ok) okCount += 1
    else failCount += 1
    for (const b of s.balances) {
      byCurrency.set(b.currency, (byCurrency.get(b.currency) ?? 0) + b.remaining)
    }
    for (const w of s.windows) {
      if (w.exceeded) exceeded += 1
      if (w.inferred) inferred += 1
    }
  }
  return {
    byCurrency: [...byCurrency.entries()],
    okCount,
    failCount,
    exceeded,
    inferred,
    total: snapshots.value.length
  }
})

async function load(force = false): Promise<void> {
  loading.value = true
  try {
    const u = await api.get<{ providers: UsageSnapshot[] }>(
      '/api/usage' + (force ? '?refresh=1' : '')
    )
    snapshots.value = u.providers
  } catch (err) {
    toastError(err, t('usage.error'))
  } finally {
    loading.value = false
  }
}

async function refreshAll(): Promise<void> {
  refreshing.value = true
  try {
    await load(true)
    toast.success(t('usage.refreshAll'))
  } finally {
    refreshing.value = false
  }
}

async function refreshOne(s: UsageSnapshot): Promise<void> {
  try {
    const next = await api.post<UsageSnapshot>('/api/usage/refresh', { channelId: s.channelId })
    const i = snapshots.value.findIndex((x) => x.channelId === s.channelId)
    if (i >= 0) snapshots.value[i] = next
  } catch (err) {
    toastError(err, t('usage.error'))
  }
}

function openRaw(s: UsageSnapshot): void {
  rawTarget.value = s
  rawOpen.value = true
}

/** 窗口进度条的百分比与颜色（颜色逻辑与渠道详情页共用） */
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
  return model ? `${model} · ${label}` : label
}

/**
 * 网关自身的余额 API 地址。
 *
 * 用 `location.origin` —— 那正是**管理员此刻访问网关的地址**，
 * 直接复制就能用（局域网 / 反代域名都自动正确）。
 */
const apiBase = computed(() => `${location.origin}/v1/usage`)
/** 拿一个已配适配器的渠道做「单个渠道」示例 */
const sampleChannelId = computed(() => snapshots.value[0]?.channelId ?? '{渠道 id}')

const curlExample = computed(
  () =>
    `curl -H "Authorization: Bearer <你的网关密钥>" \\\n  ${apiBase.value}`
)

async function copyApi(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('usage.apiCopied'))
  } catch {
    toast.error(t('toast.copyFailed'))
  }
}

function money(v: number, unit: 'currency' | 'credits', currency: string): string {
  const n = v.toLocaleString('en-US', { maximumFractionDigits: 4 })
  return unit === 'credits' ? `${n} ${currency}` : `${n} ${currency}`
}

onMounted(() => void load())
</script>

<template>
  <!--
    加载中：整页骨架，与下面的真实结构一一对应（API 卡 / 汇总卡 / 渠道卡）。
    容器带 role="status"，占位块全部 aria-hidden —— 读屏只念一次「加载中」。
  -->
  <div
    v-if="loading"
    class="stack sk-usage"
    role="status"
    :aria-label="t('common.loading')"
  >
    <!-- 视觉隐藏的状态文本：live region 要有文本才会播报，文本巡检也不会把「加载中」判成空页 -->
    <span class="sk-usage-live">{{ t('common.loading') }}</span>

    <!-- ① 网关自身的余额 API：卡片头 + 两行地址 + 一行按钮 -->
    <div class="card" aria-hidden="true">
      <div class="card-head sk-usage-head">
        <div class="sk-usage-head-main">
          <div class="sk-usage-title"><span class="sk sk-usage-title-bar"></span></div>
          <div class="sk-usage-sub"><span class="sk sk-usage-sub-bar"></span></div>
        </div>
        <span class="sk sk-usage-head-hint"></span>
      </div>
      <div class="form-grid sk-usage-api-rows">
        <div v-for="n in 2" :key="'api' + n" class="sk-usage-api-row">
          <span class="sk sk-usage-api-tag"></span>
          <span class="sk sk-usage-api-label"></span>
          <span class="sk sk-usage-api-code"></span>
          <span class="sk sk-usage-api-copy"></span>
        </div>
        <div class="sk-usage-api-row sk-usage-api-row-foot">
          <span class="sk sk-usage-api-btn"></span>
        </div>
      </div>
    </div>

    <!-- ② 页内概览：卡片头 + 4 个等宽 stat -->
    <div class="card" aria-hidden="true">
      <div class="card-head sk-usage-head">
        <div class="sk-usage-head-main">
          <div class="sk-usage-title"><span class="sk sk-usage-title-bar"></span></div>
          <div class="sk-usage-sub"><span class="sk sk-usage-sub-bar"></span></div>
        </div>
        <span class="sk sk-usage-head-btn"></span>
      </div>
      <div class="grid grid-4">
        <div v-for="n in 4" :key="'sum' + n" class="stat sk-usage-stat">
          <div class="sk-usage-stat-label"><span class="sk sk-usage-stat-label-bar"></span></div>
          <div class="sk-usage-stat-value"><span class="sk sk-usage-stat-value-bar"></span></div>
        </div>
      </div>
    </div>

    <!-- ③ 渠道卡：卡片头 / 余额 / 窗口 / 账户区（固定 2 张） -->
    <div
      v-for="n in 2"
      :key="'ch' + n"
      class="card sk-usage-channel"
      aria-hidden="true"
    >
      <div class="card-head sk-usage-head">
        <div class="sk-usage-head-main">
          <div class="sk-usage-chname">
            <span class="sk sk-usage-name"></span>
            <span class="sk sk-usage-tag"></span>
          </div>
          <div class="sk-usage-sub"><span class="sk sk-usage-sub-bar"></span></div>
        </div>
        <span class="sk sk-usage-head-btn"></span>
      </div>

      <!-- 金额余额 -->
      <div class="grid grid-3 sk-usage-balances">
        <div v-for="b in 2" :key="'bal' + b" class="stat sk-usage-stat">
          <div class="sk-usage-stat-label"><span class="sk sk-usage-stat-label-bar"></span></div>
          <div class="sk-usage-stat-value"><span class="sk sk-usage-stat-value-bar"></span></div>
        </div>
      </div>

      <!-- 额度窗口 -->
      <div class="sk-usage-windows">
        <div class="sk-usage-section-label"><span class="sk sk-usage-section-label-bar"></span></div>
        <div class="form-grid sk-usage-window-list">
          <div v-for="w in 2" :key="'win' + w" class="sk-usage-window">
            <div class="row-between sk-usage-window-head">
              <span class="sk sk-usage-window-label"></span>
              <span class="sk sk-usage-window-value"></span>
            </div>
            <div class="sk sk-usage-window-track"></div>
          </div>
        </div>
      </div>

      <!-- 按账户：两行短条 -->
      <div class="sk-usage-acct">
        <div class="sk-usage-section-label"><span class="sk sk-usage-section-label-bar"></span></div>
        <div class="sk-usage-acct-rows">
          <span v-for="a in 2" :key="'acct' + a" class="sk sk-usage-acct-row"></span>
        </div>
      </div>

      <!-- 查看原始数据 -->
      <div class="sk-usage-foot"><span class="sk sk-usage-foot-btn"></span></div>
    </div>
  </div>

  <div v-else class="stack">
    <!-- 网关自身的余额 API（供程序调用） -->
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">{{ t('usage.apiTitle') }}</div>
          <div class="dim" style="font-size: 12px">{{ t('usage.apiHint') }}</div>
        </div>
        <span class="dim" style="font-size: 11.5px">{{ t('usage.apiAuthHint') }}</span>
      </div>

      <div class="form-grid" style="gap: 8px">
        <div class="row" style="gap: 8px">
          <span class="tag" style="min-width: 74px; justify-content: center">GET</span>
          <span class="dim" style="font-size: 12px; min-width: 72px">{{ t('usage.apiList') }}</span>
          <code class="mono api-url">{{ apiBase }}</code>
          <button
            class="btn btn-sm btn-icon api-copy"
            :title="t('usage.copyUrl')"
            @click="copyApi(apiBase)"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
              stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="5.5" y="5.5" width="8" height="9" rx="1.5" />
              <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v7A1.5 1.5 0 0 0 4 12.5h1.5" />
            </svg>
          </button>
        </div>

        <div class="row" style="gap: 8px">
          <span class="tag" style="min-width: 74px; justify-content: center">GET</span>
          <span class="dim" style="font-size: 12px; min-width: 72px">{{ t('usage.apiSingle') }}</span>
          <code class="mono api-url">{{ apiBase }}/{{ sampleChannelId }}</code>
          <button
            class="btn btn-sm btn-icon api-copy"
            :title="t('usage.copyUrl')"
            @click="copyApi(`${apiBase}/${sampleChannelId}`)"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
              stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="5.5" y="5.5" width="8" height="9" rx="1.5" />
              <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v7A1.5 1.5 0 0 0 4 12.5h1.5" />
            </svg>
          </button>
        </div>

        <div class="row">
          <button class="btn btn-ghost btn-sm" @click="copyApi(curlExample)">
            {{ t('usage.copyCurl') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 页内概览 -->
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">{{ t('usage.title') }}</div>
          <div class="dim" style="font-size: 12px">{{ t('usage.sub') }}</div>
        </div>
        <div class="row">
          <button class="btn btn-sm" :disabled="refreshing" @click="refreshAll">
            {{ refreshing ? t('usage.refreshing') : t('usage.refreshAll') }}
          </button>
        </div>
      </div>

      <div class="grid grid-4">
        <div class="stat">
          <div class="stat-label">{{ t('usage.adapters') }}</div>
          <div class="stat-value">{{ summary.total }}</div>
          <div class="stat-hint">
            {{ summary.okCount }} ok · {{ summary.failCount }} {{ t('usage.error') }}
          </div>
        </div>
        <div
          v-for="[currency, amount] in summary.byCurrency"
          :key="currency"
          class="stat"
        >
          <div class="stat-label">{{ t('usage.remaining') }} · {{ currency }}</div>
          <div class="stat-value">{{ amount.toLocaleString('en-US', { maximumFractionDigits: 4 }) }}</div>
        </div>
        <div v-if="summary.exceeded > 0" class="stat">
          <div class="stat-label">{{ t('usage.exceeded') }}</div>
          <div class="stat-value delta-slow">{{ summary.exceeded }}</div>
        </div>
      </div>
    </div>

    <!-- 未配置任何适配器 -->
    <div v-if="snapshots.length === 0" class="card">
      <div class="empty">{{ t('usage.notConfigured') }}</div>
      <div class="dim" style="text-align: center; font-size: 12px">
        {{ t('usage.notConfiguredHint') }}
      </div>
    </div>

    <!-- 每个渠道一张卡 -->
    <div v-for="s in snapshots" :key="s.channelId" class="card">
      <div class="card-head">
        <div>
          <div class="card-title row" style="gap: 8px">
            {{ s.channelName }}
            <span class="tag">{{ s.adapter }}</span>
            <span v-if="s.cached" class="badge badge-off">{{ t('usage.cached') }}</span>
          </div>
          <div class="dim" style="font-size: 11.5px">
            {{ t('usage.fetchedAt') }} {{ formatTime(s.fetchedAt) }}
          </div>
        </div>
        <button class="btn btn-sm" @click="refreshOne(s)">{{ t('common.refresh') }}</button>
      </div>

      <!-- 失败 -->
      <div v-if="!s.ok" class="alert">
        <b>{{ t('usage.error') }}：</b>{{ s.error }}
        <div v-if="s.adapter" class="dim" style="font-size: 12px; margin-top: 4px">
          <button class="btn btn-ghost btn-sm" @click="openRaw(s)">{{ t('usage.viewRaw') }}</button>
        </div>
      </div>

      <template v-else>
        <div v-if="s.stale" class="alert">{{ t('usage.stale') }}</div>

        <!-- 金额余额 -->
        <div v-if="s.balances.length > 0" class="grid grid-3" style="margin-bottom: 14px">
          <div v-for="b in s.balances" :key="b.currency" class="stat">
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
        <div v-if="s.windows.length > 0" style="margin-bottom: 14px">
          <div class="dim" style="font-size: 12px; margin-bottom: 8px">{{ t('usage.windows') }}</div>
          <div class="form-grid" style="gap: 10px">
            <div v-for="w in s.windows" :key="w.key">
              <div class="row-between" style="font-size: 12.5px">
                <span class="row" style="gap: 5px">
                  {{ windowLabel(w.key) }}
                  <PInfo v-if="w.inferred" :text="t('usage.inferredHint')" />
                  <span v-if="w.inferred" class="tag" style="color: var(--warn)">
                    {{ t('usage.inferred') }}
                  </span>
                </span>
                <span class="nowrap" :class="{ 'delta-slow': w.exceeded }">
                  {{ t('usage.used') }} {{ formatNumber(Math.round(w.used)) }} /
                  {{ formatNumber(Math.round(w.total)) }}
                  <span :style="{ color: quotaColor(windowPercent(w), w.exceeded) }">
                    ({{ windowPercent(w) }}%)
                  </span>
                  <span v-if="w.exceeded">· {{ t('usage.exceeded') }}</span>
                  <span v-if="w.resetAt" class="dim">· {{ t('usage.resetAt') }} {{ formatTime(w.resetAt) }}</span>
                </span>
              </div>
              <div style="height: 5px; background: var(--bg-elev-2); border-radius: 3px; margin-top: 5px">
                <div
                  :style="{
                    width: windowPercent(w) + '%',
                    height: '100%',
                    background: quotaColor(windowPercent(w), w.exceeded),
                    borderRadius: '3px'
                  }"
                />
              </div>
            </div>
          </div>
        </div>

        <!--
          按账户：渠道有多把 Key 时，各自的钱包与限额是分开的。
          聚合值在上，逐账户在下 —— 两处用同一个组件渲染，不会出现"两处数字不一致"的疑心。
        -->
        <div v-if="s.accounts.length > 1" class="usage-acct-section">
          <div class="dim" style="font-size: 12px; margin-bottom: 10px">
            {{ t('usage.byAccount') }}
          </div>
          <div class="acct-card-grid">
            <div v-for="a in s.accounts" :key="a.accountId" class="acct-card">
              <AccountUsage :account="a" show-name />
            </div>
          </div>
        </div>

        <!-- 账期累计 -->
        <div v-if="s.period" class="grid grid-4">
          <div class="stat">
            <div class="stat-label">{{ t('usage.requests') }}</div>
            <div class="stat-value">{{ formatNumber(s.period.requests) }}</div>
            <div class="stat-hint">
              {{ t('usage.successRate') }}
              {{ s.period.successRate === undefined ? '—' : s.period.successRate.toFixed(2) + '%' }}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">{{ t('usage.tokens') }}</div>
            <div class="stat-value">
              {{ formatCompact(s.period.tokensIn) }} / {{ formatCompact(s.period.tokensOut) }}
            </div>
            <div class="stat-hint">in / out</div>
          </div>
          <div class="stat">
            <div class="stat-label">{{ t('usage.cost') }}</div>
            <div class="stat-value">{{ formatNumber(s.period.cost) }}</div>
            <div class="stat-hint">{{ s.period.costCurrency ?? '' }}</div>
          </div>
          <div v-if="s.plan" class="stat">
            <div class="stat-label">{{ t('usage.plan') }}</div>
            <div class="stat-value row" style="gap: 5px; font-size: 15px">
              {{ s.plan.id }}
              <PInfo v-if="s.plan.inferred" :text="t('usage.inferredHint')" />
            </div>
            <div class="stat-hint">
              {{ s.plan.status }} · {{ t('usage.renewAt') }} {{ formatTime(s.plan.renewAt ?? null) }}
            </div>
          </div>
        </div>

        <div v-if="s.warnings.length > 0" style="margin-top: 12px">
          <div v-for="(w, i) in s.warnings" :key="i" class="dim" style="font-size: 12px">
            · {{ w }}
          </div>
        </div>

        <div style="margin-top: 10px">
          <button class="btn btn-ghost btn-sm" @click="openRaw(s)">{{ t('usage.viewRaw') }}</button>
        </div>
      </template>
    </div>
  </div>

  <Modal v-if="rawOpen && rawTarget" :title="t('usage.rawTitle')" wide @close="rawOpen = false">
    <div class="dim" style="font-size: 12px; margin-bottom: 8px">
      {{ rawTarget.channelName }} · {{ rawTarget.adapter }}
    </div>
    <pre class="code-box" style="max-height: 420px; overflow: auto; white-space: pre-wrap">{{
      JSON.stringify(rawTarget.raw ?? {}, null, 2)
    }}</pre>
    <div class="modal-foot">
      <button class="btn" @click="rawOpen = false">{{ t('common.close') }}</button>
    </div>
  </Modal>
</template>

<style scoped>
.delta-slow {
  color: var(--danger);
}
</style>
