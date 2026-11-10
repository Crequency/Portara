<script lang="ts">
/**
 * 失败渠道折叠区的展开状态。
 *
 * **必须放在普通 <script> 里**：`<script setup>` 的顶层变量属于每个组件实例，
 * 组件卸载（切走页面）就丢了。放模块作用域才能做到"这次会话里展开过一次就记住"。
 * 不写 localStorage —— 下次打开面板重新折叠，避免错误被永久藏起来。
 */
let usageFailedExpanded = false
</script>

<script setup lang="ts">
/**
 * 余额用量页（仅管理员）。
 *
 * 上游的余额接口各说各话（金额 / 额度窗口 / 账期累计），
 * 服务端已归一化成统一快照，这里只负责呈现。
 */
import { errorText, toastError } from '../error'
import { computed, onMounted, ref, watch } from 'vue'
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

/**
 * 逐项状态。
 *
 * 为什么不再是一个 `loading` 布尔：每个渠道的余额要去打各自的上游，
 * 快的几毫秒、慢的可能几十秒（会话型还要解密重放）。整页骨架会让用户
 * 为一个最慢的渠道等全部 —— 所以改成"每张卡各自加载"，谁先回来谁先显示。
 */
interface UsageItem {
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

const items = ref<UsageItem[]>([])
/** 渠道清单还没回来（这一步只读本地表，很快） */
const listLoading = ref(true)
const refreshing = ref(false)

/** 已取到数据的快照（概览汇总只用这些） */
const snapshots = computed(() =>
  items.value.map((i) => i.snapshot).filter((s): s is UsageSnapshot => s !== null)
)
/**
 * 概览汇总是否还在等数据。
 *
 * 只要已经有一个渠道回来了就先显示它 —— 概览是"当前能看到的总量"，
 * 随着其它渠道陆续回来会自然变大，不会闪"0"再跳。
 */
const summaryPending = computed(
  () => snapshots.value.length === 0 && items.value.some((i) => i.loading)
)

const rawOpen = ref(false)
const rawTarget = ref<UsageSnapshot | null>(null)

/**
 * 「余额 API」说明卡的展开态。
 *
 * 默认折叠：这是给程序调用者看的接口说明，日常查余额时不需要它占首屏；
 * 但它必须易发现 —— 标题与「展开」都在第一屏顶部。
 */
const apiExpanded = ref(false)

/**
 * 「整卡失败」= 这个渠道的所有账户都没取到数。
 *
 * 判据：请求本身抛错，或快照明确 ok=false。
 * **部分账户失败**（part && ok）不算 —— 卡上还有真实数据，留在主区域并照旧显示 warnings。
 */
function isFailed(item: UsageItem): boolean {
  if (item.error) return true
  return item.snapshot !== null && !item.snapshot.ok
}

/** 主区域：正常渠道 + 还在加载的骨架卡 */
const doneItems = computed(() => items.value.filter((i) => !isFailed(i)))
/** 折叠区：整卡失败的渠道 */
const failedItems = computed(() => items.value.filter((i) => isFailed(i)))

/**
 * 「只看余额」的渠道：有金额、没有额度窗口，也没有账期 / 套餐数据。
 *
 * 这类卡每张只有一个数字（DeepSeek / Kimi 这种充值型），一卡一张会把页面拉得很长，
 * 信息密度极低 —— 合并成一张卡里的多行更好读（与概览页同一套规则）。
 * 判定必须同时排除 windows / period / plan，否则会把有真实额度信息的渠道误归进来。
 */
function isBalanceOnly(item: UsageItem): boolean {
  const s = item.snapshot
  if (!s || !s.ok) return false
  return s.balances.length > 0 && s.windows.length === 0 && !s.period && !s.plan
}

/** 逐卡渲染的渠道（有额度窗口 / 账期 / 套餐，或还在加载） */
const cardItems = computed(() => doneItems.value.filter((i) => !isBalanceOnly(i)))
/** 合并成一张卡的纯余额渠道 */
const balanceOnlyItems = computed(() => doneItems.value.filter((i) => isBalanceOnly(i)))

/**
 * 折叠区是否展开。
 *
 * 放在模块作用域而不是组件 ref：用户在余额页展开看错误、
 * 切去别的页面再回来，不该被重置成折叠（"我刚才明明展开了"的困惑）。
 * 但也不写 localStorage —— 下次打开面板重新折叠，避免错误被永久藏起来。
 */
const failedExpanded = ref(usageFailedExpanded)
watch(failedExpanded, (v) => {
  usageFailedExpanded = v
})

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

/** 取单个渠道的用量；force=1 跳过缓存 */
async function loadItem(item: UsageItem, force = false): Promise<void> {
  item.loading = true
  item.error = ''
  try {
    item.snapshot = await api.get<UsageSnapshot>(
      `/api/channels/${item.channelId}/usage` + (force ? '?refresh=1' : '')
    )
  } catch (err) {
    item.error = errorText(err, t('usage.error'))
  } finally {
    item.loading = false
  }
}

/**
 * 首屏：先取渠道清单（只读本地表，毫秒级）把卡片壳子铺出来，
 * 再**并行**去取每个渠道的数据 —— 谁先回来谁先渲染。
 */
async function load(force = false): Promise<void> {
  listLoading.value = true
  try {
    const res = await api.get<{
      channels: Array<{ channelId: string; channelName: string; adapter: string }>
    }>('/api/usage/channels')
    items.value = res.channels.map((c) => ({
      ...c,
      snapshot: null,
      loading: true,
      error: ''
    }))
  } catch (err) {
    toastError(err, t('usage.error'))
    items.value = []
  } finally {
    listLoading.value = false
  }
  // 不 await：让每张卡独立完成、独立渲染
  await Promise.all(items.value.map((i) => loadItem(i, force)))
}

async function refreshAll(): Promise<void> {
  refreshing.value = true
  try {
    await Promise.all(items.value.map((i) => loadItem(i, true)))
    toast.success(t('usage.refreshAll'))
  } finally {
    refreshing.value = false
  }
}

async function refreshOne(item: UsageItem): Promise<void> {
  try {
    item.loading = true
    item.snapshot = await api.post<UsageSnapshot>('/api/usage/refresh', {
      channelId: item.channelId
    })
    item.error = ''
  } catch (err) {
    item.error = errorText(err, t('usage.error'))
  } finally {
    item.loading = false
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
const sampleChannelId = computed(() => items.value[0]?.channelId ?? '{渠道 id}')

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
  <div class="stack">
    <!--
      网关自身的余额 API（供程序调用）。
      默认折叠：这是「给程序用」的说明，日常看余额时并不需要它占据首屏。
    -->
    <div class="card usage-api">
      <button
        class="usage-api-head"
        type="button"
        :aria-expanded="apiExpanded"
        @click="apiExpanded = !apiExpanded"
      >
        <span class="usage-failed-chevron" :class="{ on: apiExpanded }" aria-hidden="true">▸</span>
        <span class="card-title">{{ t('usage.apiTitle') }}</span>
        <span class="usage-api-hint">{{ t('usage.apiHint') }}</span>
        <span class="spacer" />
        <span class="dim nowrap" style="font-size: 11.5px">
          {{ apiExpanded ? t('common.collapse') : t('common.expand') }}
        </span>
      </button>

      <div v-if="apiExpanded" class="form-grid" style="gap: 8px; margin-top: 14px">
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
          <div v-if="summaryPending" class="stat-value"><span class="sk sk-stat-line" /></div>
          <div v-else class="stat-value">{{ summary.total }}</div>
          <div class="stat-hint">
            <template v-if="summaryPending">{{ t('common.loading') }}</template>
            <template v-else>
              {{ summary.okCount }} ok · {{ summary.failCount }} {{ t('usage.error') }}
            </template>
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

    <!-- 没有配置任何适配器（清单已回来且确实为空） -->
    <div v-if="!listLoading && items.length === 0" class="card">
      <div class="empty">{{ t('usage.notConfigured') }}</div>
      <div class="dim" style="text-align: center; font-size: 12px">
        {{ t('usage.notConfiguredHint') }}
      </div>
    </div>

    <!--
      纯余额渠道（有金额、无额度窗口 / 账期 / 套餐）：合并成一张卡里的多行。
      这类渠道每个只有一个数字，一卡一张会把页面拉得很长，读起来反而更累。
      每行保留自己的刷新入口，单独刷新不影响其它行。
    -->
    <div v-if="balanceOnlyItems.length > 0" class="card">
      <div class="card-head">
        <div>
          <div class="card-title">{{ t('usage.balanceOnlyTitle') }}</div>
          <div class="dim" style="font-size: 12px">{{ t('usage.balanceOnlyHint') }}</div>
        </div>
      </div>

      <div class="usage-balance-list">
        <div v-for="item in balanceOnlyItems" :key="item.channelId" class="usage-balance-row">
          <span class="row" style="gap: 6px; min-width: 0">
            <span class="usage-cell-name">{{ item.channelName }}</span>
            <span class="tag">{{ item.snapshot!.adapter || item.adapter }}</span>
            <span v-if="item.snapshot!.cached" class="badge badge-off">{{ t('usage.cached') }}</span>
          </span>
          <span class="row" style="gap: 10px">
            <span
              v-for="b in item.snapshot!.balances"
              :key="b.currency"
              class="mono usage-balance-amount"
            >
              {{ money(b.remaining, b.unit, b.currency) }}
            </span>
            <span class="dim" style="font-size: 11px">{{ formatTime(item.snapshot!.fetchedAt) }}</span>
            <button class="btn btn-ghost btn-sm" :disabled="item.loading" @click="refreshOne(item)">
              {{ item.loading ? t('common.loading') : t('common.refresh') }}
            </button>
            <button class="btn btn-ghost btn-sm" @click="openRaw(item.snapshot!)">
              {{ t('usage.viewRaw') }}
            </button>
          </span>
        </div>
      </div>
    </div>


    <!--
      每个渠道一张卡：**各自加载、各自渲染**。
      卡片壳子来自只读本地表的渠道清单（毫秒级），数据各自去取，
      谁先回来谁先显示 —— 不再为一个慢渠道拖住整页。
    -->
    <div v-for="item in cardItems" :key="item.channelId" class="card">
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
        <button class="btn btn-sm" :disabled="item.loading" @click="refreshOne(item)">
          {{ item.loading ? t('common.loading') : t('common.refresh') }}
        </button>
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
          <button class="btn btn-ghost btn-sm" @click="openRaw(item.snapshot!)">
            {{ t('usage.viewRaw') }}
          </button>
        </div>
      </div>

      <template v-else>
        <div v-if="item.snapshot!.stale" class="alert">{{ t('usage.stale') }}</div>

        <!-- 金额余额 -->
        <div v-if="item.snapshot!.balances.length > 0" class="grid grid-3" style="margin-bottom: 14px">
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
        <div v-if="item.snapshot!.windows.length > 0" style="margin-bottom: 14px">
          <div class="dim" style="font-size: 12px; margin-bottom: 8px">{{ t('usage.windows') }}</div>
          <div class="form-grid" style="gap: 10px">
            <div v-for="w in item.snapshot!.windows" :key="w.key">
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

        <div style="margin-top: 10px">
          <button class="btn btn-ghost btn-sm" @click="openRaw(item.snapshot!)">{{ t('usage.viewRaw') }}</button>
        </div>
      </template>
    </div>

    <!--
      整卡失败的渠道：收拢到一处、默认折叠。
      以前它们是若干条占满整屏的红条，把正常渠道挤到下面；
      现在只留一行摘要，需要追因时手动展开。
    -->
    <div v-if="failedItems.length > 0" class="card usage-failed">
      <button
        class="usage-failed-head"
        type="button"
        :aria-expanded="failedExpanded"
        @click="failedExpanded = !failedExpanded"
      >
        <span class="usage-failed-chevron" :class="{ on: failedExpanded }" aria-hidden="true">▸</span>
        <span class="usage-failed-title">
          {{ t('usage.failedGroup', { n: failedItems.length }) }}
        </span>
        <span class="usage-failed-names">
          {{ failedItems.map((i) => i.channelName).join(' · ') }}
        </span>
        <span class="spacer" />
        <span class="dim nowrap" style="font-size: 11.5px">
          {{ failedExpanded ? t('common.collapse') : t('common.expand') }}
        </span>
      </button>

      <div v-if="failedExpanded" class="usage-failed-body">
        <div class="dim" style="font-size: 12px; margin-bottom: 10px">
          {{ t('usage.failedGroupHint') }}
        </div>
        <div v-for="item in failedItems" :key="item.channelId" class="usage-failed-item">
          <div class="row" style="gap: 8px; min-width: 0">
            <span class="usage-cell-name">{{ item.channelName }}</span>
            <span class="tag">{{ item.snapshot?.adapter || item.adapter }}</span>
            <span class="spacer" />
            <button class="btn btn-sm" :disabled="item.loading" @click="refreshOne(item)">
              {{ item.loading ? t('common.loading') : t('common.refresh') }}
            </button>
            <button
              v-if="item.snapshot"
              class="btn btn-ghost btn-sm"
              @click="openRaw(item.snapshot!)"
            >
              {{ t('usage.viewRaw') }}
            </button>
          </div>
          <div class="alert" style="margin-top: 8px">
            {{ item.error || item.snapshot?.error || t('usage.error') }}
          </div>
        </div>
      </div>
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
