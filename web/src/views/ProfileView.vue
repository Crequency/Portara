<script setup lang="ts">
/**
 * 个人资料页。
 *
 * 入口在顶栏用户卡片（不在侧栏 NAV）：这里展示的是「当前账号」的
 * 资料 + 用户范围统计 + 计费自助，不是一项功能模块。
 *
 * 统计口径与概览页不同 —— 只看自己名下的 API Key，详见后端 profile 路由。
 * 计费自助走 /api/billing/me + /api/billing/my/*（任何登录用户）；
 * 未分配套餐时两块计费卡只显示空态，不把 0 余额当成错误。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import {
  api,
  type BalanceLedgerEntry,
  type BillingMe,
  type BillingWindow,
  type BillingWindowUsage,
  type LimitTemplate,
  type MyBillingLimits,
  type ProfileResponse,
  type User
} from '../api'
import Modal from '../components/Modal.vue'
import PCheckbox from '../components/PCheckbox.vue'
import PSelect from '../components/PSelect.vue'
import UsageTrendCard from '../components/UsageTrendCard.vue'
import { errorText } from '../error'
import { formatCompact, formatMoney, formatNumber, formatPercent, formatTime } from '../format'
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

/* ---------------------------------------------------------------- 计费自助 */

const billing = ref<BillingMe | null>(null)
const myTemplates = ref<LimitTemplate[]>([])
const myLimits = ref<MyBillingLimits | null>(null)
const billingLoading = ref(true)
const billingError = ref('')
const ledgerExpanded = ref(false)

const plan = computed(() => billing.value?.plan ?? null)
const hasPlan = computed(() => plan.value !== null)
const billingUnit = computed(() => billing.value?.unit || plan.value?.unit || '')
const billingCurrency = computed(() => billing.value?.currency || plan.value?.currency || 'USD')

const windows = computed<BillingWindowUsage[]>(() => billing.value?.windows ?? [])
const ledger = computed<BalanceLedgerEntry[]>(() => billing.value?.ledger ?? [])
const visibleLedger = computed(() =>
  ledgerExpanded.value ? ledger.value : ledger.value.slice(0, 10)
)

function unitLabel(unit: string): string {
  if (unit === 'money') return t('billing.unit.money')
  if (unit === 'credits') return t('billing.unit.credits')
  if (unit === 'tokens') return t('billing.unit.tokens')
  return unit || '—'
}

/** 按套餐单位把数字变成「友好」的展示：金额带币种，积分 / token 带单位 */
function formatUnitValue(value: number, unit: string): string {
  if (unit === 'money') return formatMoney(value, billingCurrency.value)
  if (unit === 'credits') return formatNumber(value) + ' ' + t('billing.unit.credits')
  if (unit === 'tokens') return formatNumber(value) + ' ' + t('billing.unit.tokens')
  return formatNumber(value)
}

const planUnitText = computed(() => {
  const p = plan.value
  if (!p) return ''
  if (p.unit === 'money') return t('billing.unit.money') + ' · ' + p.currency
  return unitLabel(p.unit)
})

const balanceText = computed(() =>
  billing.value ? formatUnitValue(billing.value.balance, billingUnit.value) : '—'
)

/** 余额告警：后端按套餐单位换算好的布尔值，前端只负责展示 */
const lowBalance = computed(() => billing.value?.lowBalance === true)
const nearLimit = computed(() => billing.value?.nearLimit === true)

function windowPercent(w: BillingWindowUsage): number {
  if (!Number.isFinite(w.limit) || w.limit <= 0) return 0
  return Math.min(100, Math.round((w.used / w.limit) * 100))
}

type WindowState = 'normal' | 'warn' | 'danger'

function windowState(w: BillingWindowUsage): WindowState {
  if (w.limit > 0 && w.used >= w.limit) return 'danger'
  return windowPercent(w) >= 80 ? 'warn' : 'normal'
}

