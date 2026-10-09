import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto'

/** 客户端密钥前缀，便于在日志/配置里一眼认出是 Portara 的 Key */
export const KEY_PREFIX = 'sk-portara-'

/** 生成客户端 API Key。明文只在创建时返回一次，库里只留哈希。 */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const secret = randomBytes(32).toString('base64url')
  const key = `${KEY_PREFIX}${secret}`
  // 展示用前缀：sk-portara-XXXXXXXX
  const prefix = key.slice(0, KEY_PREFIX.length + 8)
  return { key, prefix, hash: hashApiKey(key) }
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** 常量时间比较两个等长 hex 串（非法 hex 一律判否，避免空缓冲互相相等） */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length || a.length % 2 !== 0) return false
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 上游密钥

/**
 * AES-256-GCM 加密。密文格式：`v1:<iv b64>:<tag b64>:<ciphertext b64>`
 * 带版本号是为了将来轮换算法时能识别旧密文。
 */
export function encryptSecret(plain: string, masterKey: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    'v1',
    iv.toString('base64'),
    tag.toString('base64'),
    ct.toString('base64')
  ].join(':')
}

export function decryptSecret(payload: string, masterKey: Buffer): string {
  const parts = payload.split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('密文格式不支持（期望 v1:iv:tag:ct）')
  }
  const iv = Buffer.from(parts[1]!, 'base64')
  const tag = Buffer.from(parts[2]!, 'base64')
  const ct = Buffer.from(parts[3]!, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

// ---------------------------------------------------------------- 口令

const SCRYPT_KEYLEN = 64

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN)
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  try {
    const salt = Buffer.from(parts[1]!, 'base64')
    const expected = Buffer.from(parts[2]!, 'base64')
    const derived = scryptSync(password, salt, expected.length)
    return timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

/** 给日志/接口返回用的掩码（绝不返回明文） */
export function maskSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return '••••••••'
  return `${value.slice(0, 4)}••••${value.slice(-4)}`
}
