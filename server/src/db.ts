import pg from 'pg'
import { env } from './env.js'
import { migrations } from './migrations.js'

const { Pool } = pg

const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

if (env.dbSchema && !SCHEMA_RE.test(env.dbSchema)) {
  throw new Error(
    `PORTARA_DB_SCHEMA 非法（只允许字母、数字、下划线且不以数字开头）：${env.dbSchema}`
  )
}

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  // 用连接参数固定 search_path，保证连接池里每条连接都落在同一个 schema
  ...(env.dbSchema ? { options: `-c search_path=${env.dbSchema}` } : {})
})

/**
 * 若配置了 PORTARA_DB_SCHEMA，先把它建出来。
 * 必须在任何业务查询之前执行 —— search_path 指向不存在的 schema 会直接报错。
 */
export async function ensureSchema(): Promise<void> {
  if (!env.dbSchema) return
  const client = new pg.Client({ connectionString: env.databaseUrl })
  await client.connect()
  try {
    await client.query(`create schema if not exists "${env.dbSchema}"`)
  } finally {
    await client.end()
  }
  console.log(`[portara] 使用独立 schema：${env.dbSchema}`)
}

pool.on('error', (err) => {
  console.error('[portara][db] 连接池错误：', err.message)
})

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await pool.query<T>(sql, params as never[])
  return res.rows
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}

/** 迁移：按 id 顺序执行，每条在独立事务内，已执行的跳过。 */
export async function runMigrations(): Promise<string[]> {
  await ensureSchema()

  await pool.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `)

  const applied = new Set(
    (await query<{ id: string }>('select id from schema_migrations')).map((r) => r.id)
  )

  const done: string[] = []
  for (const m of migrations) {
    if (applied.has(m.id)) continue
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(m.sql)
      await client.query('insert into schema_migrations (id) values ($1)', [m.id])
      await client.query('commit')
      done.push(m.id)
    } catch (err) {
      await client.query('rollback')
      throw new Error(
        `迁移 ${m.id} 失败：${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      client.release()
    }
  }
  return done
}

export async function closeDb(): Promise<void> {
  await pool.end()
}
