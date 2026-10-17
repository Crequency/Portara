/**
 * 渠道上游密钥的读取。
 *
 * 「取出明文」这件事散落在七个入口（拉模型、连通性测试、直连对话、代理探测、
 * 代理转发、余额查询、面板掩码），每处各写一遍 try/catch 必然会漂移 ——
 * 事实上此前已经漂移出了三种不同的错误文案。
 */
import { env } from '../env.js'
import { decryptSecret } from '../lib/crypto.js'
import { badRequest } from '../lib/http.js'

interface ChannelCipher {
  api_key_cipher: string | null
}

/**
 * 取出上游密钥明文。
 *
 * `''` 表示**渠道没配密钥**（有些上游不需要鉴权），
 * `null` 表示**有密文但解不开**（通常是主密钥变了）——
 * 两者含义不同，调用方不该混为一谈。
 */
export function tryDecryptChannelKey(ch: ChannelCipher): string | null {
  if (!ch.api_key_cipher) return ''
  try {
    return decryptSecret(ch.api_key_cipher, env.masterKey)
  } catch {
    return null
  }
}

/** 同上，但解密失败直接抛 400（控制面入口用） */
export function decryptChannelKey(ch: ChannelCipher): string {
  const key = tryDecryptChannelKey(ch)
  if (key === null) throw badRequest('该渠道的密钥无法解密，请重新填写')
  return key
}
