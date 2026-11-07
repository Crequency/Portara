<script setup lang="ts">
/**
 * 负载均衡实况：窗口内的请求分配、账户状态与故障转移记录。
 *
 * 数据只有一个来源：GET /api/lb/live?minutes=N。页面每 5 秒自动刷新，
 * 页面隐藏时跳过（后台标签页不该继续打管理接口）；切换窗口会立即重新取数。
 *
 * 账户行按窗口请求数降序，占比条的长度 = share × 100%，颜色跟随账户状态，
 * 这样一眼能看出「请求是不是都压在某个快冷却的账户上」。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  api,
  type LbLiveAccount,
  type LbLiveAccountState,
  type LbLiveAlias,
  type LbLiveEventOutcome,
  type LbLiveSnapshot,
  type User
} from '../api'
import PCheckbox from '../components/PCheckbox.vue'
import { formatLatency, formatNumber, formatPercent, formatTime } from '../format'
import { useI18n } from '../i18n'
import { toast } from '../toast'

defineProps<{ user?: User }>()

const { t } = useI18n()

/** 可选窗口（分钟）。顺序即界面顺序。 */
const WINDOWS = [5, 15, 60] as const
type WindowMinutes = (typeof WINDOWS)[number]

/** 自动刷新间隔：契约要求 5 秒 */
const AUTO_REFRESH_MS = 5000
/** 故障转移表最多展示 200 行；更早的记录只存在于后端 */
const EVENT_LIMIT = 200

const minutes = ref<WindowMinutes>(15)
const autoRefresh = ref(true)
const paused = ref(false)

/**
 * 首次加载 / 切换窗口时为 true（没有旧数据可展示）。
 * 手动刷新时保持 false：旧数据继续显示，避免整页闪骨架。
 */
const loading = ref(true)
/** 任一请求在途；用于禁用手动刷新按钮、避免定时器叠加请求 */
const refreshing = ref(false)
/** 最近一次请求失败；没有 snapshot 时由它决定显示可重试空态 */
const failed = ref(false)

const snapshot = ref<LbLiveSnapshot | null>(null)

let timer: ReturnType<typeof setInterval> | null = null
/**
 * 请求代次：切窗口 / 手动刷新可能落在一次自动刷新之后。
 * 只让最后发出的请求落地，旧响应直接丢弃 —— 否则会把上一个窗口的数据
 * 盖到新窗口界面上。
 */
let loadSeq = 0
/** 错误提示节流：自动刷新失败时不要每 5 秒弹一次 */
let lastToastAt = 0

const aliases = computed(() => snapshot.value?.aliases ?? [])
const totals = computed(() => snapshot.value?.totals)

/** 错误率由前端算，后端 totals 里没有这个字段 */
const errorRate = computed(() => {
  const value = totals.value
  if (!value || value.requests <= 0) return '—'
  return formatPercent(value.errors / value.requests)
})

/** 冷却中 / 活跃账户都补一句「占全部账户的比例」，避免孤立数字 */
const accountHint = computed(() => {
  const value = totals.value
  if (!value) return ''
  return t('lbLive.totals.ofAccounts', {
    active: formatNumber(value.activeAccounts),
    total: formatNumber(value.activeAccounts + value.coolingAccounts)
  })
})

const metrics = computed(() => [
  {
    key: 'requests',
    label: t('lbLive.totals.requests'),
    value: formatNumber(totals.value?.requests),
    hint: snapshot.value
      ? t('lbLive.windowOption', { n: snapshot.value.windowMinutes })
      : ''
  },
  {
    key: 'errors',
    label: t('lbLive.totals.errors'),
    value: formatNumber(totals.value?.errors),
    hint: t('lbLive.totals.errorRate', { value: errorRate.value })
  },
  {
    key: 'failovers',
    label: t('lbLive.totals.failovers'),
    value: formatNumber(totals.value?.failovers),
    hint: ''
  },
  {
    key: 'quotaCooldowns',
    label: t('lbLive.totals.quotaCooldowns'),
    value: formatNumber(totals.value?.quotaCooldowns),
    hint: ''
  },
  {
    key: 'coolingAccounts',
    label: t('lbLive.totals.coolingAccounts'),
    value: formatNumber(totals.value?.coolingAccounts),
    hint: accountHint.value
  },
  {
    key: 'activeAccounts',
    label: t('lbLive.totals.activeAccounts'),
    value: formatNumber(totals.value?.activeAccounts),
    hint: accountHint.value
  }
])

