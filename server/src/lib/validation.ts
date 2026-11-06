import { z } from 'zod'

/**
 * 用户名与口令的**唯一口径**。
 *
 * 用户管理（管理员建号）与公开注册申请必须完全一致 ——
 * 否则会出现「申请时能填、审批建号时才炸」这种最难解释的失败。
 */
export const usernameSchema = z
  .string()
  .trim()
  .min(2, '用户名至少 2 位')
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, '用户名只能包含字母、数字、. _ -')

export const passwordSchema = z.string().min(8, '密码至少 8 位')

export const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '非法 ID')
