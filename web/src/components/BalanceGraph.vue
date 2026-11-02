<script setup lang="ts">
/**
 * 负载均衡节点图：一个网关模型 id → 多个 (渠道, 上游模型) → 渠道下的账户。
 *
 * 为什么用 SVG 而不是纯 HTML 盒子：连线要"从左边一个点扇出到右边多个点"，
 * 用 CSS 画斜线只能靠伪元素拼三角，节点一多就对不齐；SVG 里坐标是算出来的，
 * 加减目标时布局自然跟着变。
 *
 * 四件事必须一眼看出来：
 *   ① 谁扇出到谁（连线）
 *   ② 各目标的权重（粗细 + 徽章）
 *   ③ 梯队（同 priority 一组；不同梯队用不同虚线与行间距）
 *   ④ 渠道下挂了哪些账户，以及哪个账户的用量窗口已经打满（红色）
 */
import { computed } from 'vue'
import { useI18n } from '../i18n'

/** 账户只取节点图需要的字段，避免把 API DTO 的形状带进图里 */
export interface BalanceAccount {
  id: string
  name: string
  priority: number
  weight: number
  status: string
  usageAdapter: string
  cooldownUntil: string | null
  windowExhausted: boolean
  windowCheckedAt: string | null
}

export interface BalanceTarget {
  channelId: string
  channelName: string
  channelStatus: string
  upstreamModel: string
  priority: number
  weight: number
  /** 渠道级余额适配器：账户没单配时继承它，也是「窗口打满」事实的来源之一 */
  channelUsageAdapter?: string
  /** 该渠道的账户；缺失 = 没拉到账户信息，退回两列形态 */
  accounts?: BalanceAccount[]
}

const props = defineProps<{
  alias: string
  targets: BalanceTarget[]
  /** 每行高度与间距——目标多时靠它撑开画布 */
  hoverable?: boolean
}>()

const { t } = useI18n()

const emit = defineEmits<{ hover: [channelId: string | null]; pick: [channelId: string] }>()

const PAD_Y = 18
const SRC_W = 176
const DST_W = 232
const GAP = 96
const NODE_H = 48
/** 账户节点：两行（名称 / 优先级·权重 + 适配器） */
const ACC_W = 216
const ACC_H = 42
const ACC_GAP = 8
/** 渠道列与账户列之间的水平间距（连线要看得见） */
const ACC_GAP_X = 44
/** 行与行之间的空隙；无账户时 NODE_H + ROW_GAP 正好等于原来的行高 62 */
const ROW_GAP = 14

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

/** 账户按 priority 升序；同优先级按名称，保证刷新不跳 */
function accountsOf(tg: BalanceTarget): BalanceAccount[] {
  return (tg.accounts ?? [])
    .slice()
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
}

/** 账户自己没配适配器时继承渠道的；两者都没有 = 拿不到窗口事实 */
function adapterOf(tg: BalanceTarget, account: BalanceAccount): string {
  return account.usageAdapter || tg.channelUsageAdapter || ''
}

/** 只有「确实检查过」的账户才可能被打满：没有适配器也没有检查时间就不标红 */
function isExhausted(tg: BalanceTarget, account: BalanceAccount): boolean {
  if (!account.windowExhausted) return false
  return Boolean(adapterOf(tg, account) || account.windowCheckedAt)
}

function isCooling(account: BalanceAccount): boolean {
  if (!account.cooldownUntil) return false
  const until = new Date(account.cooldownUntil).getTime()
  return Number.isFinite(until) && until > Date.now()
}

const hasAccounts = computed(() => flat.value.some((tg) => accountsOf(tg).length > 0))
const hasExhausted = computed(() =>
  flat.value.some((tg) => accountsOf(tg).some((account) => isExhausted(tg, account)))
)
const hasCooling = computed(() =>
  flat.value.some((tg) => accountsOf(tg).some((account) => isCooling(account)))
)

/**
 * 每个目标的整行高度与节点坐标。
 *
 * 无账户时与老版完全一致（48 + 14 = 62）；有账户时按账户数把行撑高，
 * 渠道节点与账户列都在各自内容区里垂直居中。
 */
const positions = computed(() => {
  let cursor = PAD_Y
  return flat.value.map((tg) => {
    const accounts = accountsOf(tg)
    const n = accounts.length
    const accountsH = n > 0 ? n * ACC_H + (n - 1) * ACC_GAP : 0
    const contentH = Math.max(NODE_H, accountsH)
    const rowH = contentH + ROW_GAP
    const top = cursor
    const nodeY = top + (contentH - NODE_H) / 2
    const accTop = top + (contentH - accountsH) / 2
    cursor += rowH
    return { tg, top, nodeY, accTop, accounts, rowH }
  })
})

const height = computed(
  () => PAD_Y * 2 + positions.value.reduce((sum, p) => sum + p.rowH, 0)
)

/*
 * 画布宽度按内容算，不写死。
 * 定长 viewBox 会把图挤在左侧：内容只用到 504，剩下 256 全是空白，
 * 再被 100% 宽度等比放大就成了右侧一大片空。
 */
