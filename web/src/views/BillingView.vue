<script setup lang="ts">
/**
 * 管理端计费页（v0.5.0）。
 *
 * 四个页签各自独立加载，互不阻塞：
 *   套餐     billing_plans            单位 / 币种 / 积分兑换率
 *   费率     channel_rates            (渠道, 上游模型) 粒度，PUT upsert
 *   模板     limit_templates + rules  窗口规则数组整体替换
 *   用户余额 user_billing + ledger    改套餐 / 调余额 / 看流水
 *
 * 金额一律走 formatMoney / formatNumber，不手写 toFixed 拼接。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  api,
  type AliasRate,
  type BalanceLedgerEntry,
  type BillingPlan,
  type BillingUnit,
  type BillingUserRow,
  type BillingWindow,
  type ChannelRate,
  type LimitTemplate,
  type User
} from '../api'
import BillingAliasRateDialog from '../components/BillingAliasRateDialog.vue'
import BillingRateDialog from '../components/BillingRateDialog.vue'
import BillingUserDialog from '../components/BillingUserDialog.vue'
import Modal from '../components/Modal.vue'
import PSelect from '../components/PSelect.vue'
import { toastError } from '../error'
import { formatMoney, formatNumber, formatTime } from '../format'
import { useI18n } from '../i18n'
import { toast } from '../toast'

const props = defineProps<{ user?: User }>()

const { t } = useI18n()

type Tab = 'plans' | 'rates' | 'templates' | 'users'
const tab = ref<Tab>('plans')

const tabOptions = computed<{ value: Tab; label: string }[]>(() => [
  { value: 'plans', label: t('billing.tabs.plans') },
  { value: 'rates', label: t('billing.tabs.rates') },
  { value: 'templates', label: t('billing.tabs.templates') },
  { value: 'users', label: t('billing.tabs.users') }
])

function selectTab(next: Tab): void {
  tab.value = next
  if (next === 'plans') void loadPlans()
  else if (next === 'rates') void loadRatesTab()
  else if (next === 'templates') void loadTemplates()
  else void loadBillingUsers()
}

/* ---------------------------------------------------------------- 公共 */

const unitOptions = computed(() => [
  { value: 'money', label: t('billing.unit.money') },
  { value: 'credits', label: t('billing.unit.credits') },
  { value: 'tokens', label: t('billing.unit.tokens') }
])

const currencyOptions = computed(() => [
  { value: 'USD', label: 'USD' },
  { value: 'CNY', label: 'CNY' }
])

const statusOptions = computed(() => [
  { value: 'active', label: t('common.enabled') },
  { value: 'disabled', label: t('common.disabled') }
])

function unitLabel(unit: string): string {
  if (unit === 'money') return t('billing.unit.money')
  if (unit === 'credits') return t('billing.unit.credits')
  if (unit === 'tokens') return t('billing.unit.tokens')
  return unit || '—'
}

function roleLabel(role: string): string {
  if (role === 'admin') return t('users.admin')
  if (role === 'operator') return t('users.operator')
  return role
}

function windowLabel(w: BillingWindow): string {
  return t('billing.window.' + w)
}

function statusBadgeClass(status: string): string {
  return status === 'active' ? 'badge-ok' : 'badge-off'
}

/* ---------------------------------------------------------------- 套餐 */

const plans = ref<BillingPlan[]>([])
const plansLoading = ref(false)
const editingPlan = ref<BillingPlan | null>(null)
const planDialogOpen = ref(false)
const planSaving = ref(false)

const planForm = reactive({
  name: '',
  unit: 'money' as BillingUnit,
  currency: 'USD' as 'USD' | 'CNY',
  creditsPerCurrency: '100',
  status: 'active' as 'active' | 'disabled',
  note: ''
})

function openPlanDialog(plan?: BillingPlan): void {
  editingPlan.value = plan ?? null
  Object.assign(planForm, {
    name: plan?.name ?? '',
    unit: plan?.unit ?? 'money',
    currency: plan?.currency ?? 'USD',
    creditsPerCurrency: String(plan?.creditsPerCurrency ?? 100),
    status: plan?.status ?? 'active',
    note: plan?.note ?? ''
  })
  planDialogOpen.value = true
}

async function loadPlans(): Promise<void> {
  plansLoading.value = true
  try {
    const res = await api.get<{ plans: BillingPlan[] }>('/api/billing/plans')
    plans.value = res.plans
  } catch (err) {
    toastError(err, t('billing.loadFailed'))
  } finally {
    plansLoading.value = false
  }
}

async function savePlan(): Promise<void> {
  if (!planForm.name.trim()) {
    toast.error(t('billing.plan.nameRequired'))
    return
  }
  const credits = Number(planForm.creditsPerCurrency)
  if (planForm.unit === 'credits' && (!Number.isFinite(credits) || credits <= 0)) {
    toast.error(t('billing.plan.creditsInvalid'))
    return
  }

  planSaving.value = true
  try {
    const body = {
      name: planForm.name.trim(),
      unit: planForm.unit,
      currency: planForm.currency,
      creditsPerCurrency: Number.isFinite(credits) && credits > 0 ? credits : 100,
      status: planForm.status,
      note: planForm.note.trim()
    }
    if (editingPlan.value) {
      await api.patch('/api/billing/plans/' + editingPlan.value.id, body)
      toast.success(t('billing.plan.updated'))
    } else {
      await api.post('/api/billing/plans', body)
      toast.success(t('billing.plan.created'))
    }
    planDialogOpen.value = false
    await loadPlans()
  } catch (err) {
    toastError(err, t('billing.plan.saveFailed'))
  } finally {
    planSaving.value = false
  }
}

