import { one, query } from '../db.js'
import type { ChannelRow } from '../types.js'
import { pickChannel, type ChannelCandidate } from './routing.js'

export { pickChannel, normalizeWeight } from './routing.js'
export type { ChannelCandidate } from './routing.js'

/** 取活跃渠道并选路。rotation 由 Redis 自增提供，保证多实例下轮转一致。 */
export async function resolveChannel(
  model: string,
  rotation: () => Promise<number>
): Promise<ChannelCandidate | null> {
  const channels = await query<ChannelRow>(
    `select * from channels where status = 'active' order by priority asc, name asc`
  )
  if (channels.length === 0) return null
  const round = await rotation()
  return pickChannel(channels as unknown as ChannelCandidate[], model, round)
}

export async function getChannelById(id: string): Promise<ChannelRow | null> {
  return one<ChannelRow>('select * from channels where id = $1', [id])
}
