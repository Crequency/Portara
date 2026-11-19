<script setup lang="ts">
/**
 * JSON 查看器：语法高亮 + 行号 + 超长降级。
 *
 * 为什么引 highlight.js 而不是自己写正则高亮：JSON 的字符串里会出现 `{`、`:`、
 * `"` 这类字符，手写正则着色几乎必然在某处标错类别。highlight.js 是成熟实现，
 * 这里只引 core + json 语言子集，不会把整个语言包（几百 KB）带进产物。
 *
 * 超长降级：几千行的高亮 DOM 会让弹窗卡住，超过阈值直接退回纯文本 pre ——
 * 排查时看得见内容比「好看」重要。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from '../i18n'
import hljs from 'highlight.js/lib/core'
import json from 'highlight.js/lib/languages/json'

hljs.registerLanguage('json', json)

const { t } = useI18n()

/** 超过这个字符数就不再高亮（约 5k 行 JSON） */
const MAX_HIGHLIGHT_CHARS = 300_000

const props = withDefaults(defineProps<{ value: unknown }>(), {})

/**
 * 上游有时会把**整段 JSON 塞进字符串**（DeepSeek 的 balance 字段就是），
 * 直接 stringify 出来是一行带转义的长字符串，等于没格式化。
 * 这里递归把「看起来是 JSON 的字符串」展开成真实结构。
 *
 * 只在展示层展开，切到「原始」就能看到上游的原样字符串。
 */
function prettify(v: unknown, depth = 0): unknown {
  if (depth > 8) return v
  if (typeof v === 'string') {
    const t = v.trim()
    const looksJson =
      (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))
    if (!looksJson) return v
    try {
      return prettify(JSON.parse(t), depth + 1)
    } catch {
      return v
    }
  }
  if (Array.isArray(v)) return v.map((x) => prettify(x, depth + 1))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = prettify(x, depth + 1)
    }
    return out
  }
  return v
}

/** false = 展开嵌套 JSON 字符串（默认，便于阅读）；true = 上游原样 */
const raw = ref(false)

/** 完整 JSON 文本（2 空格缩进） */
const text = computed(() => {
  try {
    const source = raw.value ? props.value : prettify(props.value)
    return JSON.stringify(source ?? {}, null, 2) ?? '{}'
  } catch {
    // 循环引用等异常值：退化成字符串，至少别白屏
    return String(props.value)
  }
})

const tooLarge = computed(() => text.value.length > MAX_HIGHLIGHT_CHARS)
const html = ref('')
const lineCount = computed(() => text.value.split('\n').length)

function render(): void {
  if (tooLarge.value) {
    html.value = ''
    return
  }
  try {
    html.value = hljs.highlight(text.value, { language: 'json', ignoreIllegals: true }).value
  } catch {
    html.value = ''
  }
}

onMounted(render)
watch(text, render)
</script>

<template>
  <div class="json-viewer">
    <!--
      展开/原始切换：默认展开嵌套的 JSON 字符串（可读性优先），
      但排查时必须能看到上游原样，所以保留一个「原始」开关。
    -->
    <div class="json-toolbar">
      <button
        type="button"
        class="json-mode"
        :class="{ 'is-on': raw }"
        :aria-pressed="raw"
        @click="raw = !raw"
      >
        {{ raw ? t('usage.jsonRaw') : t('usage.jsonExpanded') }}
      </button>
      <span class="json-lines">{{ t('usage.jsonLines', { n: lineCount }) }}</span>
    </div>

    <!-- 超长降级：不渲染高亮 DOM，避免几千行 span 把弹窗拖死 -->
    <pre v-if="tooLarge" class="code-box json-fallback">{{ text }}</pre>
    <div v-else class="json-body">
      <!--
        行号单独一列：用 CSS counter 在 highlight.js 生成的 span 流上算不可靠，
        直接按行数生成一个列更简单，也不会随高亮结构变化而错位。
      -->
      <div class="json-gutter" aria-hidden="true">
        <span v-for="n in lineCount" :key="n">{{ n }}</span>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -- 内容来自 highlight.js 对自身 JSON 文本的着色，不含外部输入 -->
      <pre class="json-code"><code class="hljs language-json" v-html="html" /></pre>
    </div>
  </div>
</template>
