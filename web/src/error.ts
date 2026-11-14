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
import { translate } from './i18n'
import { toast } from './toast'

/**
 * 异常 → 给人看的文案。
 *
 * **后端只保证 `code` 稳定**（见 AGENTS.md 的错误码纪律）：
 * 优先用 `errors.<code>` 取本地化文案，取不到才用服务端的中文默认 message，
 * 再取不到才回退调用方的兜底句。
 *
 * 这样切语言时错误提示也跟着变，而不是永远是中文。
 */
export function errorText(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  if (err.code) {
    const key = 'errors.' + err.code
    const localized = translate(key, err.params)
    // translate 找不到时原样返回 key 名 —— 据此判断是否真的翻译到了
    if (localized !== key) return localized
  }
  return err.message || fallback
}

/** 异常 → 直接弹提示（最常用的形态） */
export function toastError(err: unknown, fallback: string): void {
  toast.error(errorText(err, fallback))
}
