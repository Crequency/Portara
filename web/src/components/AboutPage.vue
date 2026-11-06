<script setup lang="ts">
/**
 * 全屏「关于」页。
 *
 * 独立于极简路由：打开 / 关闭只切换 open，hash 不变，关掉就回到刚才的页面。
 * Teleport 到 body，避免被侧栏 / 主区的层叠上下文裁掉；z-index 高于 Modal 的 120。
 *
 * 动画分四层：遮罩淡入 → 内容上浮 → 子元素错峰 → 背景两团极淡的品牌色缓慢漂移。
 * 全部在 prefers-reduced-motion: reduce 下关闭（只保留静态显示）。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Github, X } from 'lucide-vue-next'
import LogoMark from './LogoMark.vue'
import { useI18n } from '../i18n'
import { meta } from '../meta'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()

/** 特性卡片的 i18n 前缀，标题 / 说明分别是 <key>Title 与 <key>Body */
const FEATURES = ['routing', 'affinity', 'quota', 'translate'] as const

const closeBtn = ref<HTMLButtonElement | null>(null)

/*
 * body 滚动锁：保存原值而不是写死空串，否则嵌套的 Modal 在关于页关闭时
 * 会把滚动一并还回去。锁与解都只由当前打开状态驱动。
 */
let savedOverflow = ''
let scrollLocked = false

function lockScroll(): void {
  if (scrollLocked) return
  savedOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  scrollLocked = true
}

function unlockScroll(): void {
  if (!scrollLocked) return
  document.body.style.overflow = savedOverflow
  scrollLocked = false
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      lockScroll()
      document.addEventListener('keydown', onKeydown)
      // 打开后焦点进入弹层：落在关闭按钮上，键盘用户可以直接 Esc / Enter 退出
      await nextTick()
      closeBtn.value?.focus()
    } else {
      document.removeEventListener('keydown', onKeydown)
      unlockScroll()
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  unlockScroll()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="about-fade">
      <div
        v-if="open"
        class="about-root"
        role="dialog"
        aria-modal="true"
        :aria-label="t('about.title')"
      >
        <div class="about-bg" aria-hidden="true">
          <span class="about-glow about-glow-a" />
          <span class="about-glow about-glow-b" />
          <span class="about-grid" />
        </div>

        <button
          ref="closeBtn"
          type="button"
          class="about-close"
          :aria-label="t('about.close')"
          @click="emit('close')"
        >
          <X :size="20" :stroke-width="1.8" aria-hidden="true" />
        </button>

        <div class="about-scroll">
          <div class="about-content">
            <header class="about-hero about-item" style="--i: 0">
              <LogoMark :size="84" class="about-logo" />
              <div class="about-heading">
                <div class="about-title-row">
                  <h1 class="about-name">{{ meta.productName }}</h1>
                  <span
                    v-if="meta.version"
                    class="about-version"
                    :title="t('about.versionLabel', { version: meta.version })"
                  >v{{ meta.version }}</span>
                </div>
                <p class="about-tagline">{{ t('about.tagline') }}</p>
              </div>
            </header>

            <p class="about-intro about-item" style="--i: 1">{{ t('about.intro') }}</p>

            <section class="about-features about-item" style="--i: 2">
              <h2 class="about-section-title">{{ t('about.featuresTitle') }}</h2>
              <div class="about-cards">
                <article v-for="key in FEATURES" :key="key" class="about-card">
                  <h3>{{ t('about.' + key + 'Title') }}</h3>
                  <p>{{ t('about.' + key + 'Body') }}</p>
                </article>
              </div>
            </section>

            <div class="about-stack about-item" style="--i: 3">
              <span class="about-stack-label">{{ t('about.stackTitle') }}</span>
              <span class="about-stack-value">{{ t('about.stack') }}</span>
            </div>

            <footer class="about-foot about-item" style="--i: 4">
              <a
                class="about-link"
                href="https://github.com/Crequency/Portara"
                target="_blank"
                rel="noopener"
              >
                <Github :size="15" :stroke-width="1.7" aria-hidden="true" />
                {{ t('about.repository') }}
              </a>
              <span class="about-meta">{{ t('about.license') }} · {{ t('about.licenseName') }}</span>
              <span class="about-copy">{{ t('about.copyright') }}</span>
            </footer>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ---------------------------------------------------------------- 页面 */

.about-root {
  position: fixed;
  inset: 0;
  z-index: 300;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--bg);
  color: var(--text);
}