async function removePlan(plan: BillingPlan): Promise<void> {
  if (!confirm(t('billing.plan.deleteConfirm', { name: plan.name }))) return
  try {
    await api.del('/api/billing/plans/' + plan.id)
    toast.success(t('billing.plan.deleted'))
    await loadPlans()
  } catch (err) {
    toastError(err, t('billing.plan.deleteFailed'))
  }
}

/* ---------------------------------------------------------------- 费率 */

/*
 * 费率页签分两块：
 *   别名售价（alias_rates）  决定用户扣费，按复杂均衡规则的对外 alias 唯一；
 *   渠道成本（channel_rates） 只用于成本核算，不影响用户扣费。
 * 两块独立加载、独立新建/编辑/删除，互不阻塞。
 */

const aliasRates = ref<AliasRate[]>([])
const aliasRatesLoading = ref(false)
const aliasFilter = ref('')
const showDisabledAliasRates = ref(false)
const aliasRateDialogOpen = ref(false)
const editingAliasRate = ref<AliasRate | null>(null)

const visibleAliasRates = computed(() => {
  const q = aliasFilter.value.trim().toLowerCase()
  return aliasRates.value.filter((r) => {
    if (!showDisabledAliasRates.value && r.status !== 'active') return false
    return !q || r.alias.toLowerCase().includes(q)
  })
})

async function loadAliasRates(): Promise<void> {
  aliasRatesLoading.value = true
  try {
    const res = await api.get<{ rates: AliasRate[] }>('/api/billing/alias-rates')
    aliasRates.value = res.rates
  } catch (err) {
    toastError(err, t('billing.aliasRate.loadFailed'))
  } finally {
    aliasRatesLoading.value = false
  }
}

function openAliasRateDialog(rate?: AliasRate): void {
  editingAliasRate.value = rate ?? null
  aliasRateDialogOpen.value = true
}

async function setAliasRateStatus(
  rate: AliasRate,
  status: 'active' | 'disabled'
): Promise<void> {
  try {
    await api.put('/api/billing/alias-rates', {
      alias: rate.alias,
      currency: rate.currency,
      inputPerMtok: rate.inputPerMtok,
      outputPerMtok: rate.outputPerMtok,
      perRequest: rate.perRequest,
      status,
      note: rate.note
    })
    toast.success(
      status === 'disabled'
        ? t('billing.aliasRate.disabledToast')
        : t('billing.aliasRate.enabledToast')
    )
    await loadAliasRates()
  } catch (err) {
    toastError(err, t('billing.aliasRate.saveFailed'))
  }
}

async function removeAliasRate(rate: AliasRate): Promise<void> {
  if (!confirm(t('billing.aliasRate.deleteConfirm', { alias: rate.alias }))) return
  try {
    await api.del('/api/billing/alias-rates/' + encodeURIComponent(rate.id))
    toast.success(t('billing.aliasRate.deleted'))
    await loadAliasRates()
  } catch (err) {
    toastError(err, t('billing.aliasRate.deleteFailed'))
  }
}

async function loadRatesTab(): Promise<void> {
  await Promise.all([loadAliasRates(), loadRates()])
}

const rates = ref<ChannelRate[]>([])
const ratesLoading = ref(false)
const channels = ref<{ id: string; name: string }[]>([])
const channelsLoaded = ref(false)
const rateFilter = ref('')
const showDisabledRates = ref(false)
const rateDialogOpen = ref(false)
const editingRate = ref<ChannelRate | null>(null)

const channelFilterOptions = computed(() => [
  { value: '', label: t('billing.rate.allChannels') },
  ...channels.value.map((c) => ({ value: c.id, label: c.name }))
])

const visibleRates = computed(() =>
  showDisabledRates.value
    ? rates.value
    : rates.value.filter((r) => r.status === 'active')
)

function rateChannelLabel(rate: ChannelRate): string {
  if (!rate.channelId) return t('billing.global')
  return rate.channelName || rate.channelId
}

function rateModelLabel(rate: ChannelRate): string {
  if (!rate.channelId) return t('billing.rate.globalDefault')
  return rate.upstreamModel || t('billing.rate.channelDefault')
}

async function loadChannels(): Promise<void> {
  if (channelsLoaded.value) return
  try {
    const res = await api.get<{ channels: { id: string; name: string }[] }>('/api/channels')
    channels.value = res.channels.map((c) => ({ id: c.id, name: c.name }))
    channelsLoaded.value = true
  } catch {
    // 渠道列表只用于筛选与新建时的下拉；失败不阻塞费率列表
    channels.value = []
  }
}

watch(rateFilter, () => {
  void loadRates()
})

async function loadRates(): Promise<void> {
  ratesLoading.value = true
  try {
    await loadChannels()
    const qs = rateFilter.value ? '?channelId=' + encodeURIComponent(rateFilter.value) : ''
    const res = await api.get<{ rates: ChannelRate[] }>('/api/billing/rates' + qs)
    rates.value = res.rates
  } catch (err) {
    toastError(err, t('billing.rate.loadFailed'))
  } finally {
    ratesLoading.value = false
  }
}

function openRateDialog(rate?: ChannelRate): void {
  editingRate.value = rate ?? null
  rateDialogOpen.value = true
}

async function setRateStatus(rate: ChannelRate, status: 'active' | 'disabled'): Promise<void> {
  try {
    await api.put('/api/billing/rates', {
      channelId: rate.channelId,
      upstreamModel: rate.upstreamModel,
      currency: rate.currency,
      inputPerMtok: rate.inputPerMtok,
      outputPerMtok: rate.outputPerMtok,
      perRequest: rate.perRequest,
      status,
      note: rate.note
    })
    toast.success(
      status === 'disabled' ? t('billing.rate.disabledToast') : t('billing.rate.enabledToast')
    )
    await loadRates()
  } catch (err) {
    toastError(err, t('billing.rate.saveFailed'))
  }
}