function windowColor(w: BillingWindowUsage): string {
  const state = windowState(w)
  if (state === 'danger') return 'var(--danger)'
  if (state === 'warn') return 'var(--warn)'
  return 'var(--accent)'
}

function windowRemaining(w: BillingWindowUsage): string {
  if (!Number.isFinite(w.limit) || w.limit <= 0) return '—'
  const remaining = Math.max(0, w.limit - w.used)
  return formatPercent(remaining / w.limit)
}

function windowText(w: BillingWindowUsage): string {
  return (
    formatUnitValue(w.used, billingUnit.value) +
    ' / ' +
    formatUnitValue(w.limit, billingUnit.value)
  )
}

function ledgerValue(value: number, unit: string): string {
  if (unit === 'money') return formatMoney(value, billingCurrency.value)
  return formatNumber(value) + (unit ? ' ' + unitLabel(unit) : '')
}

function signedLedgerValue(entry: BalanceLedgerEntry): string {
  const sign = entry.delta > 0 ? '+' : entry.delta < 0 ? '-' : ''
  return sign + ledgerValue(Math.abs(entry.delta), entry.unit)
}

function ledgerReason(entry: BalanceLedgerEntry): string {
  if (entry.reason === 'usage') return t('myBilling.reasonUsage')
  return entry.reason || '—'
}

/* ---------------------------------------------------------------- 限额模板 */

const WINDOW_ORDER: BillingWindow[] = ['5h', '1d', '7d', '30d', '1w', '1mo']

const windowOptions = computed(() =>
  WINDOW_ORDER.map((w) => ({ value: w, label: t('billing.window.' + w) }))
)

const globalTemplates = computed(() => myLimits.value?.globalTemplates ?? [])
const lockedIds = computed(() => new Set(myLimits.value?.lockedTemplateIds ?? []))

const selectedTemplateIds = ref<string[]>([])
const applying = ref(false)

const templateDialogOpen = ref(false)
const editingTemplate = ref<LimitTemplate | null>(null)
const templateSaving = ref(false)
const templateForm = reactive({
  name: '',
  note: '',
  rules: [{ window: '5h' as BillingWindow, threshold: '1' }]
})

const selectionDirty = computed(() => {
  const selected = [...selectedTemplateIds.value].sort().join(',')
  const applied = [...(myLimits.value?.templateIds ?? [])].sort().join(',')
  return selected !== applied
})

function isLocked(id: string): boolean {
  return lockedIds.value.has(id)
}

function toggleTemplate(id: string): void {
  if (isLocked(id)) return
  const index = selectedTemplateIds.value.indexOf(id)
  if (index >= 0) selectedTemplateIds.value.splice(index, 1)
  else selectedTemplateIds.value.push(id)
}

async function loadBilling(): Promise<void> {
  billingLoading.value = true
  billingError.value = ''
  try {
    const [me, templates, limits] = await Promise.all([
      api.get<BillingMe>('/api/billing/me'),
      api.get<{ templates: LimitTemplate[] }>('/api/billing/my/templates'),
      api.get<MyBillingLimits>('/api/billing/my/limits')
    ])
    billing.value = me
    myTemplates.value = templates.templates
    myLimits.value = limits
    selectedTemplateIds.value = [...limits.templateIds]
  } catch (err) {
    billingError.value = errorText(err, t('myBilling.loadFailed'))
  } finally {
    billingLoading.value = false
  }
}

/** 只看 /me：套用 / 编辑模板后立即刷新余额与窗口，不用重载模板列表 */
async function refreshBillingSummary(): Promise<void> {
  try {
    billing.value = await api.get<BillingMe>('/api/billing/me')
  } catch (err) {
    billingError.value = errorText(err, t('myBilling.loadFailed'))
  }
}

function firstUnusedWindow(): BillingWindow {
  const used = new Set(templateForm.rules.map((r) => r.window))
  return WINDOW_ORDER.find((w) => !used.has(w)) ?? '5h'
}

function addRule(): void {
  templateForm.rules.push({ window: firstUnusedWindow(), threshold: '1' })
}

