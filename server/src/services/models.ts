/**
 * 模型列表 API 的响应解析 —— 纯函数，便于单测。
 *
 * 各家实现的 /models 响应形状不一，这里做归一化：
 *   OpenAI / 大多数兼容实现：{ object: 'list', data: [ { id, object, created, owned_by } ] }
 *   Ollama：                { models: [ { name, model, size, details } ] }
 *   裸数组：                 [ "model-a", "model-b" ] 或 [ { id: ... } ]
 *
 * 上下文长度等**不是 OpenAI 规范字段**，但很多实现会额外返回，因此按已知
 * 字段名逐个探测；同时保留原始对象，避免将来出现新字段时被丢掉。
 */

export interface ModelInfo {
  id: string
  /** 上下文长度（token）。未提供时为 null */
  contextLength: number | null
  /** 最大输出长度（token）。未提供时为 null */
  maxOutputTokens: number | null
  ownedBy: string | null
  created: number | null
  /** 原始对象（截断后的标量字段），供透传与排查 */
  raw: Record<string, unknown>
}

export interface ParseResult {
  models: ModelInfo[]
  /** 响应里认不出的形状说明（非致命） */
  warnings: string[]
}

/** 上下文长度可能出现的字段名（按优先级） */
const CONTEXT_KEYS = [
  'context_length',
  'context_window',
  'max_context_length',
  'max_model_len',
  'max_input_tokens',
  'input_token_limit',
  'n_ctx'
]

/** 最大输出长度可能出现的字段名（按优先级） */
const OUTPUT_KEYS = [
  'max_output_tokens',
  'max_completion_tokens',
  'output_token_limit',
  'max_tokens_to_sample'
]

/** 原始对象里只保留标量，避免把巨大嵌套结构塞进数据库 */
function scalarOnly(obj: Record<string, unknown>, limit = 40): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let n = 0
  for (const [k, v] of Object.entries(obj)) {
    if (n >= limit) break
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = v
      n++
    }
  }
  return out
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k]
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n) && n > 0) return Math.round(n)
  }
  return null
}

/** 从单个模型对象里提取信息 */
export function extractModelInfo(entry: unknown): ModelInfo | null {
  // 裸字符串
  if (typeof entry === 'string') {
    const id = entry.trim()
    return id ? { id, contextLength: null, maxOutputTokens: null, ownedBy: null, created: null, raw: {} } : null
  }

  if (!entry || typeof entry !== 'object') return null
  const obj = entry as Record<string, unknown>

  // id 的几种叫法：OpenAI 用 id，Ollama 用 name/model
  const idRaw = obj.id ?? obj.name ?? obj.model
  const id = typeof idRaw === 'string' ? idRaw.trim() : ''
  if (!id) return null

  const ownedBy = typeof obj.owned_by === 'string' ? obj.owned_by : null
  const createdRaw = obj.created
  const created = typeof createdRaw === 'number' && Number.isFinite(createdRaw) ? createdRaw : null

  return {
    id,
    contextLength: pickNumber(obj, CONTEXT_KEYS),
    maxOutputTokens: pickNumber(obj, OUTPUT_KEYS),
    ownedBy,
    created,
    raw: scalarOnly(obj)
  }
}

/** 把 /models 的响应归一化为模型信息列表 */
export function parseModelsResponse(body: unknown): ParseResult {
  const warnings: string[] = []
  let list: unknown[] | null = null

  if (Array.isArray(body)) {
    list = body
  } else if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>
    if (Array.isArray(obj.data)) list = obj.data
    else if (Array.isArray(obj.models)) list = obj.models
  }

  if (!list) {
    return { models: [], warnings: ['响应里既没有 data 也没有 models 数组'] }
  }

  const models: ModelInfo[] = []
  const seen = new Set<string>()

  for (const entry of list) {
    const info = extractModelInfo(entry)
    if (!info) {
      warnings.push('有条目缺少可识别的模型 id，已跳过')
      continue
    }
    if (seen.has(info.id)) continue
    seen.add(info.id)
    models.push(info)
  }

  models.sort((a, b) => a.id.localeCompare(b.id))
  return { models, warnings }
}

/** 把模型 id 列表拼接成 /models 请求地址（跟随渠道配置的路径） */
export function buildModelsUrl(baseUrl: string, modelsPath: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const raw = (modelsPath || '/models').trim()
  const path = raw.startsWith('/') ? raw : `/${raw}`
  return `${base}${path}`
}