async function removeRate(rate: ChannelRate): Promise<void> {
  if (!confirm(t('billing.rate.deleteConfirm', { target: rateChannelLabel(rate) + ' · ' + rateModelLabel(rate) }))) {
    return
  }
  // 后端只有 PUT upsert、没有物理删除 —— 删除语义落成「停用」，
  // 停用的费率不再参与 resolveRate 的解析。
  await setRateStatus(rate, 'disabled')
}

/* ---------------------------------------------------------------- 限额模板 */

const templates = ref<LimitTemplate[]>([])
const templatesLoading = ref(false)
const orgUsers = ref<User[]>([])
const orgUsersLoaded = ref(false)
const templateDialogOpen = ref(false)
const editingTemplate = ref<LimitTemplate | null>(null)
const templateSaving = ref(false)

const templateForm = reactive({
  name: '',
  ownerUserId: '',
  status: 'active' as 'active' | 'disabled',
  note: '',
  rules: [] as { window: BillingWindow; threshold: string }[]
})

const windowOptions = computed(() => [
  { value: '5h', label: windowLabel('5h') },
  { value: '1d', label: windowLabel('1d') },
  { value: '7d', label: windowLabel('7d') },
  { value: '30d', label: windowLabel('30d') },
  { value: '1w', label: windowLabel('1w') },
  { value: '1mo', label: windowLabel('1mo') }
])

const ownerOptions = computed(() => [
  { value: '', label: t('billing.template.ownerGlobal') },
  ...orgUsers.value.map((u) => ({
    value: u.id,
    label: u.username + (u.displayName && u.displayName !== u.username ? ' · ' + u.displayName : '')
  }))
])

async function loadOrgUsers(): Promise<void> {
  if (orgUsersLoaded.value) return
  try {
    const res = await api.get<{ users: User[] }>('/api/users')
    orgUsers.value = res.users
    orgUsersLoaded.value = true
  } catch {
    orgUsers.value = []
  }
}

async function loadTemplates(): Promise<void> {
  templatesLoading.value = true
  try {
    await loadOrgUsers()
    const res = await api.get<{ templates: LimitTemplate[] }>('/api/billing/templates')
    templates.value = res.templates
  } catch (err) {
    toastError(err, t('billing.template.loadFailed'))
  } finally {
    templatesLoading.value = false
  }
}

function addRule(): void {
  const used = new Set(templateForm.rules.map((r) => r.window))
  const next = (windowOptions.value.map((o) => o.value) as BillingWindow[]).find((w) => !used.has(w))
  templateForm.rules.push({ window: next ?? '5h', threshold: '0' })
}

function removeRule(index: number): void {
  templateForm.rules.splice(index, 1)
}

function openTemplateDialog(template?: LimitTemplate): void {
  editingTemplate.value = template ?? null
  Object.assign(templateForm, {
    name: template?.name ?? '',
    ownerUserId: template?.ownerUserId ?? '',
    status: template?.status ?? 'active',
    note: template?.note ?? '',
    rules: template
      ? template.rules.map((r) => ({ window: r.window, threshold: String(r.threshold) }))
      : [{ window: '5h' as BillingWindow, threshold: '0' }]
  })
  templateDialogOpen.value = true
}

async function saveTemplate(): Promise<void> {
  if (!templateForm.name.trim()) {
    toast.error(t('billing.template.nameRequired'))
    return
  }
  const windows = templateForm.rules.map((r) => r.window)
  if (new Set(windows).size !== windows.length) {
    toast.error(t('billing.template.duplicateWindow'))
    return
  }
  const rules: { window: BillingWindow; threshold: number }[] = []
  for (const rule of templateForm.rules) {
    const threshold = Number(rule.threshold)
    if (!Number.isFinite(threshold) || threshold < 0) {
      toast.error(t('billing.template.thresholdInvalid'))
      return
    }
    rules.push({ window: rule.window, threshold })
  }

  templateSaving.value = true
  try {
    const body = {
      name: templateForm.name.trim(),
      ownerUserId: templateForm.ownerUserId || null,
      status: templateForm.status,
      note: templateForm.note.trim(),
      rules
    }
    if (editingTemplate.value) {
      await api.patch('/api/billing/templates/' + editingTemplate.value.id, body)
      toast.success(t('billing.template.updated'))
    } else {
      await api.post('/api/billing/templates', body)
      toast.success(t('billing.template.created'))
    }
    templateDialogOpen.value = false
    await loadTemplates()
  } catch (err) {
    toastError(err, t('billing.template.saveFailed'))
  } finally {
    templateSaving.value = false
  }
}

async function removeTemplate(template: LimitTemplate): Promise<void> {
  if (!confirm(t('billing.template.deleteConfirm', { name: template.name }))) return
  try {
    await api.del('/api/billing/templates/' + template.id)
    toast.success(t('billing.template.deleted'))
    await loadTemplates()
  } catch (err) {
    toastError(err, t('billing.template.deleteFailed'))
  }
}

/* ---------------------------------------------------------------- 套用模板 */

const applyTemplate = ref<LimitTemplate | null>(null)
const applySelected = ref<string[]>([])
const applySearch = ref('')
const applying = ref(false)

const applyCandidates = computed(() => {
  const q = applySearch.value.trim().toLowerCase()
  return q
    ? orgUsers.value.filter(
        (u) =>
          u.username.toLowerCase().includes(q) ||
          (u.displayName ?? '').toLowerCase().includes(q)
      )
    : orgUsers.value
})

