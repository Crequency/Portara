<script setup lang="ts">
/**
 * 公开的注册申请页（未登录可访问，无侧栏）。
 *
 * 视觉与登录页同一套 .login-page / .login-card。
 * 提交成功后**留在本页**显示「等待审批」，不跳转 —— 申请人此时还没有账号，
 * 跳走只会让人以为提交失败。已登录用户由 App.vue 重定向到概览。
 */
import { errorText } from '../error'
import { reactive, ref } from 'vue'
import LogoMark from '../components/LogoMark.vue'
import { api } from '../api'
import { useI18n } from '../i18n'

const { t } = useI18n()

const form = reactive({
  username: '',
  displayName: '',
  password: '',
  confirmPassword: '',
  contact: '',
  note: ''
})

const error = ref('')
const busy = ref(false)
const submitted = ref(false)

function reset(): void {
  Object.assign(form, {
    username: '',
    displayName: '',
    password: '',
    confirmPassword: '',
    contact: '',
    note: ''
  })
  error.value = ''
  submitted.value = false
}

async function submit(): Promise<void> {
  error.value = ''

  if (form.password !== form.confirmPassword) {
    error.value = t('register.passwordMismatch')
    return
  }

  busy.value = true
  try {
    await api.post('/api/register', {
      username: form.username.trim(),
      displayName: form.displayName.trim() || undefined,
      password: form.password,
      contact: form.contact.trim() || undefined,
      note: form.note.trim() || undefined
    })
    submitted.value = true
  } catch (err) {
    error.value = errorText(err, t('register.failed'))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div v-if="submitted" class="login-card">
      <div class="login-logo">
        <LogoMark :size="44" />
        <div class="login-title">{{ t('register.submitted') }}</div>
        <div class="login-sub">{{ t('register.submittedHint') }}</div>
      </div>

      <div class="row" style="justify-content: center; gap: 8px">
        <a class="btn btn-sm" href="#/">{{ t('register.back') }}</a>
        <button type="button" class="btn btn-sm" @click="reset">
          {{ t('register.another') }}
        </button>
      </div>
    </div>

    <form v-else class="login-card" @submit.prevent="submit">
      <div class="login-logo">
        <LogoMark :size="44" />
        <div class="login-title">{{ t('register.title') }}</div>
        <div class="login-sub">{{ t('register.subtitle') }}</div>
      </div>

      <div v-if="error" class="alert">{{ error }}</div>

      <div class="form-grid">
        <div class="field">
          <label for="reg-username">{{ t('register.username') }}</label>
          <input
            id="reg-username"
            v-model="form.username"
            autocomplete="username"
            required
            placeholder="alice"
          />
          <span class="hint">{{ t('register.usernameHint') }}</span>
        </div>

        <div class="field">
          <label for="reg-display">{{ t('register.displayName') }}</label>
          <input
            id="reg-display"
            v-model="form.displayName"
            autocomplete="name"
            :placeholder="t('register.displayNamePlaceholder')"
          />
        </div>

        <div class="field">
          <label for="reg-password">{{ t('register.password') }}</label>
          <input
            id="reg-password"
            v-model="form.password"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
            placeholder="••••••••"
          />
          <span class="hint">{{ t('register.passwordHint') }}</span>
        </div>

        <div class="field">
          <label for="reg-confirm">{{ t('register.confirmPassword') }}</label>
          <input
            id="reg-confirm"
            v-model="form.confirmPassword"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
            placeholder="••••••••"
          />
        </div>

        <div class="field">
          <label for="reg-contact">{{ t('register.contact') }}</label>
          <input
            id="reg-contact"
            v-model="form.contact"
            autocomplete="email"
            :placeholder="t('register.contactHint')"
          />
        </div>

        <div class="field">
          <label for="reg-note">{{ t('register.note') }}</label>
          <textarea
            id="reg-note"
            v-model="form.note"
            rows="3"
            :placeholder="t('register.notePlaceholder')"
          />
        </div>

        <button class="btn btn-primary" type="submit" :disabled="busy">
          {{ busy ? t('register.submitting') : t('register.submit') }}
        </button>

        <a class="login-alt-link" href="#/">{{ t('register.back') }}</a>
      </div>
    </form>
  </div>
</template>
