/**
 * 代理配置的读取与解密。
 *
 * 密码与上游渠道密钥同规格（AES-256-GCM + PORTARA_MASTER_KEY），
 * 只在真正要发请求时解密，从不出现在任何响应里。
 */
import { one } from '../db.js'
import { decryptSecret } from '../lib/crypto.js'
import { env } from '../env.js'
import type { ProxyTarget } from './proxyAgent.js'
import type { ProxyRow } from '../types.js'

/**
 * 按 id 取可用的代理目标（已解密）。返回 null 表示直连。
 *
 * 停用的代理视为「不生效」并返回 null —— 让渠道静默回退到直连，
 * 而不是因为一个停用的代理把整个渠道打死。
 */
export async function getProxyTarget(proxyId: string | null | undefined): Promise<ProxyTarget | null> {
  if (!proxyId) return null

  const row = await one<ProxyRow>('select * from proxies where id = $1', [proxyId])
  if (!row || row.status !== 'active') return null

  let password = ''
  if (row.password_cipher) {
    try {
      password = decryptSecret(row.password_cipher, env.masterKey)
    } catch {
      // 解密失败（例如换了主密钥）不该让渠道不可用，退回直连
      console.warn(`[portara] 代理「${row.name}」的密码无法解密，本次按直连处理`)
      return null
    }
  }

  return {
    id: row.id,
    host: row.host,
    port: row.port,
    username: row.username,
    password
  }
}
