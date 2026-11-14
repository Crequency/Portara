import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ZodType } from 'zod'
import {
  defaultMessageOf,
  ERROR_MESSAGES,
  fillMessage,
  type ErrorCode
} from './errorCodes.js'

/** 取客户端 IP（尊重反代头），日志与审计共用 */
export function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  return c.req.header('x-real-ip') ?? 'unknown'
}

/**
 * 控制面统一错误对象。
 *
 * `code` 是**给调用方看的稳定标识**，前端据此查 i18n 得到本地化文案；
 * `message` 是服务端生成的中文默认消息（日志与兜底用），不再直接决定用户看到什么。
 * `params` 用于模板化消息里的 {name} 占位（前端插值用）。
 */
export class ApiError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: ErrorCode | string,
    message: string,
    public readonly extra?: Record<string, unknown>,
    public readonly params?: Record<string, string | number>
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 由 code 造一个错误（message 取默认中文，params 用于占位） */
function apiErrorOf(
  status: ContentfulStatusCode,
  code: ErrorCode,
  extra?: Record<string, unknown>,
  params?: Record<string, string | number>
): ApiError {
  return new ApiError(status, code, fillMessage(defaultMessageOf(code), params), extra, params)
}

export function badRequest(
  code: ErrorCode = 'bad_request',
  extra?: Record<string, unknown>,
  params?: Record<string, string | number>
) {
  return apiErrorOf(400, code, extra, params)
}

export function notFound(
  code: ErrorCode = 'not_found',
  params?: Record<string, string | number>
) {
  return apiErrorOf(404, code, undefined, params)
}

export function unauthorized(
  code: ErrorCode = 'unauthorized',
  params?: Record<string, string | number>
) {
  return apiErrorOf(401, code, undefined, params)
}

export function forbidden(
  code: ErrorCode = 'forbidden',
  params?: Record<string, string | number>
) {
  return apiErrorOf(403, code, undefined, params)
}

/** 控制面错误响应格式：{ error: { code, message } } */
export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
  params?: Record<string, string | number>
) {
  return c.json(
    { error: { code, message, ...(params === undefined ? {} : { params }), ...(extra ?? {}) } },
    status
  )
}

/**
 * 数据面错误响应：对齐 OpenAI 的错误结构，便于 SDK 正确抛出异常。
 *
 * extra 用于少数需要携带结构化信息的错误（如计费 429 带 window / resetAt），
 * 会并入 error 对象，**不**改变既有字段。
 */
export function openaiError(
  c: Context,
  status: ContentfulStatusCode,
  messageOrCode: string,
  type = 'invalid_request_error',
  code: string | null = null,
  extra: Record<string, unknown> = {},
  params?: Record<string, string | number>
) {
  /*
   * 第三个参数既可以是**错误码**，也可以是运行时拼出来的具体描述（例如带上游原文）。
   * 传错误码时按默认消息模板生成中文 message，并把它当作 code 的兜底；
   * 传任意描述时原样使用 —— 动态信息没法本地化，硬套模板只会丢信息。
   */
  const known = Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, messageOrCode)
  const message = known
    ? fillMessage(ERROR_MESSAGES[messageOrCode as ErrorCode], params)
    : messageOrCode
  return c.json(
    { error: { message, type, param: null, code: code ?? (known ? messageOrCode : null), ...extra } },
    status
  )
}

/** 校验请求体，失败抛 400 并带上字段路径 */
export async function parseJson<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw badRequest('invalid_json_body')
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message
    }))
    throw badRequest('invalid_params', { issues })
  }
  return result.data
}

export function parseQuery<T>(c: Context, schema: ZodType<T>): T {
  const result = schema.safeParse(c.req.query())
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message
    }))
    throw badRequest('invalid_query_params', { issues })
  }
  return result.data
}
