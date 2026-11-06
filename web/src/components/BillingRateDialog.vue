<script setup lang="ts">
/**
 * 渠道费率编辑弹窗（upsert）。
 *
 * 同一个组件给两处用：
 *  - 计费页「费率」页签：可选全局默认或任意渠道，可填上游模型；
 *  - 渠道详情「计费费率」卡：渠道固定，只编辑该渠道的默认费率或按模型费率。
 *
 * 后端只有 PUT /api/billing/rates（按 channel_id + upstream_model upsert），
 * 没有物理删除 —— 删除语义由列表页用「停用 + 清零」实现，这里不做删除。
 */
import { computed, reactive, ref, watch } from 'vue'
import { api, type ChannelRate } from '../api'
import { toastError } from '../error'
import { useI18n } from '../i18n'
import { toast } from '../toast'
import Modal from './Modal.vue'
import PSelect from './PSelect.vue'

const props = withDefaults(
  defineProps<{
    /** 正在编辑的费率；null 表示新建 */
    rate?: ChannelRate | null
    /** 计费页用：可选的渠道列表；渠道详情页传空数组 */
    channels?: { id: string; name: string }[]
    /** 固定渠道 id（渠道详情页）；空串表示可在弹窗里选全局 / 渠道 */
    fixedChannelId?: string
    fixedChannelName?: string
    /** 上游模型候选（通常来自渠道的模型列表） */
    models?: string[]
    /** 快速设置渠道默认费率：强制 upstreamModel = '' */
    forcedDefault?: boolean
  }>(),
  {
    rate: null,
    channels: () => [],
    fixedChannelId: '',
    fixedChannelName: '',
    models: () => [],
    forcedDefault: false
  }
)

const emit = defineEmits<{ (e: 'saved'): void; (e: 'close'): void }>()

const { t } = useI18n()

const form = reactive({
  channelId: props.fixedChannelId || props.rate?.channelId || '',
  upstreamModel: props.forcedDefault ? '' : (props.rate?.upstreamModel ?? ''),
  currency: props.rate?.currency ?? 'USD',
  inputPerMtok: String(props.rate?.inputPerMtok ?? 0),
  outputPerMtok: String(props.rate?.outputPerMtok ?? 0),
  perRequest: String(props.rate?.perRequest ?? 0),
  status: props.rate?.status ?? 'active',
  note: props.rate?.note ?? ''
})

const saving = ref(false)

const isFixedChannel = computed(() => props.fixedChannelId.length > 0)

const channelOptions = computed(() => [
  { value: '', label: t('billing.rate.globalDefault') },
  ...props.channels.map((c) => ({ value: c.id, label: c.name }))
])

const currencyOptions = computed(() => [
  { value: 'USD', label: 'USD' },
  { value: 'CNY', label: 'CNY' }
])

const statusOptions = computed(() => [
  { value: 'active', label: t('common.enabled') },
  { value: 'disabled', label: t('common.disabled') }
])

const modelOptions = computed(() => [...new Set(props.models)].sort())

const isGlobal = computed(() => form.channelId === '')

/** 切到全局默认时上游模型必须清空（后端也只在有渠道时接受模型） */
watch(
  () => form.channelId,
  (value) => {
    if (value === '') form.upstreamModel = ''
  }
)

function amount(value: string): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

async function submit(): Promise<void> {
  const input = amount(form.inputPerMtok)
  const output = amount(form.outputPerMtok)
  const perRequest = amount(form.perRequest)
  if (input === null || output === null || perRequest === null) {
    toast.error(t('billing.rate.amountInvalid'))
    return
  }

  saving.value = true
  try {
    await api.put('/api/billing/rates', {
      channelId: form.channelId || null,
      upstreamModel: form.channelId ? form.upstreamModel.trim() : '',
      currency: form.currency,
      inputPerMtok: input,
      outputPerMtok: output,
      perRequest,
      status: form.status,
      note: form.note.trim()
    })
    toast.success(
      props.rate ? t('billing.rate.upserted') : t('billing.rate.created')
    )
    emit('saved')
  } catch (err) {
    toastError(err, t('billing.rate.saveFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Modal
    :title="rate ? t('billing.rate.edit') : t('billing.rate.new')"
    @close="emit('close')"
  >
    <div class="form-grid">
      <div class="field">
        <label>{{ t('billing.rate.scope') }}</label>
        <div v-if="isFixedChannel" class="row">
          <span class="tag" style="color: var(--accent)">{{ fixedChannelName || fixedChannelId }}</span>
          <span class="dim" style="font-size: 11.5px">{{ t('billing.rate.channelFixedHint') }}</span>
        </div>
        <PSelect v-else v-model="form.channelId" :options="channelOptions" />
      </div>

      <div class="field">
        <label>{{ t('billing.rate.upstreamModel') }}</label>
        <input
          v-model="form.upstreamModel"
          :disabled="isGlobal"
          :list="modelOptions.length ? 'billing-rate-models' : undefined"
          :placeholder="isGlobal ? t('billing.rate.upstreamModelGlobal') : t('billing.rate.upstreamModelPlaceholder')"
          maxlength="200"
        />
        <datalist v-if="modelOptions.length" id="billing-rate-models">
          <option v-for="m in modelOptions" :key="m" :value="m" />
        </datalist>
        <span class="hint">{{ t('billing.rate.upstreamModelHint') }}</span>
      </div>

      <div class="form-row">
        <div class="field">
          <label>{{ t('billing.rate.currency') }}</label>
          <PSelect v-model="form.currency" :options="currencyOptions" />
        </div>
        <div class="field">
          <label>{{ t('common.status') }}</label>
          <PSelect v-model="form.status" :options="statusOptions" />
        </div>
      </div>

      <div class="form-row">
        <div class="field">
          <label>{{ t('billing.rate.input') }}</label>
          <input v-model="form.inputPerMtok" type="number" min="0" step="0.000001" />
        </div>
        <div class="field">
          <label>{{ t('billing.rate.output') }}</label>
          <input v-model="form.outputPerMtok" type="number" min="0" step="0.000001" />
        </div>
      </div>

      <div class="field">
        <label>{{ t('billing.rate.perRequest') }}</label>
        <input v-model="form.perRequest" type="number" min="0" step="0.000001" />
        <span class="hint">{{ t('billing.rate.priceHint') }}</span>
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
