import { env } from './env.js'

/**
 * 数据库迁移。SQL 内联为 TS 字符串，避免 tsc 构建时漏拷 .sql 文件。
 * 已执行的迁移记录在 schema_migrations，**只增不改**。
 */
export const migrations: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: `
      create table if not exists users (
        id            uuid primary key default gen_random_uuid(),
        username      text not null unique,
        display_name  text not null default '',
        password_hash text not null,
        role          text not null default 'operator' check (role in ('admin','operator')),
        status        text not null default 'active'   check (status in ('active','disabled')),
        created_at    timestamptz not null default now(),
        updated_at    timestamptz not null default now(),
        last_login_at timestamptz
      );

      create table if not exists channels (
        id             uuid primary key default gen_random_uuid(),
        name           text not null unique,
        provider       text not null default 'openai',
        base_url       text not null,
        api_key_cipher text not null default '',
        models         text[] not null default '{}',
        priority       int  not null default 100,
        weight         int  not null default 1,
        timeout_ms     int  not null default 120000,
        status         text not null default 'active' check (status in ('active','disabled')),
        note           text not null default '',
        created_at     timestamptz not null default now(),
        updated_at     timestamptz not null default now()
      );

      create table if not exists api_keys (
        id          uuid primary key default gen_random_uuid(),
        name        text not null,
        key_prefix  text not null,
        key_hash    text not null unique,
        user_id     uuid references users(id)    on delete set null,
        channel_id  uuid references channels(id) on delete set null,
        model_allow text[] not null default '{}',
        rpm_limit   int    not null default 60,
        quota_tokens bigint not null default 0,
        used_tokens  bigint not null default 0,
        status      text not null default 'active' check (status in ('active','disabled')),
        expires_at  timestamptz,
        last_used_at timestamptz,
        created_at  timestamptz not null default now()
      );
      create index if not exists api_keys_prefix_idx on api_keys (key_prefix);

      create table if not exists request_logs (
        id                bigserial primary key,
        ts                timestamptz not null default now(),
        api_key_id        uuid,
        api_key_name      text not null default '',
        channel_id        uuid,
        channel_name      text not null default '',
        model             text not null default '',
        path              text not null default '',
        status_code       int  not null default 0,
        prompt_tokens     int  not null default 0,
        completion_tokens int  not null default 0,
        total_tokens      int  not null default 0,
        estimated         boolean not null default false,
        latency_ms        int  not null default 0,
        ttft_ms           int,
        client_ip         text not null default '',
        error             text not null default ''
      );
      create index if not exists request_logs_ts_idx  on request_logs (ts desc);
      create index if not exists request_logs_key_idx on request_logs (api_key_id, ts desc);
    `
  }
]
