/**
 * 上游请求的**统一规划**：协议、地址、请求体转换。
 *
 * 为什么要有这个模块：网关路径（/v1/*）与直连测试路径（/api/channels/:id/chat）
 * 都需要「按有效协议决定路径、翻译请求体」这件事。此前两处各写了一遍，
 * 结果网关路径支持了 Anthropic 协议、直连路径没有 —— 用户直连测试 Claude 模型时
 * 请求被当成 OpenAI 格式发到了 /chat/completions，上游回「该走 /messages」。
 *
 * **同一件事只能有一处实现**，否则必然漂移。
 */
import {
  AnthropicToOpenAiStream,
  anthropicToOpenai,
  openaiToAnthropic
} from './anthropic.js'
import { buildUpstreamUrl, withStreamUsage } from './proxy.js'
import {
  resolveBaseUrl,
  resolveProtocol,
  type EffectiveProtocol
} from './routing.js'

export interface ChannelLike {
  base_url?: string
  baseUrl?: string
  protocol?: string
  model_overrides?: Record<string, { protocol?: string; baseUrl?: string }>
}

export interface UpstreamPlan {
  url: string
  bodyText: string | undefined
  protocol: EffectiveProtocol
  warnings: string[]
}

/**
 * 规划一次上游请求。
 *
 * `payload` 应当已经由调用方完成「映射后的模型改写」；
 * 本函数只负责协议相关的部分：路径、请求体翻译、stream_options 注入、URL 拼接。
 */
export function planUpstreamRequest(opts: {
  channel: ChannelLike
  upstreamModel: string
  /** OpenAI 语义下的端点路径，如 /chat/completions */
  restPath: string
  payload: Record<string, unknown> | null
  /** 原始请求体（未改写时优先直通，避免无谓的重新序列化） */
  rawBody: string
  /** 是否注入 stream_options.include_usage（仅 OpenAI 协议有意义） */
  injectStreamUsage: boolean
  /**
   * 调用方是否已改写 payload（例如模型映射把 model 换成了上游真实模型）。
   *
   * 这个信号必须显式传：否则「改写过的 payload」会因为没触发其他重新序列化条件
   * 而被丢弃，导致**把原始模型名发给了上游**。
   */
  payloadRewritten?: boolean
}): UpstreamPlan {
  const protocol = resolveProtocol(opts.channel, opts.upstreamModel)
  const base =
    resolveBaseUrl(opts.channel, opts.upstreamModel) || opts.channel.base_url || ''

  const warnings: string[] = []
  let payload = opts.payload
  let path = opts.restPath
  let needsReserialize = opts.payloadRewritten === true

  if (protocol === 'anthropic') {
    const translated = openaiToAnthropic(payload ?? {}, opts.upstreamModel)
    payload = translated.body
    warnings.push(...translated.warnings)
    path = '/messages'
    needsReserialize = true
  } else if (opts.injectStreamUsage && payload) {
    const patched = withStreamUsage(payload)
    if (patched.injected) {
      payload = patched.payload
      needsReserialize = true
    }
  }

  return {
    url: buildUpstreamUrl(base, path),
    bodyText: needsReserialize && payload ? JSON.stringify(payload) : opts.rawBody || undefined,
    protocol,
    warnings
  }
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Anthropic 的非流式响应 → OpenAI 响应文本 + 用量 */
export function translateAnthropicJson(
  text: string,
  requestedModel: string
): { body: string; usage: TokenUsage } {
  const parsed = JSON.parse(text) as Record<string, unknown>
  const translated = anthropicToOpenai(parsed, requestedModel)
  const u = translated.usage as Record<string, number>
  return {
    body: JSON.stringify(translated),
    usage: {
      promptTokens: u.prompt_tokens ?? 0,
      completionTokens: u.completion_tokens ?? 0,
      totalTokens: u.total_tokens ?? 0
    }
  }
}

/**
 * Anthropic 的流式响应 → OpenAI SSE 流。
 * 流结束时回调用量与首字节耗时，供调用方记账。
 */
export function translateAnthropicStream(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
  onFinish: (usage: TokenUsage, ttftMs: number | null) => void,
  startedAt: number
): ReadableStream<Uint8Array> {
  const translator = new AnthropicToOpenAiStream(requestedModel)
  const encoder = new TextEncoder()
  let ttftMs: number | null = null

  return new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const reader = upstream.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (ttftMs === null) ttftMs = Date.now() - startedAt
          const out = translator.push(value)
          if (out) controller.enqueue(encoder.encode(out))
        }
      } catch {
        /* 中断交由 finally 记账 */
      } finally {
        const tail = translator.finish()
        if (tail) controller.enqueue(encoder.encode(tail))
        controller.close()

        const u = translator.usage
        onFinish(
          {
            promptTokens: u.promptTokens,
            completionTokens: u.completionTokens,
            totalTokens: u.promptTokens + u.completionTokens
          },
          ttftMs
        )
      }
    }
  })
}
