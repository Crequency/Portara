<script setup lang="ts">
import { errorText } from '../error'
import { ref } from 'vue'
import LogoMark from '../components/LogoMark.vue'
import { api, type User } from '../api'
import { useI18n } from '../i18n'

const { t } = useI18n()

const emit = defineEmits<{ (e: 'logged-in', user: User): void }>()

const username = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit(): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    const res = await api.post<{ user: User }>('/api/auth/login', {
      username: username.value.trim(),
      password: password.value
    })
    emit('logged-in', res.user)
  } catch (err) {
    error.value = errorText(err, t('login.failed'))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <form class="login-card" @submit.prevent="submit">
      <div class="login-logo">
        <LogoMark :size="44" />
        <div class="login-title">{{ t('nav.appName') }}</div>
        <div class="login-sub">{{ t('login.subtitle') }}</div>
      </div>

      <div v-if="error" class="alert">{{ error }}</div>

      <div class="form-grid">
        <div class="field">
          <label for="u">{{ t('login.username') }}</label>
          <input id="u" v-model="username" autocomplete="username" placeholder="admin" />
        </div>
        <div class="field">
          <label for="p">{{ t('login.password') }}</label>
          <input
            id="p"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="••••••••"
          />
        </div>
        <button class="btn btn-primary" type="submit" :disabled="busy">
          {{ busy ? t('login.submitting') : t('login.submit') }}
        </button>
      </div>
    </form>
  </div>
</template>
