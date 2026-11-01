<script setup lang="ts">
/**
 * 负载均衡子页：一个网关模型 id（alias）→ 多个 (渠道, 上游模型) 目标。
 *
 * 数据层早就是一对多（`model_routes` 一行一个目标），这里补的是**编辑体验**：
 * 之前只能靠「新建映射」弹窗一行行加，或「批量映射」按前缀生成 ——
 * 想调一个别名的目标集合得来回点。现在一张卡片就是一个别名，
 * 卡片里用节点图把"扇出到哪几个渠道"画出来。
 *
 * 另外说明一句：这里改的是**路由**，不是渠道配置。渠道本身仍在「上游渠道」页。
 */
import { computed, onMounted, ref } from 'vue'
import {
  api,
  type Channel,
  type ModelRoute,
  type User
} from '../api'
import BalanceGraph, { type BalanceTarget } from './BalanceGraph.vue'
import Modal from './Modal.vue'
import PCombobox from './PCombobox.vue'
import PInfo from './PInfo.vue'
import PSelect from './PSelect.vue'
import { toastError } from '../error'
import { useI18n } from '../i18n'
import { toast } from '../toast'

const props = defineProps<{ user?: User; channels: Channel[] }>()

const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()

const routes = ref<ModelRoute[]>([])
const loading = ref(true)
const search = ref('')
/**
 * 默认只列「目标数 ≥ 2」的别名。
 *
 * 开发库里有 150+ 条单目标映射（批量映射生成），全画出来既卡又没信息量 ——
 * 单目标本来就没有"均衡"可言。要看全量时打开开关。
 */
const showAll = ref(false)
/** 折叠状态：默认全部折叠，点开才画图（图很贵，一次画 150 张会拖死滚动） */
const expanded = ref<Set<string>>(new Set())
const saving = ref(false)
const isAdmin = computed(() => props.user?.role === 'admin')

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await api.get<{ routes: ModelRoute[] }>('/api/model-routes')
    routes.value = res.routes
  } catch {
    toast.error(t('mapping.loadFailed'))
  } finally {
    loading.value = false
  }
}

/** 按别名分组，并算出该组的优先级梯队数（>1 说明有备用渠道） */
const groups = computed(() => {
  const map = new Map<string, ModelRoute[]>()
  for (const r of routes.value) {
    const list = map.get(r.alias) ?? []
    list.push(r)
    map.set(r.alias, list)
  }
  return [...map.entries()]
    .map(([alias, rows]) => {
      const targets: BalanceTarget[] = rows
        .slice()
        .sort((a, b) => a.priority - b.priority || a.channelName!.localeCompare(b.channelName ?? ''))
        .map((r) => ({
          channelId: r.channelId,
          channelName: r.channelName ?? r.channelId,
          channelStatus: r.channelStatus ?? 'active',
          upstreamModel: r.upstreamModel,
          priority: r.priority,
          weight: r.weight
        }))
      const tierCount = new Set(targets.map((tg) => tg.priority)).size
      return { alias, targets, tierCount }
    })
    .filter((g) => (search.value ? g.alias.toLowerCase().includes(search.value.toLowerCase()) : true))
    .filter((g) => (showAll.value ? true : g.targets.length > 1))
    .sort((a, b) => a.alias.localeCompare(b.alias))
})

const hiddenCount = computed(
  () =>
    [...new Set(routes.value.map((r) => r.alias))].length - groups.value.length
)

function toggle(alias: string): void {
  const next = new Set(expanded.value)
  if (next.has(alias)) next.delete(alias)
  else next.add(alias)
  expanded.value = next
}

function expandAll(): void {
  expanded.value = new Set(groups.value.map((g) => g.alias))
}

function collapseAll(): void {
  expanded.value = new Set()
}

const channelOptions = computed(() =>
  props.channels.map((c) => ({
    value: c.id,
    label: c.name,
    hint: c.status === 'active' ? c.baseUrl : t('common.disabled')
  }))
)

// ---------------------------------------------------------------- 编辑

interface TargetForm {
  channelId: string
  upstreamModel: string
  priority: number
  weight: number
  /** 已存在目标的 id；空 = 新增 */
  id?: string
}

const formOpen = ref(false)
const editingAlias = ref('')
const isNew = ref(false)
const aliasInput = ref('')
const targetForms = ref<TargetForm[]>([])

function openCreate(): void {
  isNew.value = true
  editingAlias.value = ''
  aliasInput.value = ''
  targetForms.value = [
    {
      channelId: props.channels.find((c) => c.status === 'active')?.id ?? '',
      upstreamModel: '',
      priority: 100,
      weight: 1
    }
  ]
  formOpen.value = true
}