function removeRule(index: number): void {
  templateForm.rules.splice(index, 1)
}

function openTemplateDialog(template?: LimitTemplate): void {
  editingTemplate.value = template ?? null
  templateForm.name = template?.name ?? ''
  templateForm.note = template?.note ?? ''
  templateForm.rules = template
    ? template.rules.map((r) => ({ window: r.window, threshold: String(r.threshold) }))
    : [{ window: '5h', threshold: '1' }]
  templateDialogOpen.value = true
}

async function saveTemplate(): Promise<void> {
  const name = templateForm.name.trim()
  if (!name) {
    toast.error(t('myBilling.nameRequired'))
    return
  }

  const usedWindows = templateForm.rules.map((r) => r.window)
  if (new Set(usedWindows).size !== usedWindows.length) {
    toast.error(t('myBilling.duplicateWindow'))
    return
  }

  const rules: { window: BillingWindow; threshold: number }[] = []
  for (const rule of templateForm.rules) {
    const threshold = Number(rule.threshold)
    if (!Number.isFinite(threshold) || threshold <= 0) {
      toast.error(t('myBilling.thresholdInvalid'))
      return
    }
    rules.push({ window: rule.window, threshold })
  }

  templateSaving.value = true
  try {
    const body = { name, note: templateForm.note.trim(), rules }
    if (editingTemplate.value) {
      await api.patch('/api/billing/my/templates/' + editingTemplate.value.id, body)
      toast.success(t('myBilling.templateUpdated'))
    } else {
      await api.post('/api/billing/my/templates', body)
      toast.success(t('myBilling.templateCreated'))
    }
    templateDialogOpen.value = false
    await loadBilling()
  } catch (err) {
    toast.error(errorText(err, t('myBilling.templateSaveFailed')))
  } finally {
    templateSaving.value = false
  }
}

async function removeTemplate(template: LimitTemplate): Promise<void> {
  if (!confirm(t('myBilling.templateDeleteConfirm', { name: template.name }))) return
  try {
    await api.del('/api/billing/my/templates/' + template.id)
    toast.success(t('myBilling.templateDeleted'))
    await loadBilling()
  } catch (err) {
    toast.error(errorText(err, t('myBilling.templateDeleteFailed')))
  }
}

async function saveApply(): Promise<void> {
  applying.value = true
  try {
    const result = await api.put<MyBillingLimits>('/api/billing/my/limits', {
      templateIds: selectedTemplateIds.value
    })
    myLimits.value = result
    selectedTemplateIds.value = [...result.templateIds]
    toast.success(t('myBilling.applied'))
    await refreshBillingSummary()
  } catch (err) {
    toast.error(errorText(err, t('myBilling.applyFailed')))
  } finally {
    applying.value = false
  }
}

