/**
 * Portara 品牌标记 —— **唯一事实来源是同目录的 logo.json**。
 *
 * 造型取自项目名字的来历：希腊纳克索斯岛阿波罗神庙的那座巨型大理石之门
 * （Portara，"门"）。一座有门洞的巨石门，恰好与「AI 网关」同构：请求经由它穿过。
 *
 * 为什么用「实心拱 + 挖空门洞」而不是描边：favicon 最小只有 16px，
 * 描边在这个尺寸会糊成一团，而实心剪影挖洞仍能读出「一座门」。
 *
 * 为什么数据放在 .json 而不是这个 .ts 里：
 * `scripts/brand.mjs` 要用同一份数据生成 favicon，而根目录解析不到 tsx
 * （tsx 是 server 的依赖）。纯 JSON 两边都能原生读，于是不必为构建脚本
 * 引入 loader —— 组件里的图形与站点图标因此不可能不一致。
 */
import data from './logo.json'

export const MARK_VIEWBOX: number = data.viewBox
export const MARK_PATH: string = data.path
export const BRAND_GRADIENT_FROM: string = data.gradientFrom
export const BRAND_GRADIENT_TO: string = data.gradientTo
export const MARK_RATIO: number = data.markRatio
