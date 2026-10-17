/**
 * 统一的错误处理。
 *
 * 服务端已经把失败原因写成人话了（`ApiError.message`，例如
 * "该渠道的密钥无法解密，请重新填写"），所以优先用它；
 * 拿不到才退回调用方给的兜底文案 —— 那也比一句笼统的"操作失败"有用。
 *
 * 抽出来是因为这个三元表达式原先散在 31 处，各写一遍必然会有人漏掉
 * `instanceof` 判断，于是把 "[object Object]" 摆到用户面前。
 */
import { ApiError } from './api'
import { toast } from './toast'

/** 异常 → 给人看的文案 */
export function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback
}

/** 异常 → 直接弹提示（最常用的形态） */
export function toastError(err: unknown, fallback: string): void {
  toast.error(errorText(err, fallback))
}