onMounted(() => {
  void load()
  void loadBilling()
})
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

      <!-- 计费概览：套餐 / 余额 / 各窗口进度 / 最近流水 -->
      <div class="card my-billing-card" data-testid="my-billing">
        <div class="card-head">
          <div>
            <div class="card-title">{{ t('myBilling.overview') }}</div>
            <div class="dim card-sub">{{ t('myBilling.overviewSub') }}</div>
          </div>
          <div class="row">
            <button class="btn btn-sm" :disabled="billingLoading" @click="loadBilling">
              {{ t('common.refresh') }}
            </button>
          </div>
        </div>

        <div v-if="billingLoading" class="loading">{{ t('common.loading') }}</div>
        <div v-else-if="billingError" class="alert">{{ billingError }}</div>
        <div v-else-if="!hasPlan" class="empty my-billing-empty">
          {{ t('myBilling.noPlan') }}
        </div>

        <template v-else>
          <div class="my-billing-summary">
            <div class="stat">
              <div class="stat-label">{{ t('myBilling.plan') }}</div>
              <div class="stat-value my-plan-name">{{ plan?.name }}</div>
              <div class="stat-hint">
                {{ t('myBilling.unit') }}：{{ planUnitText }}
              </div>
            </div>
            <div class="stat">
              <div class="stat-label">{{ t('myBilling.balance') }}</div>
              <div class="stat-value my-balance">
                {{ balanceText }}
                <span
                  v-if="lowBalance"
                  class="badge badge-warn my-balance-badge"
                  :title="t('myBilling.lowBalanceHint')"
                >
                  {{ t('myBilling.lowBalance') }}
                </span>
                <span
                  v-if="nearLimit"
                  class="badge badge-err my-balance-badge"
                  :title="t('myBilling.nearLimitHint')"
                >
                  {{ t('myBilling.nearLimit') }}
                </span>
              </div>
              <div class="stat-hint">{{ planUnitText }}</div>
            </div>
          </div>

          <div class="my-section-title">{{ t('myBilling.windows') }}</div>
          <div v-if="windows.length === 0" class="dim my-empty-line">
            {{ t('myBilling.noWindows') }}
          </div>
          <div v-else class="my-windows">
            <div
              v-for="w in windows"
              :key="w.window"
              class="my-window"
              :data-state="windowState(w)"
            >
              <div class="my-window-head">
                <span class="my-window-label">{{ t('billing.window.' + w.window) }}</span>
                <span class="my-window-value mono">{{ windowText(w) }}</span>
                <span class="my-window-remain dim">
                  {{ t('myBilling.remaining') }} {{ windowRemaining(w) }}
                </span>
              </div>
              <div
                class="my-window-track"
                role="progressbar"
                :aria-valuenow="windowPercent(w)"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <div
                  class="my-window-fill"
                  :style="{ width: windowPercent(w) + '%', background: windowColor(w) }"
                ></div>
              </div>
            </div>
          </div>

          <div class="my-section-title">{{ t('myBilling.ledger') }}</div>
          <div v-if="ledger.length === 0" class="dim my-empty-line">
            {{ t('myBilling.ledgerEmpty') }}
          </div>
          <template v-else>
            <div class="table-wrap my-ledger">
              <table>
                <thead>
                  <tr>
                    <th>{{ t('myBilling.time') }}</th>
                    <th>{{ t('myBilling.change') }}</th>
                    <th>{{ t('myBilling.reason') }}</th>
                    <th>{{ t('myBilling.balanceAfter') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="entry in visibleLedger" :key="entry.id">
                    <td class="dim nowrap">{{ formatTime(entry.createdAt) }}</td>
                    <td
                      class="mono nowrap"
                      :class="entry.delta >= 0 ? 'ledger-in' : 'ledger-out'"
                    >
                      {{ signedLedgerValue(entry) }}
                    </td>
                    <td>{{ ledgerReason(entry) }}</td>
                    <td class="mono nowrap">{{ ledgerValue(entry.balanceAfter, entry.unit) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <button
              v-if="ledger.length > 10"
              class="btn btn-sm my-ledger-toggle"
              @click="ledgerExpanded = !ledgerExpanded"
            >
              {{
                ledgerExpanded
                  ? t('myBilling.ledgerCollapse')
                  : t('myBilling.ledgerAll', { n: ledger.length })
              }}
            </button>
          </template>
        </template>
      </div>

      <!-- 我的限额模板：自建 / 编辑 / 删除 / 套用（含全局模板） -->
      <div class="card my-templates-card" data-testid="my-templates">
        <div class="card-head">
          <div>
            <div class="card-title">{{ t('myBilling.templates') }}</div>
            <div class="dim card-sub">{{ t('myBilling.templatesSub') }}</div>
          </div>
          <div v-if="hasPlan && !billingLoading" class="row">
            <button
              class="btn btn-sm"
              :disabled="!selectionDirty || applying"
              @click="saveApply"
            >
              {{ applying ? t('common.saving') : t('myBilling.applySave') }}
            </button>
            <button class="btn btn-primary btn-sm" @click="openTemplateDialog()">
              ＋ {{ t('myBilling.newTemplate') }}
            </button>
          </div>
        </div>

        <div v-if="billingLoading" class="loading">{{ t('common.loading') }}</div>
        <div v-else-if="billingError" class="alert">{{ billingError }}</div>
        <div v-else-if="!hasPlan" class="empty my-billing-empty">
          {{ t('myBilling.noPlan') }}
        </div>

        <template v-else>
          <div class="my-section-title">{{ t('myBilling.myTemplates') }}</div>
          <div v-if="myTemplates.length === 0" class="dim my-empty-line">
            {{ t('myBilling.templateEmpty') }}
          </div>
          <div v-else class="my-template-list">
            <div
              v-for="tpl in myTemplates"
              :key="tpl.id"
              class="my-template-row"
              :data-template-id="tpl.id"
            >
              <PCheckbox
                :model-value="selectedTemplateIds.includes(tpl.id)"
                :disabled="isLocked(tpl.id)"
                @update:model-value="toggleTemplate(tpl.id)"
              />
              <div class="my-template-main">
                <div class="my-template-name">{{ tpl.name }}</div>
                <div v-if="tpl.rules.length > 0" class="tag-list">
                  <span v-for="rule in tpl.rules" :key="rule.window" class="tag">
                    {{ t('billing.window.' + rule.window) }} ·
                    {{ formatUnitValue(rule.threshold, billingUnit) }}
                  </span>
                </div>
                <div v-else class="dim my-template-norule">{{ t('myBilling.noRules') }}</div>
              </div>
              <span v-if="isLocked(tpl.id)" class="tag my-locked-tag">
                {{ t('myBilling.adminAssigned') }}
              </span>
              <div class="row my-template-actions">
                <button class="btn btn-sm" @click="openTemplateDialog(tpl)">
                  {{ t('common.edit') }}
                </button>
                <button class="btn btn-sm btn-danger" @click="removeTemplate(tpl)">
                  {{ t('common.delete') }}
                </button>
              </div>
            </div>
          </div>

          <div class="my-section-title">
            {{ t('myBilling.globalTemplates') }}
            <span class="dim my-section-hint">{{ t('myBilling.globalHint') }}</span>
          </div>
          <div v-if="globalTemplates.length === 0" class="dim my-empty-line">
            {{ t('myBilling.globalEmpty') }}
          </div>
          <div v-else class="my-template-list">
            <div
              v-for="tpl in globalTemplates"
              :key="tpl.id"
              class="my-template-row"
              :data-template-id="tpl.id"
            >
              <PCheckbox
                :model-value="selectedTemplateIds.includes(tpl.id)"
                :disabled="isLocked(tpl.id)"
                @update:model-value="toggleTemplate(tpl.id)"
              />
              <div class="my-template-main">
                <div class="my-template-name">{{ tpl.name }}</div>
                <div v-if="tpl.rules.length > 0" class="tag-list">
                  <span v-for="rule in tpl.rules" :key="rule.window" class="tag">
                    {{ t('billing.window.' + rule.window) }} ·
                    {{ formatUnitValue(rule.threshold, billingUnit) }}
                  </span>
                </div>
                <div v-else class="dim my-template-norule">{{ t('myBilling.noRules') }}</div>
              </div>
              <span class="tag">{{ t('billing.global') }}</span>
              <span v-if="isLocked(tpl.id)" class="tag my-locked-tag">
                {{ t('myBilling.adminAssigned') }}
              </span>
            </div>
          </div>
          <div v-if="lockedIds.size > 0" class="hint my-locked-hint">
            {{ t('myBilling.adminLockedHint') }}
          </div>
        </template>
      </div>

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

    <!-- 新建 / 编辑限额模板 -->
    <Modal
      v-if="templateDialogOpen"
      :title="editingTemplate ? t('myBilling.editTemplate') : t('myBilling.newTemplate')"
      wide
      @close="templateDialogOpen = false"
    >
      <div class="form-grid">
        <div class="form-row">
          <div class="field">
            <label>{{ t('myBilling.name') }}</label>
            <input
              v-model="templateForm.name"
              maxlength="64"
              :placeholder="t('myBilling.namePlaceholder')"
            />
          </div>
          <div class="field">
            <label>{{ t('myBilling.note') }}</label>
            <input
              v-model="templateForm.note"
              maxlength="500"
              :placeholder="t('common.optional')"
            />
          </div>
        </div>

        <div class="field">
          <div class="row-between">
            <label>{{ t('myBilling.rules') }}</label>
            <button class="btn btn-sm" @click="addRule">
              ＋ {{ t('myBilling.addRule') }}
            </button>
          </div>
          <div v-if="templateForm.rules.length === 0" class="dim my-empty-line">
            {{ t('myBilling.noRules') }}
          </div>
          <div v-else class="rule-list">
            <div v-for="(rule, index) in templateForm.rules" :key="index" class="rule-row">
              <div class="field">
                <label>{{ t('myBilling.window') }}</label>
                <PSelect v-model="rule.window" :options="windowOptions" />
              </div>
              <div class="field">
                <label>{{ t('myBilling.threshold') }}</label>
                <input v-model="rule.threshold" type="number" min="0.000001" step="any" />
              </div>
              <button class="btn btn-sm btn-danger" @click="removeRule(index)">
                {{ t('common.delete') }}
              </button>
            </div>
          </div>
          <span class="hint">{{ t('myBilling.thresholdHint') }}</span>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="templateDialogOpen = false">
          {{ t('common.cancel') }}
        </button>
        <button class="btn btn-primary" :disabled="templateSaving" @click="saveTemplate">
          {{ templateSaving ? t('common.saving') : t('common.save') }}
        </button>
      </div>
    </Modal>
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

/* ---------------------------------------------------------------- 计费卡 */

.card-sub {
  font-size: 12px;
}

.my-billing-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.my-plan-name {
  font-size: 22px;
}

.my-balance {
  font-size: 32px;
}

/* 余额旁边的告警徽章：不要跟着 32px 的字号一起放大 */
.my-balance-badge {
  margin-left: 8px;
  font-size: 11.5px;
  vertical-align: middle;
}

.my-section-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 16px 0 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-dim);
}

.my-section-hint {
  font-size: 11.5px;
  font-weight: 400;
}

.my-windows {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.my-window-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12.5px;
}

.my-window-label {
  font-weight: 600;
}

.my-window-value {
  font-variant-numeric: tabular-nums;
}

.my-window-remain {
  margin-left: auto;
  white-space: nowrap;
}

.my-window-track {
  height: 8px;
  margin-top: 5px;
  border-radius: 999px;
  overflow: hidden;
  background: color-mix(in srgb, var(--text) 8%, transparent);
}

.my-window-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.2s ease;
}

.my-ledger {
  margin-top: 4px;
  max-height: 360px;
}

.my-ledger-toggle {
  margin-top: 8px;
}

.ledger-in {
  color: var(--success);
}

.ledger-out {
  color: var(--danger);
}

.my-template-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.my-template-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev-2);
}

.my-template-main {
  display: flex;
  flex: 1 1 240px;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.my-template-name {
  font-size: 13px;
  font-weight: 560;
}

.my-template-actions {
  margin-left: auto;
  flex-wrap: nowrap;
}

.my-template-norule {
  font-size: 11.5px;
}

.my-locked-tag {
  color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) 32%, transparent);
}

.my-locked-hint {
  margin-top: 8px;
  font-size: 11.5px;
}

.my-empty-line {
  padding: 6px 0;
  font-size: 12px;
}

.my-billing-empty {
  padding: 26px 16px;
}

.rule-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rule-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 10px;
  align-items: end;
}

.rule-row > .btn {
  margin-bottom: 1px;
}

@media (max-width: 720px) {
  .profile-dates {
    text-align: left;
  }

  .profile-table th {
    width: 120px;
  }

  .my-billing-summary {
    grid-template-columns: minmax(0, 1fr);
  }

  .my-window-remain {
    margin-left: 0;
  }

  .rule-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