/** 事件按时间倒序；后端顺序不可依赖，且截断到 200 行 */
const events = computed(() => {
  const list = snapshot.value?.events ?? []
  return [...list]
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, EVENT_LIMIT)
})

const STATE_BADGE: Record<LbLiveAccountState, string> = {
  ok: 'badge-ok',
  quotaCooling: 'badge-warn',
  genericCooling: 'badge-warn',
  usageLimited: 'badge-err'
}

const STATE_COLOR: Record<LbLiveAccountState, string> = {
  ok: 'var(--success)',
  quotaCooling: 'var(--warn)',
  genericCooling: 'var(--warn)',
  usageLimited: 'var(--danger)'
}

const OUTCOME_BADGE: Record<LbLiveEventOutcome, string> = {
  attempt_failed: 'badge-err',
  failover_success: 'badge-ok',
  quota_cooldown: 'badge-warn'
}

function stateBadge(state: LbLiveAccountState): string {
  return STATE_BADGE[state] ?? 'badge-off'
}

function stateColor(state: LbLiveAccountState): string {
  return STATE_COLOR[state] ?? 'var(--text-faint)'
}

function outcomeBadge(outcome: LbLiveEventOutcome): string {
  return OUTCOME_BADGE[outcome] ?? 'badge-off'
}

/** share 是 0–1；越界值来自后端异常，夹紧后画条，避免条冲出卡片 */
function shareWidth(share: number): string {
  const ratio = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0
  return (ratio * 100).toFixed(2) + '%'
}

/** 账户行：窗口请求数降序，同数按名称稳定排序 */
function sortedAccounts(alias: LbLiveAlias): LbLiveAccount[] {
  return [...alias.accounts].sort(
    (a, b) =>
      b.requests - a.requests ||
      (a.accountName || a.accountId).localeCompare(b.accountName || b.accountId)
  )
}

/**
 * 取数。
 *
 * forceToast 用于手动刷新 / 切换窗口：即使刚提示过也要再提示一次；
 * 自动刷新走节流，避免后台每 5 秒弹一个 toast。
 */
async function load({ forceToast = false } = {}): Promise<void> {
  const seq = ++loadSeq
  const requested = minutes.value
  refreshing.value = true
  if (!snapshot.value) loading.value = true

  try {
    const res = await api.get<LbLiveSnapshot>('/api/lb/live?minutes=' + requested)
    // 已经有更新的请求（切窗口 / 手动刷新）发出 → 这份响应属于旧窗口
    if (seq !== loadSeq) return
    snapshot.value = res
    failed.value = false
  } catch {
    if (seq !== loadSeq) return
    failed.value = true
    const now = Date.now()
    if (forceToast || now - lastToastAt > 15000) {
      toast.error(t('lbLive.loadFailed'))
      lastToastAt = now
    }
  } finally {
    // 旧请求不能把新请求的 loading / refreshing 状态清掉
    if (seq === loadSeq) {
      loading.value = false
      refreshing.value = false
    }
  }
}

/** 切窗口：旧窗口的数据不能留着冒充当新窗口 */
function chooseWindow(next: WindowMinutes): void {
  if (minutes.value === next) return
  minutes.value = next
  snapshot.value = null
  failed.value = false
  loading.value = true
  void load({ forceToast: true })
}

function refresh(): void {
  void load({ forceToast: true })
}

