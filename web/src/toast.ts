import { reactive } from 'vue'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
}

let seq = 0

export const toasts = reactive<Toast[]>([])

function push(kind: Toast['kind'], message: string, ttl = 4200): void {
  const id = ++seq
  toasts.push({ id, kind, message })
  setTimeout(() => {
    const idx = toasts.findIndex((t) => t.id === id)
    if (idx >= 0) toasts.splice(idx, 1)
  }, ttl)
}

/** 手动关闭（点一下提示就走）：比等 TTL 更快，也顺手解决"提示挡住按钮"的观感 */
export function dismissToast(id: number): void {
  const idx = toasts.findIndex((t) => t.id === id)
  if (idx >= 0) toasts.splice(idx, 1)
}

export const toast = {
  info: (m: string) => push('info', m),
  success: (m: string) => push('success', m),
  error: (m: string) => push('error', m, 6000)
}