function openEdit(alias: string): void {
  const rows = routes.value.filter((r) => r.alias === alias)
  isNew.value = false
  editingAlias.value = alias
  aliasInput.value = alias
  targetForms.value = rows.map((r) => ({
    id: r.id,
    channelId: r.channelId,
    upstreamModel: r.upstreamModel,
    priority: r.priority,
    weight: r.weight
  }))
  formOpen.value = true
}

function addRow(): void {
  targetForms.value.push({
    channelId: props.channels.find((c) => c.status === 'active')?.id ?? '',
    upstreamModel: '',
    priority: targetForms.value[0]?.priority ?? 100,
    weight: 1
  })
}

function removeRow(i: number): void {
  targetForms.value.splice(i, 1)
}

/** 选中渠道后，用它声明的模型做候选（仍允许手输，映射不要求渠道声明过） */
function modelOptions(channelId: string): string[] {
  return props.channels.find((c) => c.id === channelId)?.models ?? []
}

async function submit(): Promise<void> {
  const alias = aliasInput.value.trim()
  if (!alias) {
    toast.error(t('balance.aliasRequired'))
    return
  }
  const rows = targetForms.value.filter((r) => r.channelId && r.upstreamModel.trim())
  if (rows.length === 0) {
    toast.error(t('balance.targetsRequired'))
    return
  }

  saving.value = true
  try {
    if (isNew.value) {
      await api.post('/api/model-routes', {
        alias,
        targets: rows.map((r) => ({
          channelId: r.channelId,
          upstreamModel: r.upstreamModel.trim(),
          priority: Number(r.priority),
          weight: Number(r.weight)
        }))
      })
      toast.success(t('mapping.created'))
    } else {
      /*
       * 编辑要精确到「哪些目标还在、哪些被删了」：
       *   - 保留了 id 的行 → PATCH（可改优先级/权重/上游模型）
       *   - 新行 → POST 追加
       *   - 原列表里有、提交里没有的 → DELETE
       * 不能"先删光再重建"：那会让正在路上的请求瞬间无路可走。
       */
      const keepIds = new Set(rows.map((r) => r.id).filter(Boolean) as string[])
      const before = routes.value.filter((r) => r.alias === editingAlias.value)
      const toDelete = before.filter((r) => !keepIds.has(r.id))
      const toPatch = rows.filter((r) => r.id)
      const toAdd = rows.filter((r) => !r.id)

      for (const r of toDelete) await api.del('/api/model-routes/' + r.id)
      for (const r of toPatch) {
        await api.patch('/api/model-routes/' + r.id, {
          upstreamModel: r.upstreamModel.trim(),
          priority: Number(r.priority),
          weight: Number(r.weight)
        })
      }
      if (toAdd.length > 0) {
        await api.post('/api/model-routes', {
          alias,
          targets: toAdd.map((r) => ({
            channelId: r.channelId,
            upstreamModel: r.upstreamModel.trim(),
            priority: Number(r.priority),
            weight: Number(r.weight)
          }))
        })
      }
      toast.success(t('mapping.saved'))
    }
    formOpen.value = false
    await load()
    emit('changed')
  } catch (err) {
    toastError(err, t('mapping.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function purge(alias: string, n: number): Promise<void> {
  if (!confirm(t('mapping.purgeConfirm', { alias, n }))) return
  try {
    await api.post('/api/model-routes/purge', { alias })
    toast.success(t('mapping.deleted'))
    await load()
    emit('changed')
  } catch (err) {
    toastError(err, t('mapping.deleteFailed'))
  }
}

onMounted(load)

defineExpose({ load })
</script>

<template>
  <div class="stack" style="min-height: 0">
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">{{ t('balance.title') }}</div>
          <div class="dim" style="font-size: 12px">{{ t('balance.sub') }}</div>
        </div>
        <div class="row row-wrap">
          <div style="width: 200px">
            <input v-model="search" :placeholder="t('balance.search')" />
          </div>
          <button class="btn btn-sm" :class="{ 'is-on': showAll }" @click="showAll = !showAll">
            {{ showAll ? t('balance.onlyMulti') : t('balance.showAll') }}
          </button>
          <button class="btn btn-sm" @click="expandAll">{{ t('balance.expandAll') }}</button>
          <button class="btn btn-sm" @click="collapseAll">{{ t('balance.collapseAll') }}</button>
          <button class="btn btn-sm" @click="load">{{ t('common.refresh') }}</button>
          <button v-if="isAdmin" class="btn btn-primary btn-sm" @click="openCreate">
            ＋ {{ t('balance.newAlias') }}
          </button>
        </div>
      </div>

      <div class="alert alert-info" style="margin-bottom: 0">
        <PInfo :text="t('balance.hint')" />
        <span style="margin-left: 6px">{{ t('balance.hint') }}</span>
      </div>
    </div>

    <div v-if="loading" class="loading">{{ t('common.loading') }}</div>
    <div v-else-if="groups.length === 0" class="empty">
      <div>
        {{ routes.length > 0 ? t('balance.filteredEmpty', { n: hiddenCount }) : t('balance.empty') }}
      </div>
      <!-- 空态要给出路：单目标映射被默认过滤时，一键切到「显示全部」 -->
      <div v-if="routes.length > 0 && !showAll" class="row" style="justify-content: center; margin-top: 10px">
        <button class="btn btn-sm" @click="showAll = true">{{ t('balance.showAll') }}</button>
      </div>
    </div>

    <div v-else class="stack">
      <div v-for="g in groups" :key="g.alias" class="card">
        <div class="card-head bal-card-head" @click="toggle(g.alias)">
          <div class="row" style="gap: 8px; min-width: 0">
            <svg
              class="group-chevron"
              :class="{ open: expanded.has(g.alias) }"
              width="12"
              height="12"
              viewBox="0 0 12 12"
              aria-hidden="true"
            >
              <path
                d="M4 2.5 8 6l-4 3.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span class="bal-alias mono">{{ g.alias }}</span>
            <span class="tag">{{ t('balance.targetCount', { n: g.targets.length }) }}</span>
            <span v-if="g.tierCount > 1" class="badge badge-info">
              {{ t('balance.tiers', { n: g.tierCount }) }}
            </span>
          </div>
          <div v-if="isAdmin" class="row" @click.stop>
            <button class="btn btn-sm" @click="openEdit(g.alias)">
              {{ t('common.edit') }}
            </button>
            <button class="btn btn-sm btn-danger" @click="purge(g.alias, g.targets.length)">
              {{ t('common.delete') }}
            </button>
          </div>
        </div>

        <BalanceGraph
          v-if="expanded.has(g.alias)"
          :alias="g.alias"
          :targets="g.targets"
          @pick="() => openEdit(g.alias)"
        />
        <!-- 折叠时给一句话摘要，省得非管理员也被迫展开 -->
        <div v-else class="bal-collapsed dim">
          {{ t('balance.collapsed', { n: g.targets.length }) }}
        </div>
      </div>
    </div>

    <Modal
      v-if="formOpen"
      :title="isNew ? t('balance.newAlias') : t('balance.editAlias')"
      wide
      @close="formOpen = false"
    >
      <div class="form-grid">
        <div class="field">
          <label>{{ t('balance.alias') }}</label>
          <input
            v-model="aliasInput"
            :disabled="!isNew"
            :placeholder="t('balance.aliasPlaceholder')"
          />
          <span class="hint">{{ t('balance.aliasHint') }}</span>
        </div>

        <div class="field">
          <div class="row-between">
            <label>{{ t('balance.targetsLabel') }}</label>
            <button class="btn btn-sm" @click="addRow">＋ {{ t('balance.addTarget') }}</button>
          </div>

          <!-- 列标题必须在行**上方**：放在下面会读成"上一行的小结" -->
          <div class="bal-row-head">
            <span>{{ t('balance.colChannel') }}</span>
            <span>{{ t('balance.colUpstream') }}</span>
            <span>{{ t('channels.priority') }}</span>
            <span>{{ t('channels.weight') }}</span>
            <span />
          </div>

          <div class="stack" style="gap: 8px">
            <div
              v-for="(row, i) in targetForms"
              :key="i"
              class="bal-row"
            >
              <PSelect
                v-model="row.channelId"
                :options="channelOptions"
                :placeholder="t('balance.pickChannel')"
              />
              <!--
                上游模型用可输入下拉（PCombobox）而不是裸 input：
                渠道声明的模型直接可点选，列表不全时仍能手输 ——
                映射不要求渠道声明过该模型（上游可能临时上架）。
              -->
              <PCombobox
                v-model="row.upstreamModel"
                :options="modelOptions(row.channelId)"
                :placeholder="t('balance.upstreamModel')"
              />
              <input
                v-model.number="row.priority"
                type="number"
                min="1"
                class="bal-num"
                :title="t('channels.priorityHint')"
              />
              <input
                v-model.number="row.weight"
                type="number"
                min="1"
                class="bal-num"
                :title="t('channels.weightHint')"
              />
              <button
                class="btn btn-sm btn-danger"
                :disabled="targetForms.length === 1"
                :title="t('balance.removeTarget')"
                @click="removeRow(i)"
              >
                ✕
              </button>
            </div>
          </div>

          <span class="hint">{{ t('balance.targetsHint') }}</span>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="formOpen = false">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" :disabled="saving" @click="submit">
          {{ saving ? t('common.saving') : t('common.save') }}
        </button>
      </div>
    </Modal>
  </div>
</template>
