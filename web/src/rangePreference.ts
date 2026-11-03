/**
 * 统计粒度偏好的持久化。
 *
 * **共用实现，各用各的键**：
 *   - 逻辑只写一遍（本项目在"同一件事写两遍"上吃过几次亏）
 *   - 但概览与渠道详情是两处不同的使用场景（默认值不同、看的东西不同），
 *     记忆也该彼此独立 —— 在概览选了 7 天，不该顺手改掉详情页的习惯
 *
 * 存储**不可信**：非法 preset、custom 缺区间、非法 JSON 一律回退到默认，
 * 宁可退回默认也不能因为一条坏数据白屏或打开空范围。
 */
import type { RangePreset } from './api'

const VALID_PRESETS: RangePreset[] = ['today', '7d', '30d', '90d', '365d', 'custom']

export interface StoredRange {
  preset: RangePreset
  from?: string
  to?: string
}

/** 读取偏好；无有效记录时返回 null（调用方用默认值） */
export function loadRangePreference(key: string): StoredRange | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredRange
    if (!parsed || !VALID_PRESETS.includes(parsed.preset)) return null
    // 自定义必须带完整区间，否则宁可不恢复（避免打开一个空范围）
    if (parsed.preset === 'custom' && (!parsed.from || !parsed.to)) return null
    return parsed
  } catch {
    return null
  }
}

/** 写入偏好；写不进去（隐私模式）静默忽略 —— 记不住偏好不该影响功能 */
export function saveRangePreference(
  key: string,
  preset: RangePreset,
  custom?: { from: string; to: string } | null
): void {
  try {
    const data: StoredRange = { preset }
    if (preset === 'custom' && custom) {
      data.from = custom.from
      data.to = custom.to
    }
    localStorage.setItem(key, JSON.stringify(data))
  } catch {
    /* 忽略 */
  }
}