function openApply(template: LimitTemplate): void {
  applyTemplate.value = template
  applySelected.value = []
  applySearch.value = ''
  void loadOrgUsers()
}

function toggleApplyUser(id: string): void {
  const i = applySelected.value.indexOf(id)
  if (i >= 0) applySelected.value.splice(i, 1)
  else applySelected.value.push(id)
}

function closeApply(): void {
  applyTemplate.value = null
  applySelected.value = []
  applySearch.value = ''
}

async function submitApply(): Promise<void> {
  const template = applyTemplate.value
  if (!template) return
  if (applySelected.value.length === 0) {
    toast.error(t('billing.template.applyNoSelection'))
    return
  }
  if (
    !confirm(
      t('billing.template.applyOverwrite', {
        n: applySelected.value.length,
        name: template.name
      })
    )
  ) {
    return
  }

  applying.value = true
  try {
    // 覆盖语义：每个用户的模板集合被替换为「仅这个模板」
    for (const userId of applySelected.value) {
      await api.post('/api/billing/users/' + userId + '/templates', {
        templateIds: [template.id]
      })
    }
    toast.success(t('billing.template.applied', { n: applySelected.value.length }))
    closeApply()
  } catch (err) {
    toastError(err, t('billing.template.applyFailed'))
  } finally {
    applying.value = false
  }
}

/* ---------------------------------------------------------------- 用户余额 */

const billingUsers = ref<BillingUserRow[]>([])
const billingUsersLoading = ref(false)
const userQuery = ref('')
const billingDialogUser = ref<{ userId: string; username: string; displayName: string } | null>(null)

let searchTimer: ReturnType<typeof setTimeout> | null = null

async function loadBillingUsers(): Promise<void> {
  billingUsersLoading.value = true
  try {
    const qs = userQuery.value.trim()
      ? '?q=' + encodeURIComponent(userQuery.value.trim())
      : ''
    const res = await api.get<{ users: BillingUserRow[] }>('/api/billing/users' + qs)
    billingUsers.value = res.users
  } catch (err) {
    toastError(err, t('billing.user.loadFailed'))
  } finally {
    billingUsersLoading.value = false
  }
}

watch(userQuery, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadBillingUsers(), 300)
})

function userBalanceText(row: BillingUserRow): string {
  const unit = row.unit ?? row.plan?.unit ?? ''
  if (unit === 'money') return formatMoney(row.balance, row.currency ?? row.plan?.currency ?? 'USD')
  if (unit === 'credits') return formatNumber(row.balance) + ' ' + t('billing.unit.credits')
  if (unit === 'tokens') return formatNumber(row.balance) + ' ' + t('billing.unit.tokens')
  return formatNumber(row.balance)
}

function openBillingDialog(row: BillingUserRow): void {
  billingDialogUser.value = {
    userId: row.userId,
    username: row.username,
    displayName: row.displayName || row.username
  }
}

function onBillingSaved(): void {
  billingDialogUser.value = null
  void loadBillingUsers()
}

/* ---------------------------------------------------------------- 流水 */

const ledgerUser = ref<BillingUserRow | null>(null)
const ledger = ref<BalanceLedgerEntry[]>([])
const ledgerLoading = ref(false)
const ledgerError = ref('')

async function openLedger(row: BillingUserRow): Promise<void> {
  ledgerUser.value = row
  ledger.value = []
  ledgerError.value = ''
  ledgerLoading.value = true
  try {
    const res = await api.get<{ ledger: BalanceLedgerEntry[] }>(
      '/api/billing/ledger?userId=' + encodeURIComponent(row.userId) + '&limit=100'
    )
    ledger.value = res.ledger
  } catch (err) {
    ledgerError.value = err instanceof Error ? err.message : t('billing.user.ledgerLoadFailed')
  } finally {
    ledgerLoading.value = false
  }
}

function closeLedger(): void {
  ledgerUser.value = null
  ledger.value = []
  ledgerError.value = ''
}

function ledgerUnit(unit: string): string {
  return unit ? unitLabel(unit) : ''
}

function ledgerDeltaClass(delta: number): string {
  return delta >= 0 ? 'ledger-delta-in' : 'ledger-delta-out'
}

function signedNumber(n: number): string {
  return (n > 0 ? '+' : '') + formatNumber(n)
}

onMounted(() => {
  if (props.user?.role === 'admin') void loadPlans()
})
</script>

