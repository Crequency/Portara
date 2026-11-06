<script setup lang="ts">
/**
 * 别名售价编辑弹窗（PUT upsert，按 alias 唯一）。
 *
 * 与 BillingRateDialog 的差异：
 *  - 这里的 alias 是复杂均衡规则里的对外模型名，必须已经存在；
 *  - 编辑时 alias 不可改 —— 后端按 alias upsert，改名会变成新增一行，
 *    旧行仍在，容易造成两份售价并存。
 */
import { computed, reactive, ref } from 'vue'
import { api, type AliasRate } from '../api'
import { toastError } from '../error'
import { useI18n } from '../i18n'
import { toast } from '../toast'
import Modal from './Modal.vue'
import PSelect from './PSelect.vue'

const props = withDefaults(
  defineProps<{
    /** 正在编辑的售价；null 表示新建 */
    rate?: AliasRate | null
  }>(),
  { rate: null }
)

const emit = defineEmits<{ (e: 'saved'): void; (e: 'close'): void }>()

const { t } = useI18n()

const isEdit = computed(() => props.rate !== null)

const form = reactive({
  alias: props.rate?.alias ?? '',
  currency: props.rate?.currency ?? 'USD',
  inputPerMtok: String(props.rate?.inputPerMtok ?? 0),
  outputPerMtok: String(props.rate?.outputPerMtok ?? 0),
  perRequest: String(props.rate?.perRequest ?? 0),
  status: props.rate?.status ?? 'active',
  note: props.rate?.note ?? ''
})

const saving = ref(false)

const currencyOptions = computed(() => [
  { value: 'USD', label: 'USD' },
  { value: 'CNY', label: 'CNY' }
])

const statusOptions = computed(() => [
  { value: 'active', label: t('common.enabled') },
  { value: 'disabled', label: t('common.disabled') }
])

function amount(value: string): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

async function submit(): Promise<void> {
  const alias = form.alias.trim()
  if (!alias) {
    toast.error(t('billing.aliasRate.aliasRequired'))
    return
  }

  const input = amount(form.inputPerMtok)
  const output = amount(form.outputPerMtok)
  const perRequest = amount(form.perRequest)
  if (input === null || output === null || perRequest === null) {
    toast.error(t('billing.aliasRate.amountInvalid'))
    return
  }

  saving.value = true
  try {
    await api.put<{ rate: AliasRate }>('/api/billing/alias-rates', {
      alias,
      currency: form.currency,
      inputPerMtok: input,
      outputPerMtok: output,
      perRequest,
      status: form.status,
      note: form.note.trim()
    })
    toast.success(
      isEdit.value ? t('billing.aliasRate.updated') : t('billing.aliasRate.created')
    )
    emit('saved')
  } catch (err) {
    toastError(err, t('billing.aliasRate.saveFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Modal
    :title="isEdit ? t('billing.aliasRate.edit') : t('billing.aliasRate.new')"
    @close="emit('close')"
  >
    <div class="form-grid">
      <div class="field">
        <label>{{ t('billing.aliasRate.alias') }}</label>
        <input
          v-model="form.alias"
          :disabled="isEdit"
          :placeholder="t('billing.aliasRate.aliasPlaceholder')"
          maxlength="128"
        />
        <span class="hint">
          {{ isEdit ? t('billing.aliasRate.aliasLocked') : t('billing.aliasRate.aliasHint') }}
        </span>
      </div>

      <div class="form-row">
        <div class="field">
          <label>{{ t('billing.currency') }}</label>
          <PSelect v-model="form.currency" :options="currencyOptions" />
        </div>
        <div class="field">
          <label>{{ t('common.status') }}</label>
          <PSelect v-model="form.status" :options="statusOptions" />
        </div>
      </div>

      <div class="form-row">
        <div class="field">
          <label>{{ t('billing.aliasRate.inputPerMtok') }}</label>
          <input v-model="form.inputPerMtok" type="number" min="0" step="0.000001" />
        </div>
        <div class="field">
          <label>{{ t('billing.aliasRate.outputPerMtok') }}</label>
          <input v-model="form.outputPerMtok" type="number" min="0" step="0.000001" />
        </div>
      </div>

      <div class="field">
        <label>{{ t('billing.aliasRate.perRequest') }}</label>
        <input v-model="form.perRequest" type="number" min="0" step="0.000001" />
        <span class="hint">{{ t('billing.aliasRate.priceHint') }}</span>
      </div>

      <div class="field">
        <label>{{ t('common.note') }}</label>
        <input v-model="form.note" maxlength="500" :placeholder="t('billing.optional')" />
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn" @click="emit('close')">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" :disabled="saving" @click="submit">
        {{ saving ? t('common.saving') : t('common.save') }}
      </button>
    </div>
  </Modal>
</template>
