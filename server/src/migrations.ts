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
  },
  {
    id: '002_channel_latency_key_reveal',
    sql: `
      -- 渠道最近一次连通性测试的结果（面板刷新后仍可看到延迟）
      alter table channels add column if not exists last_latency_ms int;
      alter table channels add column if not exists last_test_at    timestamptz;
      alter table channels add column if not exists last_test_ok    boolean;

      -- 客户端 Key 的可解密副本。
      -- 这是**明确的安全权衡**（见 DECISIONS D-013）：默认方案只存哈希，
      -- 为了支持「管理员查看并复制 Key」才额外存一份 AES-256-GCM 密文。
      -- 留空表示该 Key 创建于开启此功能之前，无法找回，只能轮换。
      alter table api_keys add column if not exists key_cipher text not null default '';

      -- 审计日志：敏感操作（如查看密钥）留痕
      create table if not exists audit_events (
        id             bigserial primary key,
        ts             timestamptz not null default now(),
        actor_user_id  uuid,
        actor_username text not null default '',
        action         text not null,
        target_type    text not null default '',
        target_id      text not null default '',
        detail         jsonb not null default '{}'::jsonb,
        client_ip      text not null default ''
      );
      create index if not exists audit_events_ts_idx on audit_events (ts desc);
      create index if not exists audit_events_action_idx on audit_events (action, ts desc);
    `
  },
  {
    id: '003_channel_protocol_vendor_headers',
    sql: `
      -- 协议：首批只实现 OpenAI 兼容，字段先留出以便扩展
      alter table channels add column if not exists protocol text not null default 'openai';

      -- 厂商兼容：generic（通用 OpenAI 兼容）/ opencode-go（需 x-opencode-session 头）
      alter table channels add column if not exists vendor text not null default 'generic';

      -- 用户自定义的固定请求头（明文保存 —— 见 DECISIONS D-016：
      -- 密钥请放在 api_key_cipher，不要放这里）
      alter table channels add column if not exists extra_headers jsonb not null default '{}'::jsonb;
    `
  },
  {
    id: '004_model_routes',
    sql: `
      -- 模型映射：网关受理的模型 id（alias）→ 具体渠道上的上游模型 id。
      -- 一个 alias 可以对应多个 (渠道, 上游模型) 目标，按优先级与权重做负载均衡。
      create table if not exists model_routes (
        id             uuid primary key default gen_random_uuid(),
        alias          text not null,
        channel_id     uuid not null references channels(id) on delete cascade,
        upstream_model text not null,
        priority       int  not null default 100,
        weight         int  not null default 1,
        status         text not null default 'active' check (status in ('active','disabled')),
        note           text not null default '',
        created_at     timestamptz not null default now(),
        updated_at     timestamptz not null default now(),
        unique (alias, channel_id, upstream_model)
      );
      create index if not exists model_routes_alias_idx on model_routes (alias);

      -- 请求日志同时记录「受理模型」与「实际上游模型」，便于排查映射问题
      alter table request_logs add column if not exists upstream_model text not null default '';
    `
  },
  {
    id: '005_channel_models_api',
    sql: `
      -- 模型列表 API 的路径。默认 /models 即 OpenAI 协议的约定；
      -- 不同厂商可能不同，故做成渠道级可配置。
      alter table channels add column if not exists models_path text not null default '/models';

      -- 模型元信息（上下文长度等），键为模型 id。
      --
      -- 为什么新增列而不是改 models 的类型：models 仍是 text[]（模型 id 列表），
      -- 元信息作为旁挂数据存这里 —— 纯加法迁移，**既有数据零改动、零丢失**。
      -- 老行取默认值 {} 即「该模型无元信息」，代码按缺失优雅降级。
      alter table channels add column if not exists models_meta jsonb not null default '{}'::jsonb;
    `
  }
]
