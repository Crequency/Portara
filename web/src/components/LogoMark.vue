<script setup lang="ts">
/**
 * Portara 品牌标记（渐变方块 + 白色石门）。
 *
 * 全站只有这一处画 logo —— 此前侧栏与登录页各写了一份同样的 SVG，
 * 改设计时必然漏掉一处。
 */
import { computed } from 'vue'
import { BRAND_GRADIENT_FROM, BRAND_GRADIENT_TO, MARK_PATH, MARK_RATIO, MARK_VIEWBOX } from '../logo'

const props = withDefaults(defineProps<{ size?: number }>(), { size: 30 })

const radius = computed(() => Math.round(props.size * 0.27))
const markSize = computed(() => Math.round(props.size * MARK_RATIO))
const background = `linear-gradient(140deg, ${BRAND_GRADIENT_FROM}, ${BRAND_GRADIENT_TO})`
</script>

<template>
  <div
    class="logo-mark"
    :style="{
      width: size + 'px',
      height: size + 'px',
      borderRadius: radius + 'px',
      background
    }"
    role="img"
    aria-label="Portara"
  >
    <svg :width="markSize" :height="markSize" :viewBox="`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`">
      <path :d="MARK_PATH" fill="#fff" fill-rule="evenodd" />
    </svg>
  </div>
</template>

<style scoped>
.logo-mark {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
}
</style>
