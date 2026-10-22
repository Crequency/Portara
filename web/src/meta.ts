/**
 * 站点品牌信息（网关名称等）。
 *
 * 为什么单独放一个模块：网关名称要同时影响**页面标题**与**左上角副标题**，
 * 而登录页在拿到会话之前就要显示它。做成一个响应式单例，
 * 系统设置页保存后调用 `loadMeta()` 即可让全局立即更新。
 */
import { reactive } from 'vue'
import { api } from './api'

export interface SiteMeta {
  gatewayName: string
  productName: string
  /**
   * 版本号**只从后端来**。
   *
   * 以前页脚写死 `v0.1.0`，于是每次发版都要记得改前端 —— 迟早会忘，
   * 而忘掉的表现是「包版本 0.2.0、页脚还写着 0.1.0」，没有任何报错。
   * `/api/meta` 本来就会回版本，直接用它，前端不再有第二个真值。
   */
  version: string
  loaded: boolean
}

export const meta = reactive<SiteMeta>({
  gatewayName: '',
  productName: 'Portara',
  version: '',
  loaded: false
})

/** 展示用名称：未设置网关名时回落到产品名 */
export function siteName(): string {
  return meta.gatewayName.trim() || meta.productName
}

/**
 * 拉取站点信息。
 * 失败时**不抛错**——品牌信息拿不到不该让整个页面打不开，用默认值即可。
 */
export async function loadMeta(): Promise<void> {
  try {
    const res = await api.get<{ gatewayName: string; productName: string; version?: string }>(
      '/api/meta'
    )
    meta.gatewayName = res.gatewayName ?? ''
    meta.productName = res.productName || 'Portara'
    meta.version = res.version ?? ''
  } catch {
    /* 用默认值 */
  } finally {
    meta.loaded = true
  }
}
