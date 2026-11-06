<script setup lang="ts">
/**
 * 用户计费弹窗：改套餐 + 调整余额。
 *
 * 计费页「用户余额」与用户管理页「计费」操作共用这一份实现，
 * 避免两处各写一遍 PATCH /api/billing/users/:id 的字段拼装与校验。
 *
 * 自己拉取当前套餐 / 余额：用户管理页的 /api/users 不带计费字段，
 * 传进来的只有身份信息；计费页虽然已有整行数据，但再取一次能避免
 * 在别处调整过余额后弹窗显示旧值。
 */
import { computed, onMounted, ref } from 'vue'
import {
  api,
  type BillingPlan,
  type BillingUserRow,
  type BillingWindowUsage
} from '../api'
import { errorText } from '../error'
import { formatMoney, formatNumber } from '../format'
import { useI18n } from '../i18n'
import { toast } from '../toast'
import Modal from './Modal.vue'
import PSelect from './PSelect.vue'

const props = defineProps<{
  userId: string
  username: string
  displayName?: string
}>()

const emit = defineEmits<{ (e: 'saved'): void; (e: 'close'): void }>()

const { t } = useI18n()

const loading = ref(true)
const loadError = ref('')
const plans = ref<BillingPlan[]>([])
const row = ref<BillingUserRow | null>(null)

const planId = ref('')
const delta = ref('')
const reason = ref('')
const note = ref('')
const saving = ref(false)

const planOptions = computed(() => [
  { value: '', label: t('billing.user.noPlanOption') },
  ...plans.value.map((p) => ({
    value: p.id,
    label: p.status === 'disabled' ? p.name + ' · ' + t('common.disabled') : p.name
  }))
])

const currentUnit = computed(() => {
  const r = row.value
  return r?.unit ?? r?.plan?.unit ?? ''
})

const currentCurrency = computed(() => {
  const r = row.value
  return r?.currency ?? r?.plan?.currency ?? 'USD'
})

function unitSuffix(unit: string): string {
  if (unit === 'credits') return t('billing.unit.credits')
  if (unit === 'tokens') return t('billing.unit.tokens')
  return ''
}

const balanceText = computed(() => {
  const r = row.value
  if (!r) return '—'
  if (currentUnit.value === 'money') return formatMoney(r.balance, currentCurrency.value)
  const suffix = unitSuffix(currentUnit.value)
  return formatNumber(r.balance) + (suffix ? ' ' + suffix : '')
})

const windowText = (w: BillingWindowUsage): string => {
  const suffix = unitSuffix(currentUnit.value)
  return (
    t('billing.window.' + w.window) +
    ' · ' +
    formatNumber(w.used) +
    ' / ' +
    formatNumber(w.limit) +
    (suffix ? ' ' + suffix : '')
  )
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const [plansRes, usersRes] = await Promise.all([
      api.get<{ plans: BillingPlan[] }>('/api/billing/plans'),
      api.get<{ users: BillingUserRow[] }>(
        '/api/billing/users?q=' + encodeURIComponent(props.username)
      )
    ])
    plans.value = plansRes.plans
    row.value = usersRes.users.find((u) => u.userId === props.userId) ?? null
    if (!row.value) {
      loadError.value = t('billing.user.loadFailed')
      return
    }
    planId.value = row.value.planId ?? ''
  } catch (err) {
    loadError.value = errorText(err, t('billing.user.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function submit(): Promise<void> {
  const r = row.value
  if (!r) return

  const planChanged = (r.planId ?? '') !== planId.value
  // v-model 在 <input type="number"> 上会把值转成 number，不能直接 .trim()
  const deltaText = String(delta.value ?? '').trim()
  const hasDelta = deltaText.length > 0
  const deltaNum = Number(deltaText)

  if (!planChanged && !hasDelta) {
    toast.error(t('billing.user.noChange'))
    return
  }
  if (hasDelta) {
    if (!Number.isFinite(deltaNum) || deltaNum === 0) {
      toast.error(t('billing.user.deltaInvalid'))
      return
    }
    if (!String(reason.value ?? '').trim()) {
      toast.error(t('billing.user.reasonRequired'))
      return
    }
  }

  saving.value = true
  try {
    const body: {
      planId?: string | null
      adjust?: { delta: number; reason: string; note?: string }
    } = {}
    if (planChanged) body.planId = planId.value || null
    if (hasDelta) {
      const reasonText = String(reason.value ?? '').trim()
      const noteText = String(note.value ?? '').trim()
      body.adjust = {
        delta: deltaNum,
        reason: reasonText,
        ...(noteText ? { note: noteText } : {})
      }
    }
    await api.patch('/api/billing/users/' + props.userId, body)
    toast.success(t('billing.user.saved'))
    emit('saved')
  } catch (err) {
    toast.error(errorText(err, t('billing.user.saveFailed')))
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <Modal
    :title="t('billing.user.dialogTitle') + ' · ' + (displayName || username)"
    wide
    @close="emit('close')"
  >
    <div v-if="loading" class="loading">{{ t('common.loading') }}</div>
    <div v-else-if="loadError" class="alert">{{ loadError }}</div>

    <template v-else-if="row">
      <div class="billing-user-summary">
        <div class="stat">
          <div class="stat-label">{{ t('billing.user.balance') }}</div>
          <div class="stat-value">{{ balanceText }}</div>
          <div class="stat-hint">
            {{ t('billing.user.currentPlan') }}：{{ row.planName || t('billing.user.noPlan') }}
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">{{ t('billing.user.windows') }}</div>
          <div v-if="row.windows.length === 0" class="dim" style="margin-top: 6px; font-size: 12px">
            {{ t('billing.user.noWindows') }}
          </div>
          <div v-else class="tag-list" style="margin-top: 6px">
            <span v-for="w in row.windows" :key="w.window" class="tag">{{ windowText(w) }}</span>
          </div>
        </div>
      </div>

      <div class="form-grid" style="margin-top: 16px">
        <div class="field">
          <label>{{ t('billing.user.plan') }}</label>
          <PSelect v-model="planId" :options="planOptions" />
          <span class="hint">{{ t('billing.user.planHint') }}</span>
        </div>

        <div class="form-row">
          <div class="field">
            <label>{{ t('billing.user.delta') }}</label>
            <input
              v-model="delta"
              type="number"
              step="0.000001"
              :placeholder="t('billing.user.deltaPlaceholder')"
            />
            <span class="hint">{{ t('billing.user.deltaHint') }}</span>
          </div>
          <div class="field">
            <label>{{ t('billing.user.reason') }}</label>
            <input
              v-model="reason"
              maxlength="200"
              :placeholder="t('billing.user.reasonPlaceholder')"
            />
          </div>
        </div>

        <div class="field">
          <label>{{ t('billing.user.note') }}</label>
          <input
            v-model="note"
            maxlength="500"
            :placeholder="t('billing.optional')"
          />
        </div>
      </div>
    </template>

    <div class="modal-foot">
      <button class="btn" @click="emit('close')">{{ t('common.close') }}</button>
      <button
        class="btn btn-primary"
        :disabled="saving || loading || !!loadError"
        @click="submit"
      >
        {{ saving ? t('common.saving') : t('common.save') }}
      </button>
    </div>
  </Modal>
</template>

<style scoped>
.billing-user-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}
@media (max-width: 640px) {
  .billing-user-summary { grid-template-columns: minmax(0, 1fr); }
}
</style>
