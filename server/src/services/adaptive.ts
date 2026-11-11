/**
 * 自适应选路（实时规划）—— 纯逻辑，不碰数据库/Redis。
 *
 * 目标：把「请求日志里的近期表现」与「此刻的负载」变成排序依据，
 * 而不是永远按配置里写死的顺序打。
 *
 * 设计约束（刻意保守）：
 *   ① **只在同一优先级层内重排**，不跨层 —— 用户配置的优先级/权重仍然是硬约束；
 *   ② 样本不足（minSamples）的渠道不参与排序，保持原位置，避免"新号冷启动被饿死"；
 *   ③ 开关默认关闭（adaptiveRouting=false），不改变现有行为；
 *   ④ 分数只影响**顺序**，不影响可用性判定 —— 该跳过的冻结账户照旧跳过。
 */

/** 一个渠道/账户的近期表现切片 */
export interface AdaptiveStat {
  /** 窗口内请求总数（成功 + 失败） */
  total: number
  /** 其中 4xx/5xx 的数量 */
  errors: number
  /** P95 延迟（毫秒）；0 = 未知 */
  p95Ms: number
  /** 当前在飞请求数（可选） */
  inflight?: number
  /** 并发上限（可选）；<=0 表示不限并发 */
  limit?: number
}

export interface AdaptiveScore {
  /** 0..1 的综合分，越高越优先 */
  score: number
  /** 是否基于足够样本（false = 用了中性分） */
  sampled: boolean
}

/**
 * 计算综合分。
 *
 * 三个分量的取舍：
 *   - **成功率**权重最高（0.5）：反复失败的上游不该被优先选中，这是最直接的用户体感；
 *   - **延迟**（0.3）：用 P95 而不是均值 —— 均值会把偶发长尾抹平，
 *     而长尾正是"这个渠道现在很卡"的信号；20s 作为参考尺度（超过就接近"不可用"）；
 *   - **并发压力**（0.2）：已经满负荷的渠道即使历史成绩好，也该让别人先上。
 *
 * 未知数据用中性分 0.5：既不奖励也不惩罚，避免新渠道被永久压到最后。
 */
export function scoreOf(stat: AdaptiveStat | undefined): AdaptiveScore {
  if (!stat || stat.total <= 0) return { score: 0.5, sampled: false }

  const errorRate = Math.min(1, Math.max(0, stat.errors / stat.total))
  const successScore = 1 - errorRate

  // 20s 参考：p95 = 0 视为未知，给中性 0.5
  const latencyScore =
    stat.p95Ms > 0 ? 1 / (1 + stat.p95Ms / 20_000) : 0.5

  // 并发压力：没有上限（0/undefined）视为无压力
  const limit = stat.limit ?? 0
  const inflight = stat.inflight ?? 0
  const pressureScore =
    limit > 0 ? Math.max(0, 1 - Math.min(1, inflight / limit)) : 1

  const score = 0.5 * successScore + 0.3 * latencyScore + 0.2 * pressureScore
  return { score: Math.max(0, Math.min(1, score)), sampled: true }
}

/**
 * 按近期表现排序（稳定排序）。
 *
 * 规则：
 *   - 样本量 < minSamples 的条目**保持原位置**（不参与重排，也不被挤到末尾）；
 *   - 有样本的条目按分数降序，同分保持原相对顺序；
 *   - 结果长度与输入一致，绝不丢候选。
 *
 * @param keyOf 取条目的渠道 id
 * @param stats 以渠道 id 为键的统计
 */
export function orderByAdaptiveScore<T>(
  items: T[],
  keyOf: (item: T) => string,
  stats: Map<string, AdaptiveStat>,
  minSamples: number
): T[] {
  if (items.length <= 1) return items.slice()

  const scored: Array<{ item: T; score: number; index: number }> = []
  const unscored: Array<{ item: T; index: number }> = []
  items.forEach((item, index) => {
    const stat = stats.get(keyOf(item))
    const s = scoreOf(stat)
    const enough = s.sampled && (stat?.total ?? 0) >= Math.max(1, minSamples)
    if (enough) scored.push({ item, score: s.score, index })
    else unscored.push({ item, index })
  })

  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index))
  if (unscored.length === 0) return scored.map((x) => x.item)

  /*
   * 混合：样本足够的按分数排在前，样本不足的按原顺序接在后面。
   *
   * 为什么不把"未知"插在中间：未知无法比较，插中间会让每次顺序抖动；
   * 放末尾 + 冷启动时中性分不参与，行为最可预测。等它们积累到 minSamples
   * 自然进入排序。
   */
  return [...scored.map((x) => x.item), ...unscored.map((x) => x.item)]
}
