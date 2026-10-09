/**
 * OpenAI ↔ Anthropic 协议翻译。
 *
 * 网关对外只提供 OpenAI 兼容协议；当渠道（或某个模型）配置为 Anthropic 协议时，
 * 请求要翻成 Anthropic 的 /messages 格式，响应再翻回 OpenAI 格式 ——
 * 调用方无需知道上游说的是哪国话。
 *
 * 全部是纯函数 / 纯状态机，不碰 I/O，便于单测。
 */

export interface TranslateResult {
  body: Record<string, unknown>
  warnings: string[]
}

/** Anthropic 要求 max_tokens 必填；OpenAI 允许省略，故需要一个兜底值 */
export const DEFAULT_MAX_TOKENS = 4096

const DROPPED_FIELDS = [
  'n',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'response_format',
  'seed',
  'user',
  'stream_options'
] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** OpenAI 的 content 片段 → Anthropic 的 content block */
function contentPartsToAnthropic(content: unknown, warnings: string[]): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const blocks: unknown[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    const type = part.type

    if (type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text })
      continue
    }

    if (type === 'image_url') {
      const url = isRecord(part.image_url) ? part.image_url.url : undefined
      if (typeof url === 'string' && url.startsWith('data:')) {
        // data:<mime>;base64,<data>
        const m = /^data:([^;]+);base64,(.*)$/s.exec(url)
        if (m) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: m[1], data: m[2] }
          })
          continue
        }
      }
      if (typeof url === 'string') {
        blocks.push({ type: 'image', source: { type: 'url', url } })
        continue
      }
      warnings.push('有一条 image_url 无法识别，已跳过')
      continue
    }

    warnings.push(`不支持的 content 片段类型「${String(type)}」，已跳过`)
  }

  return blocks.length > 0 ? blocks : ''
}

/** OpenAI 的 tools → Anthropic 的 tools */
function toolsToAnthropic(tools: unknown, warnings: string[]): unknown[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined

  const out: unknown[] = []
  for (const t of tools) {
    if (!isRecord(t)) continue
    // 只认 function 型工具；Anthropic 内建工具（如 computer_use）不在此列
    if (t.type !== 'function' || !isRecord(t.function)) {
      warnings.push('有非 function 类型的工具，已跳过')
      continue
    }
    const fn = t.function
    out.push({
      name: fn.name,
      description: fn.description ?? '',
      input_schema: fn.parameters ?? { type: 'object', properties: {} }
    })
  }
  return out.length > 0 ? out : undefined
}

function toolChoiceToAnthropic(choice: unknown): Record<string, unknown> | undefined {
  if (choice === undefined || choice === null) return undefined
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'required') return { type: 'any' }
  if (choice === 'none') return undefined // Anthropic 无对应语义，靠不传工具实现
  if (isRecord(choice) && isRecord(choice.function) && typeof choice.function.name === 'string') {
    return { type: 'tool', name: choice.function.name }
  }
  return undefined
}

/**
 * OpenAI Chat Completions 请求 → Anthropic Messages 请求。
 */
