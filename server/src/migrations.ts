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
  },
  {
    id: '006_request_log_source',
    sql: `
      -- 请求来源：
      --   gateway    经网关转发的真实调用（历史数据全部属于此类，故默认值语义正确）
      --   playground 对话测试页的「上游渠道测试」直连调用 —— 同样消耗上游额度，
      --              必须可见，但要能与真实流量区分开
      alter table request_logs add column if not exists source text not null default 'gateway';
      create index if not exists request_logs_source_idx on request_logs (source, ts desc);
    `
  },
  {
    id: '007_model_route_group_key',
    sql: `
      -- 批量映射时记录所用的「渠道 id 头」（前缀）。
      --
      -- 为什么需要它：别名形如 <前缀>/<上游模型 id>，而上游模型 id 自身可能含 /，
      -- 例如 commandcode/deepseek/deepseek-v4-flash —— 此时靠字符串反推前缀
      -- 必然出错（会把 commandcode/deepseek 当成一组，分组碎成一片）。
      -- 前缀是**创建时就知道的事实**，直接记下来最可靠。
      --
      -- 空字符串表示「未记录」（历史数据或手工创建），UI 回退到
      -- 「第一个 / 之前的部分」。既有数据零改动、零丢失。
      alter table model_routes add column if not exists group_key text not null default '';
    `
  },
  {
    id: '008_backfill_model_route_group_key',
    sql: `
      -- 回填历史数据的 group_key。
      --
      -- 迁移 007 只加了列（已发布，不再修改），历史行为空。
      -- 但前缀是**可以从行内精确推导**的：别名 = 前缀 + '/' + 上游模型 id，
      -- 因此 前缀 = 别名去掉末尾的 '/<上游模型 id>'。这是精确等式，不是猜测。
      --
      -- 条件里的 alias <> upstream_model 排除「无前缀」的情况（那时别名就等于模型 id，
      -- 保持空串，UI 会把它归入「未分组」）。
      -- 幂等：只动 group_key 仍为空的行。
      update model_routes
         set group_key = left(alias, length(alias) - length(upstream_model) - 1)
       where group_key = ''
         and alias <> upstream_model
         and alias like '%/' || upstream_model;
    `
  },
  {
    id: '009_channel_model_overrides',
    sql: `
      -- 逐模型的协议与 Base URL 覆盖。
      --
      -- 用途：同一渠道下不同模型可能说不同协议（例如 CommandCode 的模型列表里
      -- 既有 OpenAI 协议的也有 Anthropic 协议的），此时渠道 protocol 设为 'mixed'，
      -- 每个模型的实际协议与地址由此处覆盖决定。
      --
      -- 形如：{ "<上游模型 id>": { "protocol": "anthropic", "baseUrl": "https://..." } }
      --
      -- 与 models_meta 分开存是刻意的：
      --   models_meta 是**从上游抓来的**元信息（重新抓取会整体替换）
      --   model_overrides 是**用户配的**覆盖（不能被抓取冲掉）
      -- 两者生命周期不同，混在一起必然丢配置。
      alter table channels add column if not exists model_overrides jsonb not null default '{}'::jsonb;
    `
  },
  {
    id: '010_settings',
    sql: `
      -- 系统设置：键值表。
      --
      -- 为什么是键值而不是单行多列：
      --   新增一个设置项只需加一条记录，不必再写迁移；列名与代码里的
      --   注册表（services/settings.ts）一一对应，类型与默认值都在代码里。
      --
      -- 无历史数据需要迁移：这是新表，默认值由代码提供（表里没有记录 = 用默认值）。
      create table if not exists settings (
        key        text primary key,
        value      jsonb not null,
        updated_at timestamptz not null default now(),
        updated_by text
      );
    `
  },
  {
    id: '011_proxies',
    sql: `
      -- HTTP 代理配置库。管理员维护多份，渠道按需选用。
      --
      -- 密码与上游渠道密钥同规格：AES-256-GCM 加密存储（PORTARA_MASTER_KEY），
      -- 界面上只显示掩码，管理员可显式查看（留审计）。
      create table if not exists proxies (
        id              uuid primary key default gen_random_uuid(),
        name            text not null,
        host            text not null,
        port            integer not null,
        username        text not null default '',
        password_cipher text not null default '',
        status          text not null default 'active',
        note            text not null default '',
        last_latency_ms integer,
        last_test_at    timestamptz,
        last_test_ok    boolean,
        created_at      timestamptz not null default now(),
        updated_at      timestamptz not null default now()
      );
      create unique index if not exists proxies_name_key on proxies (name);

      -- 渠道可选是否走代理；null = 直连（默认，不改变既有行为）。
      -- on delete set null：删掉代理时渠道自动回到直连，而不是留下悬空引用。
      alter table channels
        add column if not exists proxy_id uuid references proxies(id) on delete set null;
    `
  },
  {
    id: '012_usage_adapters',
    sql: `
      -- 余额 / 用量适配器（渠道级）。
      --
      -- usage_adapter = '' 表示该渠道不提供余额（**默认，不改变既有行为**）。
      -- 每个厂商的余额接口没有标准协议，故由 adapter 决定端点与解析方式。
      alter table channels add column if not exists usage_adapter text not null default '';
      -- 可选覆盖：留空则用 adapter 的默认路径（自建 / 反代场景）
      alter table channels add column if not exists usage_url text not null default '';

      -- Key 的余额读取权限。默认**全部拒绝**（安全默认）：
      -- 余额信息能反映账户资金状况，不该默认对所有 key 开放。
      alter table api_keys add column if not exists usage_allow boolean not null default false;
      -- 可见渠道范围；空数组 = 可见所有已配置 adapter 的渠道
      -- （与既有 model_allow 的「空 = 不限制」语义保持一致）
      alter table api_keys add column if not exists usage_channels text[] not null default '{}';
      -- 是否允许 ?refresh=1 强制刷新。默认不允许：
      -- 否则等于给了调用方一个反复打上游的开关。
      alter table api_keys add column if not exists usage_refresh boolean not null default false;
    `
  },
  {
    id: '013_sessions',
    sql: `
      -- 可撤销的登录会话（refresh token 轮换链）。
      --
      -- 为什么需要这张表：access token 是**无状态** JWT，签发后无法收回。
      -- 要支持「登出即刻失效 / 改密踢掉其它设备 / 检测令牌重用」，
      -- 就必须有一份服务端记录。
      --
      -- 只存 refresh token 的**哈希**：它是 32 字节高熵随机串，
      -- 用 SHA-256 即可（不像密码需要慢哈希 —— 没有字典可猜）。
      create table if not exists sessions (
        id             uuid primary key default gen_random_uuid(),
        user_id        uuid not null references users(id) on delete cascade,
        -- 同一次登录产生的整条轮换链共用一个 family_id。
        -- 检测到令牌重用时按 family 整族作废，把攻击者与用户一起踢出去，
        -- 用户重新登录即可 —— 而攻击者手里的旧链全部失效。
        family_id      uuid not null,
        token_hash     text not null unique,
        created_at     timestamptz not null default now(),
        last_used_at   timestamptz not null default now(),
        expires_at     timestamptz not null,
        revoked_at     timestamptz,
        -- 'rotated' | 'logout' | 'reuse_detected' | 'password_changed' | 'user_disabled'
        revoked_reason text not null default '',
        user_agent     text not null default '',
        ip             text not null default ''
      );

      create index if not exists sessions_user_idx    on sessions (user_id);
      create index if not exists sessions_family_idx  on sessions (family_id);
      -- 定期清理过期会话用
      create index if not exists sessions_expires_idx on sessions (expires_at);
    `
  },
  {
    id: '014_channel_accounts',
    sql: `
      -- 一个渠道下的多个上游账户（每账户一把 Key）。
      --
      -- 为什么需要它：单 Key 渠道无法做账户级负载均衡、故障转移与额度轮转，
      -- 而这三件事都需要"同一渠道有多个可替换的凭据"。
      --
      -- 账户**不是**渠道：模型能力、协议、Base URL、模型映射都仍归渠道管，
      -- 账户只提供凭据，外加它自己的选路权重与健康状态。
      create table if not exists channel_accounts (
        id             uuid primary key default gen_random_uuid(),
        channel_id     uuid not null references channels(id) on delete cascade,
        name           text not null default '',
        key_cipher     text not null default '',
        status         text not null default 'active',
        -- 渠道**内**的选路层级；与渠道之间的 priority/weight 同构
        priority       integer not null default 100,
        weight         integer not null default 1,
        note           text not null default '',
        -- 健康状态：由故障转移维护，不是配置项
        cooldown_until timestamptz,
        last_error     text not null default '',
        last_used_at   timestamptz,
        consecutive_failures integer not null default 0,
        -- 账户级适配器覆盖（默认继承渠道；国内站/国际站可能不同）
        usage_adapter  text not null default '',
        usage_url      text not null default '',
        created_at     timestamptz not null default now(),
        updated_at     timestamptz not null default now()
      );

      create index if not exists channel_accounts_channel_idx on channel_accounts (channel_id);
      create index if not exists channel_accounts_pick_idx
        on channel_accounts (channel_id, status, priority);

      -- 回填：每个渠道生成一条「默认账户」，密钥取自 channels.api_key_cipher。
      -- 幂等：已有账户的渠道不再插入。
      -- 空密钥的渠道也建一条 —— 保证「任何渠道至少一个账户」这条不变式，
      -- 请求路径因此不必到处判断"有没有账户"。
      insert into channel_accounts (channel_id, name, key_cipher)
      select c.id, '默认账户', c.api_key_cipher
        from channels c
       where not exists (
         select 1 from channel_accounts a where a.channel_id = c.id
       );

      -- channels.api_key_cipher 仍会被**同步镜像**为第一个账户的密文：
      -- 结构上停用它作为数据源，但保留同值以支持回滚到旧版本。
      -- 不删列（迁移铁律：只增不删）。

      -- 请求日志记录实际服务的是哪个账户 —— 否则"哪个号额度打爆了"只能靠猜
      alter table request_logs add column if not exists account_id uuid;
      alter table request_logs add column if not exists account_name text not null default '';
    `
  },
  {
    id: '015_account_quota_flag',
    sql: `
      -- 该账户的余额/额度是否已经耗尽（由余额适配器在刷新时标记）。
      --
      -- 为什么要单独一列而不是复用 cooldown：语义不同 ——
      -- cooldown 是"刚失败过，先歇一会儿"，会随时间自动过期；
      -- 这里是"余额见底了"，只能靠余额回升来解除，跟时间无关。
      -- 分开存，面板上也能分别显示「冷却中」与「额度耗尽」。
      alter table channel_accounts
        add column if not exists quota_exhausted boolean not null default false,
        add column if not exists quota_checked_at timestamptz;
    `
  },
  {
    id: '016_channel_limit_priority',
    sql: `
      -- 判定"账户是否已耗尽"时以哪个维度为准。
      --
      -- 有些厂商同时给两套口径：CommandCode 有 credits 余额 + 5h/周/月窗口，
      -- 二者并不总是同步（窗口满了但充值额度还有；或反之）。
      -- 到底哪个先算"用不了"，取决于使用者的策略：
      --   balance —— 余额优先（默认，与改造前一致）：钱见底才算耗尽
      --   quota   —— 用量限额优先：窗口打满就换号，即使还有余额
      alter table channels
        add column if not exists limit_priority text not null default 'balance';
    `
  },
  {
    id: '017_hide_unmapped_models',
    sql: `
      -- 「只暴露映射模型」开关。
      --
      -- 打开后，该渠道未映射的模型 id 既不出现在网关的 /v1/models，
      -- 也不受理直接拿它发起的请求 —— 否则映射形同虚设：
      -- 客户端绕过别名、直接用上游原始模型名依然能打进来。
      --
      -- 默认 false：老渠道行为完全不变（原始模型名照旧可见可用）。
      alter table channels
        add column if not exists hide_unmapped_models boolean not null default false;
    `
  },
  {
    id: '018_request_log_session_hash',
    sql: `
      -- 会话亲和的排查字段。
      --
      -- 只存哈希的**前 8 位**：够用来核对「这些请求是不是同一个会话」，
      -- 又不至于让人反推出客户端原始会话键（那可能是 prompt_cache_key）。
      -- 空串 = 本次没有可用的会话键（未启用亲和）。
      alter table request_logs
        add column if not exists session_hash text not null default '';
    `
  },
  {
    id: '019_account_window_exhausted',
    sql: `
      -- 「任意用量窗口已打满」的独立标记。
      --
      -- 为什么不复用 quota_exhausted：那一列的口径由渠道的 limit_priority 决定
      -- （balance 口径下只看钱、quota 口径下才看窗口）。而这里要表达的是
      -- **硬事实**：有一个窗口打满了 —— 与"哪个口径说了算"无关，
      -- 打满的窗口就是上限，继续请求只会拿回 429/402。
      --
      -- 两列并存：quota_exhausted 继续驱动"耗尽轮转"，这一列驱动
      -- 「打满任意窗口就不路由」的新策略。查不到用量时两列都不动。
      alter table channel_accounts
        add column if not exists window_exhausted boolean not null default false,
        add column if not exists window_checked_at timestamptz;
    `
  },
  {
    id: '020_account_quota_cooldown',
    sql: `
      -- 上游明确返回「额度用尽」时触发的**幂等递增冷冻期**。
      --
      -- 与 cooldown_until 分开存：
      --   cooldown_until      —— 通用失败冷却（401/5xx/网络错误…），一次一算；
      --   quota_cooldown_*    —— 额度用尽的软冷冻，阶梯递增（5m→15m→45m→2h→12h→24h→3d）。
      -- 两套计时若共用一个列会互相覆盖：一次 5xx 就能把「额度用尽 3 天」冲掉。
      --
      -- quota_cooldown_level：已触发次数（0 = 从未触发）。只有"冷冻已过期/从未冷冻"
      -- 后再次检测到额度用尽才会 +1；冷冻期内重复检测不递增、不延长（幂等）。
      -- 成功请求（markAccountSuccess）会把 level 与 until 一起清零。
      alter table channel_accounts
        add column if not exists quota_cooldown_level integer not null default 0,
        add column if not exists quota_cooldown_until timestamptz;
    `
  },
  {
    id: '021_registration_applications',
    sql: `
      -- 公开注册申请：未登录用户在登录页申请，管理员审批后才创建正式用户。
      --
      -- password_hash 在**提交时就**做 scrypt 哈希 —— 申请记录本身不保存明文口令，
      -- 即使管理员不通过也不会留下可用的凭据。
      --
      -- 同一用户名同时只能有一个 pending 申请（部分唯一索引）。已拒绝/已通过的
      -- 申请不参与该索引：被拒绝后用户可以重新申请，已通过的用户名则会在
      -- 「users 已存在」那一步被挡住。
      create table if not exists registration_applications (
        id            uuid primary key default gen_random_uuid(),
        username      text not null,
        display_name  text not null default '',
        password_hash text not null,
        contact       text not null default '',
        note          text not null default '',
        status        text not null default 'pending'
                      check (status in ('pending','approved','rejected')),
        reject_reason text not null default '',
        reviewed_by   uuid references users(id) on delete set null,
        reviewed_at   timestamptz,
        user_id       uuid references users(id) on delete set null,
        created_at    timestamptz not null default now()
      );

      create index if not exists idx_reg_apps_status
        on registration_applications (status, created_at desc);

      -- 幂等的部分唯一索引：if not exists 对索引同样生效。
      -- 只约束 pending，因此「拒绝后重新申请」不会被历史记录挡住。
      create unique index if not exists uq_reg_apps_pending_username
        on registration_applications (username)
        where status = 'pending';
    `
  }
]
