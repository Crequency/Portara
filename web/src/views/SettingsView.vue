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
import { computed, onMounted, ref } from 'vue'
import { api, ApiError, type GatewaySettings } from '../api'
import PCheckbox from '../components/PCheckbox.vue'
import PCombobox from '../components/PCombobox.vue'
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
  usageCacheTtlSec: 300
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
      toast.error(err instanceof ApiError ? err.message : t('settings.loadFailed'))
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
    toast.error(err instanceof ApiError ? err.message : t('settings.saveFailed'))
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
    toast.error(err instanceof ApiError ? err.message : t('settings.saveFailed'))
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
