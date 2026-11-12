<script setup lang="ts">
/**
 * 系统设置（仅管理员）。
 *
 * 页面按「品牌」「网关行为」分组渲染，分组信息来自后端注册表的 group 字段 ——
 * 加一个设置项时这里只需补一条定义，不必重排布局。
 *
 * 原则：**每一项都必须真的生效**。若某个开关只是存进库里不影响行为，
 * 那它就不该出现在这里。
 */
import { toastError } from '../error'
import { computed, onMounted, ref } from 'vue'
import { api, ApiError, type GatewaySettings } from '../api'
import PCheckbox from '../components/PCheckbox.vue'
import PCombobox from '../components/PCombobox.vue'
import PSelect from '../components/PSelect.vue'
import { CLIENT_TZ, timeZoneOptions } from '../time'
import { loadMeta } from '../meta'
import { toast } from '../toast'
import { useI18n } from '../i18n'

const { t } = useI18n()

/** 可搜索的 IANA 时区列表（约 400 项，故用可过滤的下拉） */
const zoneOptions = timeZoneOptions()

const loading = ref(true)
const saving = ref(false)
const purging = ref(false)
const invalid = ref<string[]>([])
/** 无权限：接口 403 时不再渲染表单，避免展示误导性的默认值 */
const denied = ref(false)

/** 库里读到的值（用于判断是否有改动、以及重置） */
const original = ref<GatewaySettings | null>(null)
const form = ref<GatewaySettings>({
  gatewayName: '',
  allowDirectChannelTest: true,
  logRetentionDays: 0,
  defaultChannelTimeoutMs: 120000,
  defaultKeyRpmLimit: 60,
  timezone: 'UTC',
  usageCacheTtlSec: 300,
  usageAutoRefreshSec: 600,
  usageMaxRetries: 3,
  adaptiveRouting: false,
  adaptiveWindowSec: 300,
  adaptiveMinSamples: 10,
  exposeRoutingInfo: false,
  exposeRoutingDetail: 'alias',
  routeInfoWindowMin: 60,
  accountFailureCooldownSec: 3600,
  skipExhaustedWindows: true,
  concurrencyCooldownSec: 20,
  concurrencyQueueTimeoutMs: 30000,
  maxChannelAttempts: 0,
  attemptsPerCandidate: 2,
  maxFailoverPasses: 3,
  failoverBudgetMs: 60000,
  maxTotalAttempts: 24,
  maxAccountAttempts: 0
})

const dirty = computed(() => {
  const o = original.value
  if (!o) return false
  return (Object.keys(form.value) as (keyof GatewaySettings)[]).some(
    (k) => form.value[k] !== o[k]
  )
})

/** 名称留空时的实际展示名 —— 让用户清楚「空」意味着什么 */
const effectiveName = computed(() => form.value.gatewayName.trim() || 'Portara')

/**
 * 路由信息档位。
 *
 * 用 PSelect 而不是原生 select：与页面其他下拉一致（Teleport 弹层、键盘可达）。
 * 选项文案走 i18n，值保持英文枚举 —— 存库与接口都用这套字面量。
 */
