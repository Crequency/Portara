/**
 * 上游密钥的读取 —— 渠道账户的唯一入口。
 *
 * 「取出明文」这件事散落在八个地方（转发、拉模型、连通性测试、直连对话、
 * 代理探测、余额查询、面板掩码、reveal），每处各写一遍 try/catch 必然会漂移 ——
 * 事实上此前已经漂移出了三种不同的错误文案。
 *
 * 现在统一到密钥**密文**这一层（而不是"渠道"或"账户"），
 * 因为两者只是承载密文的行：渠道的兼容列、账户的 key_cipher。
 */
import { env } from '../env.js'
import { decryptSecret } from '../lib/crypto.js'
import { badRequest } from '../lib/http.js'

/**
 * 取出密钥明文。
 *
 * `''` 表示**没配密钥**（有些上游不需要鉴权），
 * `null` 表示**有密文但解不开**（通常是主密钥变了）——
 * 两者含义不同，调用方不该混为一谈。
 */
export function tryDecryptKey(cipher: string | null | undefined): string | null {
  if (!cipher) return ''
  try {
    return decryptSecret(cipher, env.masterKey)
  } catch {
    return null
  }
}

/** 同上，但解密失败直接抛 400（控制面入口用） */
export function decryptKey(cipher: string | null | undefined): string {
  const key = tryDecryptKey(cipher)
  if (key === null) throw badRequest('该渠道的密钥无法解密，请重新填写')
  return key
}

/** 与 decryptKey 同义，但错误码与文案由调用方决定（reveal 用 500 + 主密钥提示） */
export function decryptKeyOrNull(cipher: string | null | undefined): string | null {
  return tryDecryptKey(cipher)
}
