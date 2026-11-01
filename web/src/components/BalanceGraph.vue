<script setup lang="ts">
/**
 * 负载均衡节点图：一个网关模型 id → 多个 (渠道, 上游模型) 目标。
 *
 * 为什么用 SVG 而不是纯 HTML 盒子：连线要"从左边一个点扇出到右边多个点"，
 * 用 CSS 画斜线只能靠伪元素拼三角，节点一多就对不齐；SVG 里坐标是算出来的，
 * 加减目标时布局自然跟着变。
 *
 * 三件事必须一眼看出来：
 *   ① 谁扇出到谁（连线）
 *   ② 各目标的权重（粗细 + 徽章）
 *   ③ 梯队（同 priority 一组；不同梯队用不同虚线与行间距）
 */
import { computed } from 'vue'
import { useI18n } from '../i18n'

export interface BalanceTarget {
  channelId: string
  channelName: string
  channelStatus: string
  upstreamModel: string
  priority: number
  weight: number
}

const props = defineProps<{
  alias: string
  targets: BalanceTarget[]
  /** 每行高度与间距——目标多时靠它撑开画布 */
  hoverable?: boolean
}>()

const { t } = useI18n()

const emit = defineEmits<{ hover: [channelId: string | null]; pick: [channelId: string] }>()

const ROW_H = 62
const PAD_Y = 18
const SRC_W = 176
const DST_W = 232
const GAP = 96

/**
 * 按梯队（priority）排序后分行。
 *
 * 同一梯队内部顺序保持稳定（按渠道名），否则每次刷新节点跳来跳去。
 */
const rows = computed(() => {
  const byTier = new Map<number, BalanceTarget[]>()
  for (const tg of props.targets) {
    const list = byTier.get(tg.priority) ?? []
    list.push(tg)
    byTier.set(tg.priority, list)
  }
  const out: { priority: number; targets: BalanceTarget[] }[] = []
  for (const priority of [...byTier.keys()].sort((a, b) => a - b)) {
    out.push({
      priority,
      targets: [...byTier.get(priority)!].sort((a, b) => a.channelName.localeCompare(b.channelName))
    })
  }
  return out
})

const flat = computed(() => rows.value.flatMap((r) => r.targets))

const height = computed(() => Math.max(1, flat.value.length) * ROW_H + PAD_Y * 2)

/*
 * 画布宽度按内容算，不写死。
 * 定长 viewBox 会把图挤在左侧：内容只用到 504，剩下 256 全是空白，
 * 再被 100% 宽度等比放大就成了右侧一大片空。
 */
const width = computed(() => SRC_W + GAP + DST_W + 8)

const srcX = 0
const srcY = computed(() => height.value / 2 - 26)
const dstX = computed(() => srcX + SRC_W + GAP)

/** 每个目标的纵坐标（按扁平顺序均匀分布） */
const positions = computed(() =>
  flat.value.map((tg, i) => ({
    tg,
    y: PAD_Y + i * ROW_H + ROW_H / 2 - 24
  }))
)

/** 连线：从源节点右缘中点 → 目标节点左缘中点，三次贝塞尔 */
function pathFor(y: number): string {
  const x1 = srcX + SRC_W
  const y1 = srcY.value + 26
  const x2 = dstX.value
  const y2 = y + 24
  const mx = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
}

/** 权重映射成线宽：1 → 2.2px，10 及以上 → 6px（视觉上能区分但不夸张） */
function strokeFor(weight: number): number {
  const w = Number.isFinite(weight) && weight >= 1 ? weight : 1
  return Math.min(6, 1.6 + Math.log2(w + 1) * 1.6)
}

const tiers = computed(() => rows.value.length)

function onEnter(channelId: string): void {
  if (props.hoverable !== false) emit('hover', channelId)
}

function onLeave(): void {
  if (props.hoverable !== false) emit('hover', null)
}
</script>

<template>
  <div class="bal-graph">
    <!--
      不要同时设死 width 与 height：viewBox 比例与显示尺寸不一致时，
      SVG 会按 preserveAspectRatio 把内容居中，两侧留一大片空白。
      只给宽度、让高度由 viewBox 推出来。
    -->
    <svg :viewBox="`0 0 ${width} ${height}`" role="img" :aria-label="alias">
      <!-- 连线先画，节点压在上面 -->
      <g>
        <path
          v-for="p in positions"
          :key="'l' + p.tg.channelId + p.tg.upstreamModel"
          :d="pathFor(p.y)"
          class="bal-edge"
          :class="{ 'is-tier2': p.tg.priority > (rows[0]?.priority ?? 0) }"
          :style="{ strokeWidth: strokeFor(p.tg.weight) }"
          @mouseenter="onEnter(p.tg.channelId)"
          @mouseleave="onLeave"
        />
      </g>

      <!-- 源：网关模型 id -->
      <g :transform="`translate(${srcX}, ${srcY})`">
        <rect class="bal-node bal-node-src" :width="SRC_W" :height="52" rx="9" />
        <text class="bal-src-label" :x="SRC_W / 2" :y="21" text-anchor="middle">
          {{ t('balance.gatewayModel') }}
        </text>
        <!--
          等宽 12.5px 在 176px 宽的节点里大约放得下 20 个字符；
          留 1 个字符余量，否则末字会被节点边框切掉（实测溢出）。
        -->
        <text class="bal-src-id" :x="SRC_W / 2" :y="39" text-anchor="middle">
          {{ alias.length > 20 ? alias.slice(0, 19) + '…' : alias }}
        </text>
        <title>{{ alias }}</title>
      </g>

      <!-- 目标：渠道 + 上游模型 -->
      <g
        v-for="p in positions"
        :key="p.tg.channelId + p.tg.upstreamModel"
        :transform="`translate(${dstX}, ${p.y})`"
        class="bal-target"
        @mouseenter="onEnter(p.tg.channelId)"
        @mouseleave="onLeave"
        @click="emit('pick', p.tg.channelId)"
      >
        <rect
          class="bal-node bal-node-dst"
          :class="{ 'is-off': p.tg.channelStatus !== 'active' }"
          :width="DST_W"
          :height="48"
          rx="9"
        />
        <text class="bal-dst-channel" :x="12" :y="20">
          {{ p.tg.channelName.length > 18 ? p.tg.channelName.slice(0, 17) + '…' : p.tg.channelName }}
        </text>
        <text class="bal-dst-model" :x="12" :y="37">
          {{ p.tg.upstreamModel.length > 26 ? p.tg.upstreamModel.slice(0, 25) + '…' : p.tg.upstreamModel }}
        </text>
        <!-- 权重徽章：粗细之外再给一个数字，别让人靠猜 -->
        <g :transform="`translate(${DST_W - 46}, 14)`">
          <rect class="bal-weight-bg" width="34" height="20" rx="10" />
          <text class="bal-weight" x="17" y="14" text-anchor="middle">×{{ p.tg.weight }}</text>
        </g>
      </g>
    </svg>

    <div class="bal-legend">
      <span class="bal-legend-item">
        <i class="bal-legend-line" />
        {{ t('balance.legendWeight') }}
      </span>
      <span v-if="tiers > 1" class="bal-legend-item">
        <i class="bal-legend-line is-tier2" />
        {{ t('balance.legendFallback') }}
      </span>
      <span class="dim">{{ t('balance.targets', { n: targets.length }) }}</span>
    </div>
  </div>
</template>