const routingDetailOptions = computed(() => [
  { value: 'off', label: t('settings.exposeRoutingDetailOff') },
  { value: 'alias', label: t('settings.exposeRoutingDetailAlias') },
  { value: 'channel', label: t('settings.exposeRoutingDetailChannel') }
])

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await api.get<{ settings: GatewaySettings; invalid: string[] }>(
      '/api/settings'
    )
    // 展开成新对象：避免表单直接改到 original 上导致 dirty 永远为 false
    original.value = { ...res.settings }
    form.value = { ...res.settings }
    invalid.value = res.invalid ?? []
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      denied.value = true
    } else {
      toastError(err, t('settings.loadFailed'))
    }
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (!dirty.value) {
    toast.info(t('settings.noChanges'))
    return
  }
  saving.value = true
  try {
    const patch = (Object.keys(form.value) as (keyof GatewaySettings)[])
      .filter((k) => form.value[k] !== original.value?.[k])
      .map((k) => ({ key: k, value: form.value[k] }))

    const res = await api.patch<{ settings: GatewaySettings }>('/api/settings', {
      settings: patch
    })
    original.value = { ...res.settings }
    form.value = { ...res.settings }
    invalid.value = []
    // 名称可能变了 —— 立刻反映到页面标题与左上角副标题
    await loadMeta()
    toast.success(t('settings.saved'))
  } catch (err) {
    toastError(err, t('settings.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function purgeNow(): Promise<void> {
  if (!window.confirm(t('settings.purgeConfirm'))) return
  purging.value = true
  try {
    const res = await api.post<{ message: string; deleted: number }>(
      '/api/settings/purge-logs'
    )
    toast.success(res.message)
  } catch (err) {
    toastError(err, t('settings.saveFailed'))
  } finally {
    purging.value = false
  }
}

onMounted(load)
</script>

<template>
  <div v-if="loading" class="loading">{{ t('common.loading') }}</div>

  <div v-else-if="denied" class="card">
    <div class="empty">{{ t('nav.noPermission') }}</div>
  </div>

  <div v-else class="stack">
    <div v-if="invalid.length" class="alert">
      {{ t('settings.invalidWarning') }}
      <span class="mono">{{ invalid.join('、') }}</span>
    </div>

    <!-- 品牌 -->
    <div class="card">
      <div class="card-head">
        <div class="card-title">{{ t('settings.brand') }}</div>
        <span class="dim" style="font-size: 12px">{{ t('settings.restartHint') }}</span>
      </div>

      <div class="form-grid">
        <div class="field">
          <label>{{ t('settings.gatewayName') }}</label>
          <input
            v-model="form.gatewayName"
            maxlength="64"
            :placeholder="t('settings.gatewayNamePlaceholder')"
          />
          <span class="hint">{{ t('settings.gatewayNameHint') }}</span>
          <span class="hint">
            当前显示为：<b>{{ effectiveName }}</b>
          </span>
        </div>
      </div>
    </div>

    <!-- 网关行为 -->
    <div class="card">
      <div class="card-head">
        <div class="card-title">{{ t('settings.gateway') }}</div>
      </div>

      <div class="form-grid">
        <div class="field">
          <div class="row-between">
            <label>{{ t('settings.timezone') }}</label>
            <button
              type="button"
              class="btn btn-sm"
              :disabled="form.timezone === CLIENT_TZ"
              @click="form.timezone = CLIENT_TZ"
            >
              {{ t('settings.timezoneUseBrowser') }}
            </button>
          </div>
          <PCombobox v-model="form.timezone" :options="zoneOptions" placeholder="Asia/Shanghai" />
          <span class="hint">{{ t('settings.timezoneHint') }}</span>
          <span class="hint">{{ t('settings.timezoneBrowser', { tz: CLIENT_TZ }) }}</span>
        </div>

        <div class="field">
          <label class="row" style="gap: 8px; display: inline-flex; cursor: pointer">
            <PCheckbox v-model="form.allowDirectChannelTest" />
            {{ t('settings.allowDirectChannelTest') }}
          </label>
          <span class="hint">{{ t('settings.allowDirectChannelTestHint') }}</span>
        </div>

        <div class="field">
          <label>{{ t('settings.logRetentionDays') }}</label>
          <div class="row">
            <input v-model.number="form.logRetentionDays" type="number" min="0" max="3650" />
            <button class="btn btn-sm" :disabled="purging" @click="purgeNow">
              {{ purging ? t('common.loading') : t('settings.purgeNow') }}
            </button>
          </div>
          <span class="hint">{{ t('settings.logRetentionDaysHint') }}</span>
        </div>

        <div class="field">
          <label>{{ t('usage.cacheTtl') }}</label>
          <input v-model.number="form.usageCacheTtlSec" type="number" min="30" max="86400" />
          <span class="hint">{{ t('usage.cacheTtlHint') }}</span>
        </div>

        <div class="field">
          <label>{{ t('usage.autoRefreshSec') }}</label>
          <input
            v-model.number="form.usageAutoRefreshSec"
            type="number"
            min="0"
            max="86400"
            step="60"
          />
          <span class="hint">{{ t('usage.autoRefreshSecHint') }}</span>
        </div>

        <div class="field">
          <label>{{ t('usage.maxRetries') }}</label>
          <input v-model.number="form.usageMaxRetries" type="number" min="0" max="10" />
          <span class="hint">{{ t('usage.maxRetriesHint') }}</span>
        </div>

        <!-- 自适应选路：按近期请求结果重排候选渠道（默认关闭） -->
        <div class="field">
          <label class="row" style="gap: 8px; display: inline-flex; cursor: pointer">
            <PCheckbox v-model="form.adaptiveRouting" />
            {{ t('settings.adaptiveRouting') }}
          </label>
          <span class="hint">{{ t('settings.adaptiveRoutingHint') }}</span>
        </div>

        <div v-if="form.adaptiveRouting" class="grid grid-2">
          <div class="field">
            <label>{{ t('settings.adaptiveWindowSec') }}</label>
            <input
              v-model.number="form.adaptiveWindowSec"
              type="number"
              min="30"
              max="3600"
              step="30"
            />
            <span class="hint">{{ t('settings.adaptiveWindowSecHint') }}</span>
          </div>
          <div class="field">
            <label>{{ t('settings.adaptiveMinSamples') }}</label>
            <input
              v-model.number="form.adaptiveMinSamples"
              type="number"
              min="1"
              max="1000"
            />
            <span class="hint">{{ t('settings.adaptiveMinSamplesHint') }}</span>
          </div>
        </div>

        <!--
          路由信息对外暴露：客户端（如 DSH 插件）据此展示「本次落到哪个渠道/账户」。
          默认关闭 —— 渠道名与上游账户属于拓扑信息，不该默认给所有 API Key 持有者。
        -->
        <div class="field">
          <label class="row" style="gap: 8px; display: inline-flex; cursor: pointer">
            <PCheckbox v-model="form.exposeRoutingInfo" />
            {{ t('settings.exposeRoutingInfo') }}
          </label>
          <span class="hint">{{ t('settings.exposeRoutingInfoHint') }}</span>
        </div>

        <div v-if="form.exposeRoutingInfo" class="grid grid-2">
          <div class="field">
            <label>{{ t('settings.exposeRoutingDetail') }}</label>
            <PSelect v-model="form.exposeRoutingDetail" :options="routingDetailOptions" />
            <span class="hint">{{ t('settings.exposeRoutingDetailHint') }}</span>
          </div>
          <div class="field">
            <label>{{ t('settings.routeInfoWindowMin') }}</label>
            <input
              v-model.number="form.routeInfoWindowMin"
              type="number"
              min="1"
              max="1440"
              step="1"
            />
            <span class="hint">{{ t('settings.routeInfoWindowMinHint') }}</span>
          </div>
        </div>

        <!-- 路由策略：失败冷却 + 打满窗口跳过 -->
        <div class="grid grid-2">
          <div class="field">
            <label>{{ t('settings.accountFailureCooldownSec') }}</label>
            <input
              v-model.number="form.accountFailureCooldownSec"
              type="number"
              min="30"
              max="86400"
              step="60"
            />
            <span class="hint">{{ t('settings.accountFailureCooldownSecHint') }}</span>
          </div>
          <div class="field">
            <label>{{ t('settings.skipExhaustedWindows') }}</label>
            <PCheckbox
              v-model="form.skipExhaustedWindows"
              :label="t('settings.skipExhaustedWindowsLabel')"
            />
            <span class="hint">{{ t('settings.skipExhaustedWindowsHint') }}</span>
          </div>
        </div>

        <div class="grid grid-2">
          <div class="field">
            <label>{{ t('settings.defaultChannelTimeoutMs') }}</label>
            <input
              v-model.number="form.defaultChannelTimeoutMs"
              type="number"
              min="1000"
              max="600000"
              step="1000"
            />
            <span class="hint">{{ t('settings.defaultChannelTimeoutMsHint') }}</span>
          </div>
          <div class="field">
            <label>{{ t('settings.defaultKeyRpmLimit') }}</label>
            <input
              v-model.number="form.defaultKeyRpmLimit"
              type="number"
              min="0"
              max="1000000"
            />
            <span class="hint">{{ t('settings.defaultKeyRpmLimitHint') }}</span>
          </div>
        </div>

        <!-- 路由与并发：撞线冷却 + 满载排队 -->
        <div class="card-title" style="margin-top: 6px">
          {{ t('settings.routingConcurrency') }}
        </div>
        <div class="dim" style="font-size: 12px">
          {{ t('settings.routingConcurrencyHint') }}
        </div>
        <div class="grid grid-2">
          <div class="field">
            <label>{{ t('settings.concurrencyCooldownSec') }}</label>
            <input
              v-model.number="form.concurrencyCooldownSec"
              type="number"
              min="1"
              max="3600"
            />
            <span class="hint">{{ t('settings.concurrencyCooldownSecHint') }}</span>
          </div>
          <div class="field">
            <label>{{ t('settings.concurrencyQueueTimeoutMs') }}</label>
            <input
              v-model.number="form.concurrencyQueueTimeoutMs"
              type="number"
              min="0"
              max="300000"
              step="1000"
            />
            <span class="hint">{{ t('settings.concurrencyQueueTimeoutMsHint') }}</span>
          </div>
        </div>

        <!-- 故障转移与重试：候选数、轮次、总预算 -->
        <div class="card-title" style="margin-top: 6px">
          {{ t('settings.routingFailover') }}
        </div>
        <div class="dim" style="font-size: 12px">
          {{ t('settings.routingFailoverHint') }}
        </div>
        <div class="grid grid-2">
          <div class="field">
            <label>{{ t('settings.maxChannelAttempts') }}</label>
            <input
              v-model.number="form.maxChannelAttempts"
              type="number"
              min="0"
              max="50"
            />
            <span class="hint">{{ t('settings.maxChannelAttemptsHint') }}</span>
          </div>
          <div class="field">
            <label>{{ t('settings.maxAccountAttempts') }}</label>
            <input
              v-model.number="form.maxAccountAttempts"
              type="number"
              min="0"
              max="100"
            />
            <span class="hint">{{ t('settings.maxAccountAttemptsHint') }}</span>
          </div>
          <div class="field">
            <label>{{ t('settings.attemptsPerCandidate') }}</label>
            <input
              v-model.number="form.attemptsPerCandidate"
              type="number"
              min="1"
              max="5"
            />
            <span class="hint">{{ t('settings.attemptsPerCandidateHint') }}</span>
          </div>
          <div class="field">
            <label>{{ t('settings.maxFailoverPasses') }}</label>
            <input
              v-model.number="form.maxFailoverPasses"
              type="number"
              min="1"
              max="10"
            />
            <span class="hint">{{ t('settings.maxFailoverPassesHint') }}</span>
          </div>
          <div class="field">
            <label>{{ t('settings.failoverBudgetMs') }}</label>
            <input
              v-model.number="form.failoverBudgetMs"
              type="number"
              min="0"
              max="600000"
              step="1000"
            />
            <span class="hint">{{ t('settings.failoverBudgetMsHint') }}</span>
          </div>
          <div class="field">
            <label>{{ t('settings.maxTotalAttempts') }}</label>
            <input
              v-model.number="form.maxTotalAttempts"
              type="number"
              min="1"
              max="200"
            />
            <span class="hint">{{ t('settings.maxTotalAttemptsHint') }}</span>
          </div>
        </div>
      </div>

      <div class="row" style="margin-top: 14px; justify-content: flex-end">
        <button class="btn" :disabled="!dirty || saving" @click="load">
          {{ t('common.cancel') }}
        </button>
        <button class="btn btn-primary" :disabled="!dirty || saving" @click="save">
          {{ saving ? t('common.saving') : t('settings.save') }}
        </button>
      </div>
    </div>
  </div>
</template>
