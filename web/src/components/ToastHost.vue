<script setup lang="ts">
import { useI18n } from '../i18n'
import type { Toast } from '../toast'
import { dismissToast, toasts } from '../toast'

const { t } = useI18n()
</script>

<template>
  <!--
    提示层默认**不吃点击**（pointer-events: none）：只有 .toast 本体可点。

    原因见 styles.css 里 .toast-host 的注释 —— 之前整块 fixed 容器（z-index 300）
    盖住渠道详情右侧的「添加账户 / 编辑 / 删除」按钮，提示存在的几秒内点下去没反应，
    看起来就是"按钮时好时坏"。点一下提示即可关闭。
  -->
  <div class="toast-host" role="status" aria-live="polite">
    <div
      v-for="item in (toasts as Toast[])"
      :key="item.id"
      class="toast"
      :class="`toast-${item.kind}`"
      role="button"
      tabindex="0"
      :title="t('common.close')"
      @click="dismissToast(item.id)"
      @keydown.enter="dismissToast(item.id)"
    >
      {{ item.message }}
    </div>
  </div>
</template>