function retry(): void {
  failed.value = false
  loading.value = true
  void load({ forceToast: true })
}

function togglePause(): void {
  paused.value = !paused.value
  // 继续时立刻补一次数据，不用等下一个 5 秒周期
  if (!paused.value) void load()
}

onMounted(() => {
  void load()
  timer = setInterval(() => {
    if (!autoRefresh.value || paused.value) return
    // 后台标签页跳过：既省请求，也避免用户回来时看到一串过期快照
    if (document.visibilityState === 'hidden') return
    // 上一次还没回来就不叠加；手动刷新不受这个限制（会按代次覆盖）
    if (refreshing.value) return
    void load()
  }, AUTO_REFRESH_MS)
})

onBeforeUnmount(() => {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
})
</script>

<template>
  <div class="stack lb-live">
    <!-- 顶部工具栏：窗口 / 自动刷新 / 暂停 / 手动刷新 -->
    <div class="card">
      <div class="card-head panel-head">
        <div>
          <div class="card-title">{{ t('lbLive.title') }}</div>
          <div class="dim" style="font-size: 12px">{{ t('lbLive.sub') }}</div>
        </div>
        <div class="row row-wrap">
          <div class="segmented segmented-sm" role="group" :aria-label="t('lbLive.title')">
            <button
              v-for="w in WINDOWS"
              :key="w"
              :class="{ on: minutes === w }"
              @click="chooseWindow(w)"
            >
              {{ t('lbLive.windowOption', { n: w }) }}
            </button>
          </div>
          <PCheckbox v-model="autoRefresh" :label="t('lbLive.autoRefresh')" />
          <button class="btn btn-sm" :disabled="!autoRefresh" @click="togglePause">
            {{ paused ? t('lbLive.resume') : t('lbLive.pause') }}
          </button>
          <button class="btn btn-sm" :disabled="refreshing" @click="refresh">
            {{ t('lbLive.refresh') }}
          </button>
        </div>
      </div>

      <div class="row row-wrap dim" style="font-size: 12px; gap: 8px">
        <span>
          {{
            t('lbLive.generatedAt', {
              time: snapshot ? formatTime(snapshot.generatedAt) : '—'
            })
          }}
        </span>
        <span>·</span>
        <span>{{ t('lbLive.autoRefreshHint') }}</span>
        <span v-if="paused" class="badge badge-warn">{{ t('lbLive.pausedHint') }}</span>
      </div>
    </div>

    <!-- 首次加载 / 切换窗口：与真实结构同构的骨架，避免布局跳动 -->
    <template v-if="loading && !snapshot">
      <div class="grid grid-4" aria-hidden="true">
        <div v-for="n in 6" :key="n" class="stat">
          <div class="sk lb-sk-label"></div>
          <div class="sk lb-sk-value"></div>
        </div>
      </div>

      <div class="card" aria-hidden="true">
        <div class="card-head">
          <div class="sk lb-sk-title"></div>
          <div class="sk lb-sk-hint"></div>
        </div>
        <div v-for="n in 3" :key="n" class="lb-account">
          <div class="row-between">
            <div class="sk lb-sk-name"></div>
            <div class="sk lb-sk-share"></div>
          </div>
          <div class="sk lb-sk-track"></div>
          <div class="row row-wrap">
            <div v-for="m in 4" :key="m" class="sk lb-sk-meta"></div>
          </div>
        </div>
      </div>

      <div class="card" aria-hidden="true">
        <div class="card-head">
          <div class="sk lb-sk-title"></div>
          <div class="sk lb-sk-hint"></div>
        </div>
        <div class="sk lb-sk-table"></div>
      </div>
    </template>

    <!-- 首次加载失败：toast 已提示，这里给可重试空态 -->
    <div v-else-if="failed && !snapshot" class="card">
      <div class="empty">
        <div>{{ t('lbLive.loadFailed') }}</div>
        <div class="row" style="justify-content: center; margin-top: 10px">
          <button class="btn btn-sm" @click="retry">{{ t('lbLive.retry') }}</button>
        </div>
      </div>
    </div>

    <template v-else-if="snapshot">
      <!-- 指标卡：6 项，grid-4 两行 -->
      <div class="grid grid-4">
        <div v-for="m in metrics" :key="m.key" class="stat">
          <div class="stat-label">{{ m.label }}</div>
          <div class="stat-value">{{ m.value }}</div>
          <div v-if="m.hint" class="stat-hint">{{ m.hint }}</div>
        </div>
      </div>

      <!-- 分配情况：每个别名一张卡 -->
      <div class="card">
        <div class="card-head">
          <div class="card-title">
            {{ t('lbLive.distribution') }}
            <span class="dim" style="font-weight: 400">
              · {{ t('lbLive.aliasCount', { n: aliases.length }) }}
            </span>
          </div>
          <span class="dim" style="font-size: 12px">{{ t('lbLive.sortedByRequests') }}</span>
        </div>

        <div v-if="aliases.length === 0" class="empty">{{ t('lbLive.noData') }}</div>

        <div v-else class="stack" style="gap: 12px">
          <div v-for="a in aliases" :key="a.alias" class="lb-alias-card">
            <div class="row row-wrap lb-alias-head">
              <span class="mono lb-alias">{{ a.alias }}</span>
              <span
                v-for="(tg, i) in a.targets"
                :key="tg.channelId + ':' + tg.upstreamModel + ':' + i"
                class="tag"
              >
                {{ tg.channelName || tg.channelId }} · {{ tg.upstreamModel }}
              </span>
              <span v-if="a.targets.length === 0" class="tag">{{ t('lbLive.noTargets') }}</span>
              <span class="spacer" />
              <span class="dim" style="font-size: 11.5px">
                {{ t('lbLive.accountCount', { n: a.accounts.length }) }}
              </span>
            </div>

            <div v-if="a.accounts.length === 0" class="empty">
              {{ t('lbLive.noAccounts') }}
            </div>

            <div v-else class="stack" style="gap: 8px; margin-top: 10px">
              <div
                v-for="acc in sortedAccounts(a)"
                :key="acc.channelId + ':' + acc.accountId"
                class="lb-account"
              >
                <div class="row row-wrap lb-account-line">
                  <span class="lb-account-name">{{ acc.accountName || acc.accountId }}</span>
                  <span class="dim">{{ acc.channelName }}</span>
                  <span class="badge" :class="stateBadge(acc.state)">
                    {{ t('lbLive.state.' + acc.state) }}
                  </span>
                  <span class="spacer" />
                  <span class="mono lb-account-share">{{ formatPercent(acc.share) }}</span>
                </div>

                <!-- 请求占比条：长度 share × 100%，颜色按状态区分 -->
                <div class="lb-share-track" :title="t('lbLive.meta.share')">
                  <div
                    class="lb-share-fill"
                    :style="{ width: shareWidth(acc.share), background: stateColor(acc.state) }"
                  />
                </div>

                <div class="row row-wrap dim lb-account-meta">
                  <span>{{ t('lbLive.meta.priority') }} <b>{{ acc.priority }}</b></span>
                  <span>{{ t('lbLive.meta.weight') }} <b>{{ acc.weight }}</b></span>
                  <span>{{ t('lbLive.meta.requests') }} <b>{{ formatNumber(acc.requests) }}</b></span>
                  <span>{{ t('lbLive.meta.errors') }} <b>{{ formatNumber(acc.errors) }}</b></span>
                  <span>{{ t('lbLive.meta.avgLatency') }} <b>{{ formatLatency(acc.avgLatencyMs) }}</b></span>
                  <span>
                    {{ t('lbLive.meta.coolingUntil') }}
                    <b>{{ formatTime(acc.coolingUntil) }}</b>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 故障转移记录：时间倒序，最多 200 行 -->
      <div class="card">
        <div class="card-head">
          <div class="card-title">{{ t('lbLive.events.title') }}</div>
          <span class="dim" style="font-size: 12px">
            {{ t('lbLive.events.count', { n: events.length }) }}
          </span>
        </div>

        <div v-if="events.length === 0" class="empty">{{ t('lbLive.events.empty') }}</div>

        <div v-else class="table-wrap">
          <table class="lb-events-table">
            <thead>
              <tr>
                <th>{{ t('lbLive.events.time') }}</th>
                <th>{{ t('lbLive.events.alias') }}</th>
                <th>{{ t('lbLive.events.channel') }}</th>
                <th>{{ t('lbLive.events.account') }}</th>
                <th>{{ t('lbLive.events.attempt') }}</th>
                <th>{{ t('lbLive.events.outcome') }}</th>
                <th>{{ t('lbLive.events.statusCode') }}</th>
                <th>{{ t('lbLive.events.reason') }}</th>
                <th>{{ t('lbLive.events.latency') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(ev, i) in events" :key="ev.ts + ':' + ev.alias + ':' + i">
                <td class="nowrap dim">{{ formatTime(ev.ts) }}</td>
                <td class="mono">{{ ev.alias }}</td>
                <td>{{ ev.channelName || '—' }}</td>
                <td>
                  <div>{{ ev.accountName || '—' }}</div>
                  <div v-if="ev.prevAccountName" class="dim" style="font-size: 11px">
                    {{ t('lbLive.events.from', { name: ev.prevAccountName }) }}
                  </div>
                </td>
                <td class="nowrap">{{ t('lbLive.events.attemptN', { n: ev.attempt }) }}</td>
                <td>
                  <span class="badge" :class="outcomeBadge(ev.outcome)">
                    {{ t('lbLive.events.outcomes.' + ev.outcome) }}
                  </span>
                </td>
                <td class="mono">{{ ev.statusCode }}</td>
                <td class="lb-reason" :title="ev.reason">{{ ev.reason || '—' }}</td>
                <td class="nowrap">{{ formatLatency(ev.latencyMs) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lb-alias-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px;
  background: color-mix(in srgb, var(--bg-elev-2) 42%, transparent);
  min-width: 0;
}

.lb-alias-head {
  gap: 8px;
}

.lb-alias {
  font-size: 14px;
  font-weight: 620;
}

.lb-account {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  background: var(--bg-elev);
  min-width: 0;
}

.lb-account-line {
  gap: 8px;
}

.lb-account-name {
  font-weight: 560;
  overflow-wrap: anywhere;
}

.lb-account-share {
  font-variant-numeric: tabular-nums;
}

.lb-share-track {
  height: 6px;
  margin: 8px 0 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elev-2);
  overflow: hidden;
}

.lb-share-fill {
  height: 100%;
  border-radius: 999px;
  min-width: 0;
  transition: width 0.2s ease;
}

.lb-account-meta {
  gap: 6px 14px;
  font-size: 11.5px;
}

.lb-account-meta b {
  color: var(--text);
  font-weight: 560;
}

.lb-reason {
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lb-events-table {
  min-width: 920px;
}

/* 骨架块尺寸对齐真实结构 */
.lb-sk-label {
  width: 42%;
  height: 12px;
}

.lb-sk-value {
  width: 62%;
  height: 24px;
  margin-top: 8px;
}

.lb-sk-title {
  width: 168px;
  height: 14px;
}

.lb-sk-hint {
  width: 92px;
  height: 12px;
}

.lb-sk-name {
  width: 180px;
  max-width: 46%;
  height: 14px;
}

.lb-sk-share {
  width: 52px;
  height: 14px;
}

.lb-sk-track {
  height: 6px;
  margin: 12px 0 10px;
}

.lb-sk-meta {
  width: 84px;
  height: 10px;
}

.lb-sk-table {
  height: 150px;
}

@media (max-width: 620px) {
  .lb-reason {
    max-width: 160px;
  }
}
</style>