export function openaiToAnthropic(
  payload: Record<string, unknown>,
  upstreamModel: string,
  defaultMaxTokens = DEFAULT_MAX_TOKENS
): TranslateResult {
  const warnings: string[] = []

  // ---- system ----
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : []
  const systemTexts: string[] = []
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = []

  for (const m of rawMessages) {
    if (!isRecord(m)) continue
    const role = m.role

    if (role === 'system' || role === 'developer') {
      if (typeof m.content === 'string') systemTexts.push(m.content)
      else {
        const blocks = contentPartsToAnthropic(m.content, warnings)
        if (typeof blocks === 'string') systemTexts.push(blocks)
      }
      continue
    }

    if (role === 'user') {
      messages.push({ role: 'user', content: contentPartsToAnthropic(m.content, warnings) })
      continue
    }

    if (role === 'assistant') {
      const blocks: unknown[] = []
      if (typeof m.content === 'string' && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content })
      } else if (Array.isArray(m.content)) {
        const converted = contentPartsToAnthropic(m.content, warnings)
        if (Array.isArray(converted)) blocks.push(...converted)
      }
      // 工具调用 → tool_use block
      if (Array.isArray(m.tool_calls)) {
        for (const call of m.tool_calls) {
          if (!isRecord(call) || !isRecord(call.function)) continue
          let input: unknown = {}
          try {
            input = call.function.arguments ? JSON.parse(String(call.function.arguments)) : {}
          } catch {
            warnings.push('有 tool_call 的 arguments 不是合法 JSON，已按空对象处理')
          }
          blocks.push({
            type: 'tool_use',
            id: call.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`,
            name: call.function.name,
            input
          })
        }
      }
      messages.push({ role: 'assistant', content: blocks.length > 0 ? blocks : '' })
      continue
    }

    if (role === 'tool') {
      // OpenAI 的工具结果 → Anthropic 的 user + tool_result
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
      }
      const last = messages[messages.length - 1]
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block)
      } else {
        messages.push({ role: 'user', content: [block] })
      }
      continue
    }

    warnings.push(`不支持的消息角色「${String(role)}」，已跳过`)
  }

  // Anthropic 要求 user/assistant 交替，且首条须为 user；这里合并相邻同角色
  const merged: { role: 'user' | 'assistant'; content: unknown }[] = []
  for (const m of messages) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) {
      const a = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content
      const b = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
      last.content = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]
    } else {
      merged.push({ ...m })
    }
  }
  if (merged.length === 0) {
    merged.push({ role: 'user', content: '' })
    warnings.push('消息为空，已补一条空 user 消息（Anthropic 要求 messages 非空）')
  }
  if (merged[0]!.role !== 'user') {
    merged.unshift({ role: 'user', content: '' })
    warnings.push('首条消息不是 user，已补一条空 user 消息（Anthropic 要求如此）')
  }

  // ---- 组装 ----
  const body: Record<string, unknown> = {
    model: upstreamModel,
    messages: merged,
    max_tokens: typeof payload.max_tokens === 'number' ? payload.max_tokens : defaultMaxTokens
  }
  if (typeof payload.max_tokens !== 'number') {
    warnings.push(`请求未给 max_tokens，已用默认值 ${defaultMaxTokens}（Anthropic 必填）`)
  }

  if (systemTexts.length > 0) body.system = systemTexts.join('\n\n')
  if (typeof payload.temperature === 'number') body.temperature = payload.temperature
  if (typeof payload.top_p === 'number') body.top_p = payload.top_p
  if (payload.stream === true) body.stream = true

  if (typeof payload.stop === 'string') body.stop_sequences = [payload.stop]
  else if (Array.isArray(payload.stop)) body.stop_sequences = payload.stop

  const tools = toolsToAnthropic(payload.tools, warnings)
  if (tools) body.tools = tools
  const toolChoice = toolChoiceToAnthropic(payload.tool_choice)
  if (toolChoice && tools) body.tool_choice = toolChoice

  for (const key of DROPPED_FIELDS) {
    if (payload[key] !== undefined) {
      warnings.push(`字段「${key}」在 Anthropic 协议下无对应语义，已丢弃`)
    }
  }

  return { body, warnings }
}

// ---------------------------------------------------------------- 响应（非流式）

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  pause_turn: 'stop',
  refusal: 'content_filter'
}

function anthropicStopToOpenai(reason: unknown): string {
  if (typeof reason !== 'string') return 'stop'
  return STOP_REASON_MAP[reason] ?? 'stop'
}

/**
 * Anthropic Messages 响应 → OpenAI Chat Completions 响应。
 * `requestedModel` 是调用方请求的模型 id（别名），回给调用方的应是它而非上游模型名。
 */
export function anthropicToOpenai(
  body: Record<string, unknown>,
  requestedModel: string
): Record<string, unknown> {
  const blocks = Array.isArray(body.content) ? body.content : []
  const texts: string[] = []
  const toolCalls: unknown[] = []

  for (const b of blocks) {
    if (!isRecord(b)) continue
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id ?? '',
        type: 'function',
        function: {
          name: b.name ?? '',
          arguments: JSON.stringify(b.input ?? {})
        }
      })
    }
  }

  const usage = isRecord(body.usage) ? body.usage : {}
  const promptTokens = Number(usage.input_tokens ?? 0) || 0
  const completionTokens = Number(usage.output_tokens ?? 0) || 0

  const message: Record<string, unknown> = { role: 'assistant', content: texts.join('') }
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  return {
    id: body.id ?? `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : anthropicStopToOpenai(body.stop_reason)
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  }
}

// ---------------------------------------------------------------- 响应（流式）

/**
 * Anthropic SSE → OpenAI SSE 的流式状态机。
 *
 * Anthropic 的事件（message_start / content_block_delta / message_delta / message_stop）
 * 与 OpenAI 的 chunk 模型不同，必须逐事件转换；原字节无法直通。
 */
export class AnthropicToOpenAiStream {
  private buf = ''
  private readonly decoder = new TextDecoder()
  private id = `chatcmpl-${Date.now()}`
  private created = Math.floor(Date.now() / 1000)
  private sentRole = false
  private promptTokens = 0
  private completionTokens = 0
  private stopReason = 'end_turn'
  private done = false
  private started = false
  private toolIndex = -1

  constructor(private readonly requestedModel: string) {}

  private chunk(delta: Record<string, unknown>, finishReason: string | null): string {
    const payload = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.requestedModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    }
    return `data: ${JSON.stringify(payload)}\n\n`
  }

  private handleEvent(event: string, data: string): string {
    if (data === '[DONE]') return ''
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(data) as Record<string, unknown>
    } catch {
      return ''
    }

    const type = typeof obj.type === 'string' ? obj.type : event
    let out = ''

    switch (type) {
      case 'message_start': {
        this.started = true
        const msg = isRecord(obj.message) ? obj.message : {}
        if (typeof msg.id === 'string') this.id = msg.id
        const usage = isRecord(msg.usage) ? msg.usage : {}
        this.promptTokens = Number(usage.input_tokens ?? 0) || 0
        if (!this.sentRole) {
          out += this.chunk({ role: 'assistant', content: '' }, null)
          this.sentRole = true
        }
        break
      }

      case 'content_block_start': {
        const block = isRecord(obj.content_block) ? obj.content_block : {}
        if (block.type === 'tool_use') {
          this.toolIndex++
          out += this.chunk(
            {
              tool_calls: [
                {
                  index: this.toolIndex,
                  id: block.id ?? '',
                  type: 'function',
                  function: { name: block.name ?? '', arguments: '' }
                }
              ]
            },
            null
          )
        }
        break
      }

      case 'content_block_delta': {
        // 万一上游没发 message_start，收到增量也算「已开始」
        this.started = true
        const delta = isRecord(obj.delta) ? obj.delta : {}
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          out += this.chunk({ content: delta.text }, null)
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          out += this.chunk(
            {
              tool_calls: [
                {
                  index: Math.max(0, this.toolIndex),
                  function: { arguments: delta.partial_json }
                }
              ]
            },
            null
          )
        }
        break
      }

      case 'message_delta': {
        const delta = isRecord(obj.delta) ? obj.delta : {}
        if (typeof delta.stop_reason === 'string') this.stopReason = delta.stop_reason
        const usage = isRecord(obj.usage) ? obj.usage : {}
        if (usage.output_tokens !== undefined) {
          this.completionTokens = Number(usage.output_tokens) || 0
        }
        break
      }

      case 'message_stop': {
        this.done = true
        out += this.chunk({}, anthropicStopToOpenai(this.stopReason))
        out += this.usageChunk()
        out += 'data: [DONE]\n\n'
        break
      }

      case 'error': {
        const err = isRecord(obj.error) ? obj.error : {}
        const message = typeof err.message === 'string' ? err.message : '上游返回错误'
        out += `data: ${JSON.stringify({ error: { message, type: 'api_error' } })}\n\n`
        out += 'data: [DONE]\n\n'
        this.done = true
        break
      }
    }

    return out
  }

  private usageChunk(): string {
    return (
      `data: ${JSON.stringify({
        id: this.id,
        object: 'chat.completion.chunk',
        created: this.created,
        model: this.requestedModel,
        choices: [],
        usage: {
          prompt_tokens: this.promptTokens,
          completion_tokens: this.completionTokens,
          total_tokens: this.promptTokens + this.completionTokens
        }
      })}\n\n`
    )
  }

  /** 喂入 Anthropic 的原始字节，返回应发给调用方的 OpenAI SSE 文本 */
  push(chunk: Uint8Array): string {
    this.buf += this.decoder.decode(chunk, { stream: true })
    let out = ''

    let idx: number
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      out += this.parseBlock(block)
    }
    return out
  }

  private parseBlock(block: string): string {
    let event = ''
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('event:')) event = trimmed.slice(6).trim()
      else if (trimmed.startsWith('data:')) dataLines.push(trimmed.slice(5).trim())
    }
    if (dataLines.length === 0) return ''
    return this.handleEvent(event, dataLines.join('\n'))
  }

  /** 流结束时冲刷缓冲（上游可能没发 [DONE]） */
  finish(): string {
    if (this.buf.trim().length > 0) {
      const rest = this.buf
      this.buf = ''
      const tail = this.parseBlock(rest)
      if (tail.length > 0) return tail
    }
    if (this.done) return ''
    // 一个有效事件都没收到 → 不伪造收尾，否则会把「上游什么都没返回」
    // 伪装成一次正常的空回复，调用方无从分辨
    if (!this.started) return ''
    // 上游确实开始了但没发 message_stop：补上收尾，避免调用方一直等
    this.done = true
    return (
      this.chunk({}, anthropicStopToOpenai(this.stopReason)) +
      this.usageChunk() +
      'data: [DONE]\n\n'
    )
  }

  get usage(): { promptTokens: number; completionTokens: number } {
    return { promptTokens: this.promptTokens, completionTokens: this.completionTokens }
  }
}