<template>
  <div class="view-tabs">
    <div class="view-tabbar">
      <div class="segmented">
        <button
          v-for="opt in tabOptions"
          :key="opt.value"
          :class="{ on: tab === opt.value }"
          @click="selectTab(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <!-- 套餐 -->
    <div v-show="tab === 'plans'" class="card fill-view view-panel">
      <div class="card-head panel-head">
        <div>
          <div class="card-title">{{ t('billing.tabs.plans') }}</div>
          <div class="dim" style="font-size: 12px">{{ t('billing.plan.sub') }}</div>
        </div>
        <div class="row">
          <button class="btn btn-sm" @click="loadPlans">{{ t('common.refresh') }}</button>
          <button class="btn btn-primary btn-sm" @click="openPlanDialog()">
            ＋ {{ t('billing.plan.new') }}
          </button>
        </div>
      </div>

      <div v-if="plansLoading" class="loading">{{ t('common.loading') }}</div>
      <div v-else-if="plans.length === 0" class="empty">{{ t('billing.plan.empty') }}</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('common.name') }}</th>
              <th>{{ t('billing.plan.unit') }}</th>
              <th>{{ t('billing.currency') }}</th>
              <th>{{ t('billing.plan.creditsPerCurrency') }}</th>
              <th>{{ t('common.status') }}</th>
              <th>{{ t('common.note') }}</th>
              <th style="width: 150px">{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in plans" :key="p.id">
              <td style="font-weight: 560">{{ p.name }}</td>
              <td><span class="tag">{{ unitLabel(p.unit) }}</span></td>
              <td class="mono">{{ p.currency }}</td>
              <td class="mono">
                {{ p.unit === 'credits' ? formatNumber(p.creditsPerCurrency) : '—' }}
              </td>
              <td>
                <span class="badge" :class="statusBadgeClass(p.status)">
                  {{ p.status === 'active' ? t('common.enabled') : t('common.disabled') }}
                </span>
              </td>
              <td class="dim" style="max-width: 240px; white-space: normal">{{ p.note || '—' }}</td>
              <td>
                <div class="row">
                  <button class="btn btn-sm" @click="openPlanDialog(p)">{{ t('common.edit') }}</button>
                  <button class="btn btn-sm btn-danger" @click="removePlan(p)">
                    {{ t('common.delete') }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 费率：别名售价（用户扣费） / 渠道成本（成本核算） -->
    <div v-show="tab === 'rates'" class="card fill-view view-panel">
      <div class="card-head panel-head">
        <div>
          <div class="card-title">{{ t('billing.tabs.rates') }}</div>
          <div class="dim" style="font-size: 12px">{{ t('billing.rate.sub') }}</div>
        </div>
      </div>

      <div class="rate-sections">
        <!-- 别名售价 -->
        <section class="rate-section">
          <div class="section-head">
            <div>
              <div class="section-title">{{ t('billing.sectionAliasRates') }}</div>
              <div class="section-sub">{{ t('billing.sectionAliasRatesSub') }}</div>
            </div>
            <div class="row section-tools">
              <input
                v-model="aliasFilter"
                class="filter-input"
                :placeholder="t('billing.aliasRate.searchPlaceholder')"
              />
              <label class="row rates-toggle">
                <input v-model="showDisabledAliasRates" type="checkbox" />
                <span>{{ t('billing.aliasRate.showDisabled') }}</span>
              </label>
              <button class="btn btn-sm" @click="loadAliasRates">{{ t('common.refresh') }}</button>
              <button class="btn btn-primary btn-sm" @click="openAliasRateDialog()">
                ＋ {{ t('billing.aliasRate.new') }}
              </button>
            </div>
          </div>

          <div class="alert alert-info rates-hint">{{ t('billing.aliasRate.sellHint') }}</div>

          <div v-if="aliasRatesLoading" class="loading">{{ t('common.loading') }}</div>
          <div v-else-if="visibleAliasRates.length === 0" class="empty">
            {{ t('billing.aliasRate.empty') }}
          </div>
          <div v-else class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{{ t('billing.aliasRate.alias') }}</th>
                  <th>{{ t('billing.currency') }}</th>
                  <th>{{ t('billing.aliasRate.inputPerMtok') }}</th>
                  <th>{{ t('billing.aliasRate.outputPerMtok') }}</th>
                  <th>{{ t('billing.aliasRate.perRequest') }}</th>
                  <th>{{ t('common.status') }}</th>
                  <th>{{ t('common.note') }}</th>
                  <th style="width: 190px">{{ t('common.actions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in visibleAliasRates" :key="r.id">
                  <td class="mono">{{ r.alias }}</td>
                  <td class="mono">{{ r.currency }}</td>
                  <td class="mono nowrap">{{ formatMoney(r.inputPerMtok, r.currency) }}</td>
                  <td class="mono nowrap">{{ formatMoney(r.outputPerMtok, r.currency) }}</td>
                  <td class="mono nowrap">{{ formatMoney(r.perRequest, r.currency) }}</td>
                  <td>
                    <span class="badge" :class="statusBadgeClass(r.status)">
                      {{ r.status === 'active' ? t('common.enabled') : t('common.disabled') }}
                    </span>
                  </td>
                  <td class="dim" style="max-width: 200px; white-space: normal">
                    {{ r.note || '—' }}
                  </td>
                  <td>
                    <div class="row">
                      <button class="btn btn-sm" @click="openAliasRateDialog(r)">
                        {{ t('common.edit') }}
                      </button>
                      <button
                        v-if="r.status === 'active'"
                        class="btn btn-sm btn-danger"
                        :title="t('billing.aliasRate.deleteHint')"
                        @click="removeAliasRate(r)"
                      >
                        {{ t('common.delete') }}
                      </button>
                      <button
                        v-else
                        class="btn btn-sm"
                        @click="setAliasRateStatus(r, 'active')"
                      >
                        {{ t('billing.aliasRate.enable') }}
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="dim rates-foot">{{ t('billing.aliasRate.deleteHint') }}</div>
        </section>

        <!-- 渠道成本 -->
        <section class="rate-section">
          <div class="section-head">
            <div>
              <div class="section-title">{{ t('billing.sectionChannelRates') }}</div>
              <div class="section-sub">{{ t('billing.sectionChannelRatesSub') }}</div>
            </div>
            <div class="row section-tools">
              <div style="width: 170px">
                <PSelect
                  v-model="rateFilter"
                  :options="channelFilterOptions"
                  size="sm"
                  align="end"
                />
              </div>
              <label class="row rates-toggle">
                <input v-model="showDisabledRates" type="checkbox" />
                <span>{{ t('billing.rate.showDisabled') }}</span>
              </label>
              <button class="btn btn-sm" @click="loadRates">{{ t('common.refresh') }}</button>
              <button class="btn btn-primary btn-sm" @click="openRateDialog()">
                ＋ {{ t('billing.rate.new') }}
              </button>
            </div>
          </div>

          <div class="alert alert-info rates-hint">{{ t('billing.rate.priorityHint') }}</div>

          <div v-if="ratesLoading" class="loading">{{ t('common.loading') }}</div>
          <div v-else-if="visibleRates.length === 0" class="empty">{{ t('billing.rate.empty') }}</div>
          <div v-else class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{{ t('billing.rate.channel') }}</th>
                  <th>{{ t('billing.rate.upstreamModel') }}</th>
                  <th>{{ t('billing.currency') }}</th>
                  <th>{{ t('billing.rate.input') }}</th>
                  <th>{{ t('billing.rate.output') }}</th>
                  <th>{{ t('billing.rate.perRequest') }}</th>
                  <th>{{ t('common.status') }}</th>
                  <th>{{ t('common.note') }}</th>
                  <th style="width: 190px">{{ t('common.actions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in visibleRates" :key="r.id">
                  <td class="nowrap">
                    <span v-if="!r.channelId" class="tag" style="color: var(--accent)">
                      {{ t('billing.global') }}
                    </span>
                    <template v-else>{{ rateChannelLabel(r) }}</template>
                  </td>
                  <td class="mono">{{ rateModelLabel(r) }}</td>
                  <td class="mono">{{ r.currency }}</td>
                  <td class="mono nowrap">{{ formatMoney(r.inputPerMtok, r.currency) }}</td>
                  <td class="mono nowrap">{{ formatMoney(r.outputPerMtok, r.currency) }}</td>
                  <td class="mono nowrap">{{ formatMoney(r.perRequest, r.currency) }}</td>
                  <td>
                    <span class="badge" :class="statusBadgeClass(r.status)">
                      {{ r.status === 'active' ? t('common.enabled') : t('common.disabled') }}
                    </span>
                  </td>
                  <td class="dim" style="max-width: 200px; white-space: normal">
                    {{ r.note || '—' }}
                  </td>
                  <td>
                    <div class="row">
                      <button class="btn btn-sm" @click="openRateDialog(r)">
                        {{ t('common.edit') }}
                      </button>
                      <button
                        v-if="r.status === 'active'"
                        class="btn btn-sm btn-danger"
                        :title="t('billing.rate.deleteHint')"
                        @click="removeRate(r)"
                      >
                        {{ t('common.delete') }}
                      </button>
                      <button v-else class="btn btn-sm" @click="setRateStatus(r, 'active')">
                        {{ t('billing.rate.enable') }}
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="dim rates-foot">{{ t('billing.rate.deleteHint') }}</div>
        </section>
      </div>
    </div>

    <!-- 限额模板 -->
    <div v-show="tab === 'templates'" class="card fill-view view-panel">
      <div class="card-head panel-head">
        <div>
          <div class="card-title">{{ t('billing.tabs.templates') }}</div>
          <div class="dim" style="font-size: 12px">{{ t('billing.template.sub') }}</div>
        </div>
        <div class="row">
          <button class="btn btn-sm" @click="loadTemplates">{{ t('common.refresh') }}</button>
          <button class="btn btn-primary btn-sm" @click="openTemplateDialog()">
            ＋ {{ t('billing.template.new') }}
          </button>
        </div>
      </div>

      <div v-if="templatesLoading" class="loading">{{ t('common.loading') }}</div>
      <div v-else-if="templates.length === 0" class="empty">{{ t('billing.template.empty') }}</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('common.name') }}</th>
              <th>{{ t('billing.template.owner') }}</th>
              <th>{{ t('billing.template.windows') }}</th>
              <th>{{ t('common.status') }}</th>
              <th>{{ t('common.note') }}</th>
              <th style="width: 260px">{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="tp in templates" :key="tp.id">
              <td style="font-weight: 560">{{ tp.name }}</td>
              <td>
                <span v-if="!tp.ownerUserId" class="tag">{{ t('billing.global') }}</span>
                <span v-else class="mono">{{ tp.ownerUsername || tp.ownerUserId }}</span>
              </td>
              <td>
                <span v-if="tp.rules.length === 0" class="dim">{{ t('billing.template.noRules') }}</span>
                <span v-else class="tag-list">
                  <span v-for="r in tp.rules" :key="r.window" class="tag">
                    {{ windowLabel(r.window) }} · {{ formatNumber(r.threshold) }}
                  </span>
                </span>
              </td>
              <td>
                <span class="badge" :class="statusBadgeClass(tp.status)">
                  {{ tp.status === 'active' ? t('common.enabled') : t('common.disabled') }}
                </span>
              </td>
              <td class="dim" style="max-width: 200px; white-space: normal">{{ tp.note || '—' }}</td>
              <td>
                <div class="row">
                  <button class="btn btn-sm" @click="openTemplateDialog(tp)">{{ t('common.edit') }}</button>
                  <button class="btn btn-sm" @click="openApply(tp)">{{ t('billing.template.apply') }}</button>
                  <button class="btn btn-sm btn-danger" @click="removeTemplate(tp)">
                    {{ t('common.delete') }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 用户余额 -->
    <div v-show="tab === 'users'" class="card fill-view view-panel">
      <div class="card-head panel-head">
        <div>
          <div class="card-title">{{ t('billing.tabs.users') }}</div>
          <div class="dim" style="font-size: 12px">{{ t('billing.user.sub') }}</div>
        </div>
        <div class="row">
          <div style="width: 220px">
            <input
              v-model="userQuery"
              :placeholder="t('billing.user.searchPlaceholder')"
              type="search"
            />
          </div>
          <button class="btn btn-sm" @click="loadBillingUsers">{{ t('common.refresh') }}</button>
        </div>
      </div>

      <div v-if="billingUsersLoading" class="loading">{{ t('common.loading') }}</div>
      <div v-else-if="billingUsers.length === 0" class="empty">{{ t('billing.user.empty') }}</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('billing.user.username') }}</th>
              <th>{{ t('billing.user.displayName') }}</th>
              <th>{{ t('billing.user.role') }}</th>
              <th>{{ t('billing.user.plan') }}</th>
              <th>{{ t('billing.user.balance') }}</th>
              <th style="width: 220px">{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in billingUsers" :key="u.userId">
              <td class="mono">{{ u.username }}</td>
              <td>{{ u.displayName || '—' }}</td>
              <td>
                <span class="badge" :class="u.role === 'admin' ? 'badge-info' : 'badge-off'">
                  {{ roleLabel(u.role) }}
                </span>
              </td>
              <td>
                <span v-if="u.planName" class="tag" style="color: var(--accent)">{{ u.planName }}</span>
                <span v-else class="dim">{{ t('billing.user.noPlan') }}</span>
              </td>
              <td class="mono nowrap">{{ userBalanceText(u) }}</td>
              <td>
                <div class="row">
                  <button class="btn btn-sm btn-primary" @click="openBillingDialog(u)">
                    {{ t('billing.action') }}
                  </button>
                  <button class="btn btn-sm" @click="openLedger(u)">
                    {{ t('billing.user.ledger') }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- 套餐弹窗 -->
  <Modal
    v-if="planDialogOpen"
    :title="editingPlan ? t('billing.plan.edit') : t('billing.plan.new')"
    @close="planDialogOpen = false"
  >
    <div class="form-grid">
      <div class="field">
        <label>{{ t('common.name') }}</label>
        <input v-model="planForm.name" maxlength="64" :placeholder="t('billing.plan.namePlaceholder')" />
      </div>

      <div class="form-row">
        <div class="field">
          <label>{{ t('billing.plan.unit') }}</label>
          <PSelect v-model="planForm.unit" :options="unitOptions" />
        </div>
        <div v-if="planForm.unit === 'money'" class="field">
          <label>{{ t('billing.currency') }}</label>
          <PSelect v-model="planForm.currency" :options="currencyOptions" />
        </div>
        <div v-else-if="planForm.unit === 'credits'" class="field">
          <label>{{ t('billing.plan.creditsPerCurrency') }}</label>
          <input v-model="planForm.creditsPerCurrency" type="number" min="0.000001" step="0.000001" />
        </div>
      </div>

      <div class="field">
        <span class="hint">{{ t('billing.plan.unitHint') }}</span>
      </div>

      <div class="form-row">
        <div class="field">
          <label>{{ t('common.status') }}</label>
          <PSelect v-model="planForm.status" :options="statusOptions" />
        </div>
        <div class="field">
          <label>{{ t('common.note') }}</label>
          <input v-model="planForm.note" maxlength="500" :placeholder="t('billing.optional')" />
        </div>
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn" @click="planDialogOpen = false">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" :disabled="planSaving" @click="savePlan">
        {{ planSaving ? t('common.saving') : t('common.save') }}
      </button>
    </div>
  </Modal>

  <!-- 别名售价弹窗 -->
  <BillingAliasRateDialog
    v-if="aliasRateDialogOpen"
    :rate="editingAliasRate"
    @close="aliasRateDialogOpen = false"
    @saved="aliasRateDialogOpen = false; loadAliasRates()"
  />

  <!-- 渠道成本弹窗（与渠道详情页共用） -->
  <BillingRateDialog
    v-if="rateDialogOpen"
    :rate="editingRate"
    :channels="channels"
    @close="rateDialogOpen = false"
    @saved="rateDialogOpen = false; loadRates()"
  />

  <!-- 模板弹窗 -->
  <Modal
    v-if="templateDialogOpen"
    :title="editingTemplate ? t('billing.template.edit') : t('billing.template.new')"
    wide
    @close="templateDialogOpen = false"
  >
    <div class="form-grid">
      <div class="form-row">
        <div class="field">
          <label>{{ t('common.name') }}</label>
          <input v-model="templateForm.name" maxlength="64" :placeholder="t('billing.template.namePlaceholder')" />
        </div>
        <div class="field">
          <label>{{ t('billing.template.owner') }}</label>
          <PSelect v-model="templateForm.ownerUserId" :options="ownerOptions" />
        </div>
      </div>

      <div class="field">
        <div class="row-between">
          <label>{{ t('billing.template.windows') }}</label>
          <button class="btn btn-sm" @click="addRule">＋ {{ t('billing.template.addRule') }}</button>
        </div>
        <div v-if="templateForm.rules.length === 0" class="dim" style="font-size: 12px">
          {{ t('billing.template.noRules') }}
        </div>
        <div v-else class="rule-list">
          <div v-for="(rule, i) in templateForm.rules" :key="i" class="rule-row">
            <div class="field">
              <label>{{ t('billing.template.window') }}</label>
              <PSelect v-model="rule.window" :options="windowOptions" />
            </div>
            <div class="field">
              <label>{{ t('billing.template.threshold') }}</label>
              <input v-model="rule.threshold" type="number" min="0" step="0.000001" />
            </div>
            <button class="btn btn-sm btn-danger" @click="removeRule(i)">
              {{ t('common.delete') }}
            </button>
          </div>
        </div>
        <span class="hint">{{ t('billing.template.thresholdHint') }}</span>
      </div>

      <div class="form-row">
        <div class="field">
          <label>{{ t('common.status') }}</label>
          <PSelect v-model="templateForm.status" :options="statusOptions" />
        </div>
        <div class="field">
          <label>{{ t('common.note') }}</label>
          <input v-model="templateForm.note" maxlength="500" :placeholder="t('billing.optional')" />
        </div>
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn" @click="templateDialogOpen = false">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" :disabled="templateSaving" @click="saveTemplate">
        {{ templateSaving ? t('common.saving') : t('common.save') }}
      </button>
    </div>
  </Modal>

  <!-- 套用到用户 -->
  <Modal
    v-if="applyTemplate"
    :title="t('billing.template.applyTitle') + ' · ' + applyTemplate.name"
    wide
    @close="closeApply"
  >
    <div class="alert alert-info">{{ t('billing.template.applySub') }}</div>
    <div class="alert">{{ t('billing.template.applyOverwriteHint') }}</div>

    <div class="form-grid">
      <div class="field">
        <div class="row-between">
          <label>
            {{ t('billing.template.applySelectUsers') }} ·
            {{ t('billing.template.applySelected', { n: applySelected.length }) }}
          </label>
          <div class="row">
            <button class="btn btn-sm" @click="applySelected = orgUsers.map((u) => u.id)">
              {{ t('billing.template.applySelectAll') }}
            </button>
            <button class="btn btn-sm" @click="applySelected = []">
              {{ t('billing.template.applyClear') }}
            </button>
          </div>
        </div>
        <input v-model="applySearch" :placeholder="t('billing.template.applySearch')" />
        <div class="batch-pick">
          <div
            v-for="u in applyCandidates"
            :key="u.id"
            class="batch-pick-item"
            :class="{ on: applySelected.includes(u.id) }"
            @click="toggleApplyUser(u.id)"
          >
            <span class="batch-pick-box">
              <svg v-if="applySelected.includes(u.id)" width="10" height="10" viewBox="0 0 12 12">
                <path
                  d="M2 6.4 4.6 9 10 3.4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            <span class="mono">{{ u.username }}</span>
            <span class="dim">{{ u.displayName }}</span>
            <span class="spacer" />
            <span class="tag">{{ roleLabel(u.role) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn" @click="closeApply">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" :disabled="applying" @click="submitApply">
        {{ applying ? t('common.saving') : t('common.apply') }}
      </button>
    </div>
  </Modal>

  <!-- 用户计费弹窗（与用户管理页共用） -->
  <BillingUserDialog
    v-if="billingDialogUser"
    :user-id="billingDialogUser.userId"
    :username="billingDialogUser.username"
    :display-name="billingDialogUser.displayName"
    @close="billingDialogUser = null"
    @saved="onBillingSaved"
  />

  <!-- 流水 -->
  <Modal
    v-if="ledgerUser"
    :title="t('billing.user.ledgerTitle') + ' · ' + (ledgerUser.displayName || ledgerUser.username)"
    wide
    @close="closeLedger"
  >
    <div class="dim" style="font-size: 12px; margin-bottom: 10px">
      {{ t('billing.user.ledgerSub') }}
    </div>
    <div v-if="ledgerLoading" class="loading">{{ t('common.loading') }}</div>
    <div v-else-if="ledgerError" class="alert">{{ ledgerError }}</div>
    <div v-else-if="ledger.length === 0" class="empty">{{ t('billing.user.ledgerEmpty') }}</div>
    <div v-else class="table-wrap ledger-table">
      <table>
        <thead>
          <tr>
            <th>{{ t('billing.user.time') }}</th>
            <th>{{ t('billing.user.change') }}</th>
            <th>{{ t('billing.user.balanceAfter') }}</th>
            <th>{{ t('billing.user.reason') }}</th>
            <th>{{ t('common.note') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in ledger" :key="entry.id">
            <td class="dim nowrap">{{ formatTime(entry.createdAt) }}</td>
            <td class="mono nowrap" :class="ledgerDeltaClass(entry.delta)">
              {{ signedNumber(entry.delta) }}
              <span class="dim">{{ ledgerUnit(entry.unit) }}</span>
            </td>
            <td class="mono nowrap">
              {{ formatNumber(entry.balanceAfter) }}
              <span class="dim">{{ ledgerUnit(entry.unit) }}</span>
            </td>
            <td>{{ entry.reason || '—' }}</td>
            <td class="dim" style="max-width: 220px; white-space: normal">{{ entry.note || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="modal-foot">
      <button class="btn" @click="closeLedger">{{ t('common.close') }}</button>
    </div>
  </Modal>
</template>

<style scoped>
.rates-hint {
  margin-bottom: 12px;
}

.rates-toggle {
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  gap: 6px;
}

.rates-toggle input {
  width: auto;
}

.rates-foot {
  font-size: 11.5px;
  margin-top: 8px;
  flex: 0 0 auto;
}

/* 费率页签：别名售价 / 渠道成本两个分区，各自独立滚动 */
.rate-sections {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.rate-section {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.rate-section + .rate-section {
  border-top: 1px solid var(--border);
  padding-top: 16px;
}

.section-head {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.section-title {
  font-weight: 620;
  font-size: 13.5px;
}

.section-sub {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--text-faint);
}

.section-tools {
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.filter-input {
  width: 150px;
}

.rates-hint {
  flex: 0 0 auto;
}

.rate-section > .table-wrap {
  flex: 1 1 auto;
  min-height: 0;
}

.rate-section > .empty,
.rate-section > .loading {
  flex: 1 1 auto;
  display: grid;
  place-items: center;
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

.ledger-delta-in {
  color: var(--success);
}

.ledger-delta-out {
  color: var(--danger);
}

.ledger-table {
  max-height: 50vh;
}

.batch-pick {
  max-height: 260px;
  overflow-y: auto;
}
</style>
