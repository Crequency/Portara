<script setup lang="ts">
/**
 * 一条「额度窗口」行：标签 + 用量 + 进度条 + 时间信息。
 *
 * 时间信息的位置**按实测宽度决定**：
 *   - 放得下 → 紧跟百分比，同一行（信息密度最高）
 *   - 放不下 → 移到**进度条下方**（而不是在标签行里硬折行）
 *
 * 为什么要实测而不是固定布局：可用宽度取决于视口、账户数、窗口数、
 * 语言（德法泰文长度差很多）—— 任何写死的规则都会有场景翻车。
 *
 * 实现：放一个 hidden ghost（同样的用量 + 时间，nowrap）量"内联需要多宽"，
 * 与 head 的可用宽度比较；ResizeObserver 跟随容器变化重算。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  /** 用量文本，例如 "2,504 / 50,000 (5%)" */
  usageText: string
  /** 用量文本颜色（配额健康度） */
  usageColor?: string
  /** 是否超限（加粗/警示色由颜色控制，这里只加类） */
  exceeded?: boolean
  /** 进度条百分比 0-100 */
  percent: number
  /** 进度条颜色 */
  barColor: string
  /** 已格式化好的时间文本；为空则不显示 */
  startText?: string
  resetText?: string
}>()

const headRef = ref<HTMLElement | null>(null)
const labelRef = ref<HTMLElement | null>(null)
const ghostRef = ref<HTMLElement | null>(null)

/** true = 时间放到进度条下方 */
const below = ref(false)

const hasTimes = computed(() => Boolean(props.startText || props.resetText))

/** 标签与值区之间的间距，与 CSS 的 gap 保持一致 */
const HEAD_GAP = 8

function measure(): void {
  if (!hasTimes.value) {
    below.value = false
    return
  }
  const head = headRef.value
  const label = labelRef.value
  const ghost = ghostRef.value
  if (!head || !label || !ghost) return
  /*
   * 内联所需宽度：ghost 是 width:max-content + nowrap，量到的就是
   * "如果放同一行要占多宽"。用 getBoundingClientRect 而不是 offsetWidth ——
   * 后者对 inline / 被 flex 拉伸的元素不可靠（实测拿到过整行宽度）。
   */
  const required = ghost.getBoundingClientRect().width
  // 可用宽度 = 行宽 - 标签宽 - 间距
  const available = head.clientWidth - label.getBoundingClientRect().width - HEAD_GAP
  /*
   * 留 12px 安全余量：ghost 与真实布局的差异（字体 hinting、滚动条、
   * 子像素取整）会让"刚好放得下"在真实渲染里反而溢出。
   * 宁可早一点挪到进度条下方，也不要出现横向溢出。
   */
  below.value = required > available - 12
}

let observer: ResizeObserver | null = null
let timers: ReturnType<typeof setTimeout>[] = []

/**
 * 关键的一步：**多量几次**。
 *
 * 首次 measure 时字体可能还没就绪、父容器（卡片网格）也可能尚未定宽，
 * 量出来的可用宽度偏大 → 误判"放得下" → 时间被挤成溢出。
 * 所以挂载后按几个时间点补量，并在字体就绪、尺寸变化、内容变化时重算。
 */
function scheduleMeasure(): void {
  measure()
  timers.push(setTimeout(measure, 60))
  timers.push(setTimeout(measure, 260))
  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => measure())
  }
}

onMounted(() => {
  scheduleMeasure()
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    void document.fonts.ready.then(() => measure())
  }
  if (typeof ResizeObserver !== 'undefined' && headRef.value) {
    observer = new ResizeObserver(() => measure())
    observer.observe(headRef.value)
  }
})

// 内容变化（刷新拿到新数据、时间出现/消失）后重新量
watch(
  () => [props.usageText, props.startText, props.resetText],
  () => nextTick(scheduleMeasure)
)

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  timers.forEach(clearTimeout)
  timers = []
})
</script>

<template>
  <div class="win-row">
    <div ref="headRef" class="win-head">
      <span ref="labelRef" class="win-label">
        <slot name="label" />
      </span>
      <span class="win-values">
        <span
          class="win-usage"
          :class="{ 'delta-slow': exceeded }"
          :style="{ color: usageColor }"
        >
          {{ usageText }}
        </span>
        <span v-if="!below && hasTimes" class="win-times">
          <span v-if="startText">{{ startText }}</span>
          <span v-if="resetText">{{ resetText }}</span>
        </span>
      </span>
    </div>

    <div class="win-track">
      <div
        :style="{
          width: percent + '%',
          height: '100%',
          background: barColor,
          borderRadius: '3px'
        }"
      />
    </div>

    <!-- 放不下时才出现在进度条下方 -->
    <div v-if="below && hasTimes" class="win-times win-times--below">
      <span v-if="startText">{{ startText }}</span>
      <span v-if="resetText">{{ resetText }}</span>
    </div>

    <!--
      隐藏测量层：与内联形态同样的内容 + nowrap。
      offsetWidth 就是"内联所需宽度"，不参与布局也不可被读屏读到。
    -->
    <span class="win-ghost-wrap" aria-hidden="true">
      <span ref="ghostRef" class="win-ghost">
        <span class="win-usage">{{ usageText }}</span>
        <span class="win-times">
          <span v-if="startText">{{ startText }}</span>
          <span v-if="resetText">{{ resetText }}</span>
        </span>
      </span>
    </span>
  </div>
</template>