const width = computed(
  () => SRC_W + GAP + DST_W + (hasAccounts.value ? ACC_GAP_X + ACC_W : 0) + 8
)

const srcX = 0
const srcY = computed(() => height.value / 2 - 26)
const dstX = computed(() => srcX + SRC_W + GAP)
const accX = computed(() => dstX.value + DST_W + ACC_GAP_X)

/** 连线：从源节点右缘中点 → 渠道节点左缘中点，三次贝塞尔 */
function pathFor(nodeY: number): string {
  const x1 = srcX + SRC_W
  const y1 = srcY.value + 26
  const x2 = dstX.value
  const y2 = nodeY + 24
  const mx = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
}

/** 渠道 → 账户：细实线，从渠道右缘扇形散开 */
function accountPath(nodeY: number, accY: number): string {
  const x1 = dstX.value + DST_W
  const y1 = nodeY + 24
  const x2 = accX.value
  const y2 = accY + ACC_H / 2
  return `M ${x1} ${y1} L ${x2} ${y2}`
}

/** 权重映射成线宽：1 → 2.2px，10 及以上 → 6px（视觉上能区分但不夸张） */
function strokeFor(weight: number): number {
  const w = Number.isFinite(weight) && weight >= 1 ? weight : 1
  return Math.min(6, 1.6 + Math.log2(w + 1) * 1.6)
}

const tiers = computed(() => rows.value.length)

function truncated(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function accountNameOf(account: BalanceAccount, exhausted: boolean): string {
  return truncated(account.name, exhausted ? 12 : 16)
}

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
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      :class="{ 'has-accounts': hasAccounts }"
      role="img"
      :aria-label="alias"
    >
      <!-- 连线先画，节点压在上面 -->
      <g>
        <path
          v-for="p in positions"
          :key="'l' + p.tg.channelId + p.tg.upstreamModel"
          :d="pathFor(p.nodeY)"
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
        :transform="`translate(${dstX}, ${p.nodeY})`"
        class="bal-target"
        @mouseenter="onEnter(p.tg.channelId)"
        @mouseleave="onLeave"
        @click="emit('pick', p.tg.channelId)"
      >
        <rect
          class="bal-node bal-node-dst"
          :class="{ 'is-off': p.tg.channelStatus !== 'active' }"
          :width="DST_W"
          :height="NODE_H"
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

      <!-- 账户列：渠道 → 账户细实线 + 账户节点（窗口打满时整节点标红） -->
      <g
        v-for="p in positions"
        :key="'acc' + p.tg.channelId + p.tg.upstreamModel"
      >
        <template v-for="(account, i) in p.accounts" :key="account.id">
          <path
            class="bal-acct-edge"
            :class="{ 'is-bad': isExhausted(p.tg, account) }"
            :d="accountPath(p.nodeY, p.accTop + i * (ACC_H + ACC_GAP))"
          />
          <g
            class="bal-account"
            :class="{
              'is-exhausted': isExhausted(p.tg, account),
              'is-cooling': !isExhausted(p.tg, account) && isCooling(account),
              'is-off': account.status !== 'active'
            }"
            :transform="`translate(${accX}, ${p.accTop + i * (ACC_H + ACC_GAP)})`"
          >
            <rect class="bal-node bal-node-acc" :width="ACC_W" :height="ACC_H" rx="7" />
            <circle class="bal-acc-dot" cx="10" cy="14" r="3" />
            <text class="bal-acc-name" x="18" :y="18">
              {{ accountNameOf(account, isExhausted(p.tg, account)) }}
            </text>
            <text class="bal-acc-meta" x="10" :y="33">
              P{{ account.priority }} · W{{ account.weight }}
            </text>
            <!-- 额度适配器：有这个标记才说明「窗口」事实是检查过的 -->
            <text
              v-if="adapterOf(p.tg, account)"
              class="bal-acc-adapter"
              :x="ACC_W - 10"
              :y="33"
              text-anchor="end"
            >
              {{ truncated(adapterOf(p.tg, account), 14) }}
            </text>
            <text
              v-if="isExhausted(p.tg, account)"
              class="bal-acc-warn"
              :x="ACC_W - 10"
              :y="18"
              text-anchor="end"
            >
              {{ t('balance.windowExhaustedTag') }}
            </text>
            <title>
              {{ account.name }} · P{{ account.priority }} / W{{ account.weight
              }}{{ isExhausted(p.tg, account) ? ' · ' + t('balance.windowExhaustedTag') : '' }}
            </title>
          </g>
        </template>
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
      <span v-if="hasAccounts" class="bal-legend-item">
        <i class="bal-legend-account" />
        {{ t('balance.legendAccounts') }}
      </span>
      <span v-if="hasExhausted" class="bal-legend-item is-danger">
        <i class="bal-legend-dot" />
        {{ t('balance.legendExhausted') }}
      </span>
      <span v-if="hasCooling" class="bal-legend-item">
        <i class="bal-legend-ring" />
        {{ t('balance.legendCooling') }}
      </span>
      <span class="dim">{{ t('balance.targets', { n: targets.length }) }}</span>
    </div>
  </div>
</template>
