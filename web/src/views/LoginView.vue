<script setup lang="ts">
import { ref } from 'vue'
import { api, ApiError, type User } from '../api'

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
    error.value = err instanceof ApiError ? err.message : '登录失败，请稍后重试'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <form class="login-card" @submit.prevent="submit">
      <div class="login-logo">
        <div class="brand-mark">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path
              d="M7 20V9a5 5 0 0 1 10 0v11"
              stroke="#fff"
              stroke-width="2.2"
              stroke-linecap="round"
            />
          </svg>
        </div>
        <div class="login-title">Portara</div>
        <div class="login-sub">企业级 AI API 网关 · 管理控制台</div>
      </div>

      <div v-if="error" class="alert">{{ error }}</div>

      <div class="form-grid">
        <div class="field">
          <label for="u">用户名</label>
          <input id="u" v-model="username" autocomplete="username" placeholder="admin" />
        </div>
        <div class="field">
          <label for="p">密码</label>
          <input
            id="p"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="••••••••"
          />
        </div>
        <button class="btn btn-primary" type="submit" :disabled="busy">
          {{ busy ? '登录中…' : '登录' }}
        </button>
      </div>
    </form>
  </div>
</template>
