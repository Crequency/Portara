import { randomBytes } from 'node:crypto'
import { one, query } from './db.js'
import { env } from './env.js'
import { hashPassword } from './lib/crypto.js'

/**
 * 引导管理员账号。
 *
 * 语义：**按 USERNAME 判断，不存在才创建**；已存在则一动不动
 * （绝不覆盖既有账号的密码或角色）。
 *
 * 为什么不是「用户表为空才创建」：那会让换用户名重新引导、多环境共用一套库、
 * 以及自动化测试反复运行都失效 —— 实测踩过。按用户名判断既可重复，
 * 又不会在重启时改动既有账号。
 */
export async function ensureAdmin(): Promise<void> {
  const username = env.adminUsername

  const existing = await one<{ id: string }>('select id from users where username = $1', [
    username
  ])
  if (existing) {
    console.log(`[portara] 管理员 ${username} 已存在，跳过引导`)
    return
  }

  if (!env.adminPassword) {
    const generated = randomBytes(12).toString('base64url')
    await query(
      `insert into users (username, display_name, password_hash, role)
       values ($1, $2, $3, 'admin')`,
      [username, '系统管理员', hashPassword(generated)]
    )
    console.warn(
      `\n\u001b[33m[portara] 未设置 PORTARA_ADMIN_PASSWORD，已生成随机初始密码\u001b[0m\n` +
        `  用户名：${username}\n  密码：${generated}\n  请立即登录后修改。\n`
    )
    return
  }

  await query(
    `insert into users (username, display_name, password_hash, role)
     values ($1, $2, $3, 'admin')`,
    [username, '系统管理员', hashPassword(env.adminPassword)]
  )
  console.log(`[portara] 已创建初始管理员：${username}`)

  if (env.adminPassword === 'portara-admin') {
    console.warn(
      '\n\u001b[33m[portara][安全告警] 初始管理员仍在使用默认密码 portara-admin，请立即修改。\u001b[0m\n'
    )
  }
}
