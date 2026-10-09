import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ZodType } from 'zod'

/** 取客户端 IP（尊重反代头），日志与审计共用 */
export function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  return c.req.header('x-real-ip') ?? 'unknown'
}

/** 控制面统一错误对象 */
export class ApiError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function badRequest(message: string, extra?: Record<string, unknown>) {
  return new ApiError(400, 'bad_request', message, extra)
}

export function notFound(message = '资源不存在') {
  return new ApiError(404, 'not_found', message)
}

export function unauthorized(message = '未认证') {
  return new ApiError(401, 'unauthorized', message)
}

export function forbidden(message = '无权限') {
  return new ApiError(403, 'forbidden', message)
}

/** 控制面错误响应格式：{ error: { code, message } } */
export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  extra?: Record<string, unknown>
) {
  return c.json({ error: { code, message, ...(extra ?? {}) } }, status)
}

/** 数据面错误响应：对齐 OpenAI 的错误结构，便于 SDK 正确抛出异常 */
export function openaiError(
  c: Context,
  status: ContentfulStatusCode,
  message: string,
  type = 'invalid_request_error',
  code: string | null = null
) {
  return c.json({ error: { message, type, param: null, code } }, status)
}

/** 校验请求体，失败抛 400 并带上字段路径 */
export async function parseJson<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw badRequest('请求体不是合法 JSON')
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message
    }))
    throw badRequest('参数校验失败', { issues })
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
    throw badRequest('查询参数校验失败', { issues })
  }
  return result.data
}