/* 背景层固定，内容滚动时渐变与网格不动 —— 否则会跟着滚，显得廉价 */
.about-bg {
  position: fixed;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.about-glow {
  position: absolute;
  width: 62vmax;
  height: 62vmax;
  border-radius: 50%;
  filter: blur(6px);
  will-change: transform;
}

.about-glow-a {
  top: -30%;
  left: -20%;
  background: radial-gradient(
    circle at center,
    color-mix(in srgb, var(--accent) 14%, transparent),
    transparent 68%
  );
  animation: about-drift-a 36s ease-in-out infinite alternate;
}

.about-glow-b {
  right: -22%;
  bottom: -34%;
  background: radial-gradient(
    circle at center,
    color-mix(in srgb, var(--accent) 9%, transparent),
    transparent 70%
  );
  animation: about-drift-b 42s ease-in-out infinite alternate;
}

/* 极淡网格：线色只走 --text 的 4%，浅色 / 深色都不会显脏 */
.about-grid {
  position: absolute;
  inset: 0;
  background-image:
    repeating-linear-gradient(
      0deg,
      color-mix(in srgb, var(--text) 4%, transparent) 0 1px,
      transparent 1px 56px
    ),
    repeating-linear-gradient(
      90deg,
      color-mix(in srgb, var(--text) 4%, transparent) 0 1px,
      transparent 1px 56px
    );
  mask-image: radial-gradient(ellipse 90% 80% at 50% 32%, #000 22%, transparent 78%);
  -webkit-mask-image: radial-gradient(ellipse 90% 80% at 50% 32%, #000 22%, transparent 78%);
}

/* ---------------------------------------------------------------- 关闭按钮 */

.about-close {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 2;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 50%;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition:
    background 0.16s ease,
    color 0.16s ease,
    transform 0.16s ease;
}

.about-close:hover {
  background: var(--bg-elev-2);
  color: var(--text);
}

.about-close:active {
  transform: scale(0.94);
}

.about-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* ---------------------------------------------------------------- 内容 */

.about-scroll {
  position: relative;
  z-index: 1;
  min-height: 100%;
}

.about-content {
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  padding: 88px 28px 56px;
  animation: about-rise 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

/* 子元素错峰：总延迟 = 60ms + 序号 × 60ms，介于 60–300ms */
.about-item {
  animation: about-item 0.44s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  animation-delay: calc(60ms + var(--i, 0) * 60ms);
}

.about-hero {
  display: flex;
  align-items: center;
  gap: 22px;
}

.about-logo {
  filter: drop-shadow(0 14px 34px color-mix(in srgb, var(--accent) 30%, transparent));
}

.about-heading {
  min-width: 0;
}

.about-title-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 12px;
}

.about-name {
  margin: 0;
  font-size: clamp(36px, 4.4vw, 52px);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.08;
}

.about-version {
  padding: 3px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent);
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  letter-spacing: 0.02em;
}

.about-tagline {
  margin: 8px 0 0;
  color: var(--text-dim);
  font-size: 13.5px;
}

.about-intro {
  max-width: 720px;
  margin: 42px 0 0;
  color: var(--text-dim);
  font-size: 15px;
  line-height: 1.85;
}

/* ---------------------------------------------------------------- 特性 */

.about-features {
  margin-top: 46px;
}

.about-section-title {
  margin: 0 0 14px;
  color: var(--text-faint);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.about-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.about-card {
  padding: 18px 20px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-elev);
  transition:
    border-color 0.18s ease,
    transform 0.18s ease;
}

.about-card:hover {
  border-color: color-mix(in srgb, var(--accent) 38%, var(--border));
  transform: translateY(-1px);
}

.about-card h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.about-card p {
  margin: 7px 0 0;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.65;
}

/* ---------------------------------------------------------------- 技术栈 */

.about-stack {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin-top: 38px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
}

.about-stack-label {
  color: var(--text-faint);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.about-stack-value {
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 12.5px;
  letter-spacing: 0.01em;
}

/* ---------------------------------------------------------------- 底部 */

.about-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 22px;
  margin-top: 30px;
  color: var(--text-faint);
  font-size: 12.5px;
}

.about-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--accent);
  transition: color 0.16s ease;
}

.about-link:hover {
  color: var(--accent-hover);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.about-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
  border-radius: 4px;
}

.about-copy {
  flex-basis: 100%;
}

/* ---------------------------------------------------------------- 动效 */

@keyframes about-rise {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes about-item {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes about-drift-a {
  from {
    transform: translate3d(-1.5%, -1%, 0) scale(1);
  }
  to {
    transform: translate3d(2%, 2%, 0) scale(1.06);
  }
}

@keyframes about-drift-b {
  from {
    transform: translate3d(1.5%, 1.5%, 0) scale(1.04);
  }
  to {
    transform: translate3d(-2%, -2%, 0) scale(1);
  }
}

/* 打开 / 关闭：页面整体淡入淡出（关闭 180ms 后由 Transition 卸载） */
.about-fade-enter-active {
  transition: opacity 0.24s ease-out;
}

.about-fade-leave-active {
  transition: opacity 0.18s ease-in;
}

.about-fade-enter-from,
.about-fade-leave-to {
  opacity: 0;
}

@media (max-width: 760px) {
  .about-content {
    padding: 76px 18px 44px;
  }

  .about-hero {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }

  .about-cards {
    grid-template-columns: minmax(0, 1fr);
  }

  .about-close {
    top: 12px;
    right: 12px;
  }
}

/* 减少动态偏好：所有动画 / 过渡关闭，只保留静态排版 */
@media (prefers-reduced-motion: reduce) {
  .about-content,
  .about-item,
  .about-glow {
    animation: none !important;
  }

  .about-fade-enter-active,
  .about-fade-leave-active {
    transition: none !important;
  }
}
</style>
