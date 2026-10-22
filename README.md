# Portara

> **企业级 AI API 网关** —— 统一入口、多模型路由、租户治理与成本计量

[![license](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

## 项目代号

**Portara**（波塔拉）：希腊纳克索斯岛阿波罗神庙遗址上孤悬海岬的巨型大理石门框。
它是一道**纯粹的门** —— 没有墙、没有建筑，只剩入口本身。

选它，是因为这个项目要做的正是一道门：所有 AI 流量必须从这里经过，
而它自己不该成为负担。

## 定位

Portara 位于应用与模型服务之间，把「谁在用、能用多少、该走哪个模型、
花了多少钱、出了事怎么查」这五件事从业务代码里彻底剥离出来。

面向企业私有化部署，统一接入 OpenAI 兼容的公有云模型与自建推理服务
（vLLM / Ollama / TGI 等）。

```csharp
// 接入前：每个业务模块都要自己管密钥、配额与计费
var key = Environment.GetEnvironmentVariable("OPENAI_KEY");
var client = new OpenAIClient(key);
var resp = await client.ChatAsync(...);

// 接入后：只改 base_url 与 api_key 两行
var client = new OpenAIClient(
    new ApiKeyCredential("sk-portara-..."),
    new OpenAIClientOptions { Endpoint = new Uri("http://portara.internal/v1") });
```

## 当前能力

M1 已完成；下表按领域归并，细项见决策记录（内部资料）。

| 领域 | 能力 |
| --- | --- |
| **会话** | 管理员登录；access 15 分钟 + refresh 30 天，轮换 + 重用检测 + 前端无感续期（D-051） |
| **用户** | 管理员 / 操作员两种角色；启用禁用、改密；不允许禁用最后一个管理员 |
| **上游渠道** | 增删改查；密钥 AES-256-GCM 加密；连通性测试与**延迟展示**；详情子页面（配置 / 账户 / 用量 / 模型明细 / 映射 / 最近请求） |
| **多上游账户** | 一个渠道配多把 Key：渠道内按优先级分组 + 权重轮转；失效/限流自动换号（冷却按错误类别）；余额见底的账户被主动跳过；余额用量按账户呈现 |
| **模型发现** | 模型列表 API 路径可配置；从 API 自动获取模型与上下文长度（含复制原始响应体）；`GET /v1/models` 聚合且透传元信息，支持 `?filter=mirror-only\|origin-only` |
| **协议** | OpenAI 兼容与 Anthropic 双协议，含流式逐事件翻译；渠道支持**混杂模式**（逐模型指定协议与 Base URL）；厂商兼容规则（如 opencode-go 的 `x-opencode-session`，含消毒与稳定兜底）与自定义固定请求头 |
| **模型映射** | 网关模型 ID → (渠道, 上游模型)；一个 ID 可负载均衡到多渠道多模型；按前缀批量生成、列表可折叠分组、可 JSON 整体编辑 |
| **密钥治理** | 派发（一次性明文、哈希存储）、轮换、吊销；归属隔离（非管理员只见自己名下）；管理员可查看完整 Key（风险提示 + 审计，见 D-013） |
| **请求治理** | 模型白名单（403）、速率限制（RPM，Redis 原子计数）、Token 配额（402）；密钥可设过期时间 |
| **余额用量** | 厂商适配器（DeepSeek / Moonshot / CommandCode / MiniMax）+ 缓存防限频；`GET /v1/usage` 聚合接口（逐 Key 权限与可见渠道范围）；独立余额页（含 API 地址一键复制）+ 概览响应式合并卡 |
| **可观测** | 请求日志与用量统计；概览 Top 排行（按次数/用量切换）与趋势；粒度可选今日 / 7 天 / 30 天 / 自定义并**记住上次选择**；审计日志 |
| **时区** | 日志一律 UTC 存储；查询与展示按请求方（浏览器）时区，网关时区作默认 |
| **网络** | HTTP 代理库；渠道可选是否走代理；多选批量延迟对比（代理 vs 直连） |
| **面板** | Vue 3 单端口托管；手写 CSS 无 UI 框架；中英双语、明暗主题 |
| **规划中** | 多上游智能路由、熔断、内容安全、语义缓存 —— 见 [roadmap](.develop/docs/02-roadmap.md) |

## 快速开始

### 1. 起依赖（PostgreSQL + Redis）

```bash
cp .env.example .env
# 生产务必修改：PORTARA_MASTER_KEY / PORTARA_SESSION_SECRET / PORTARA_ADMIN_PASSWORD
docker compose up -d postgres redis
```

### 2. 安装并启动

```bash
pnpm install
pnpm build          # 构建前端产物 + 编译后端
pnpm start          # 单端口同时提供 API、/v1 数据面与管理面板
```

打开 <http://127.0.0.1:52740/>，用 `.env` 中的
`PORTARA_ADMIN_USERNAME` / `PORTARA_ADMIN_PASSWORD` 登录。

### 3. 全容器化部署

```bash
docker compose --profile app up -d --build
```

### 4. 天天开发

```bash
pnpm dev            # 后端（tsx watch 热重载，52740）
pnpm dev:web        # 前端（vite，52741，自动代理 /api 与 /v1 到 52740）

# 注意：DevHub 里登记的 api 命令跑的是 `pnpm start`（构建产物，pid 稳定，
# 这样 devctl restart 才可靠）。**改完服务端源码必须先 `pnpm build` 再重启**，
# 否则 52740 上仍是旧产物。要热重载就用上面的 `pnpm dev`，但那个进程
# 无法被 devctl 可靠地 stop/restart（详见 DECISIONS D-037）。
```

> **可复现性检查**：`pnpm test`（单元测试）与 `pnpm smoke`（端到端冒烟，
> 会真实起服务与伪上游，覆盖登录→建渠道→派 Key→转发→限流→配额→模型映射）。
>
> 注意：冒烟会向 `request_logs` 写入伪上游记录（用于验证统计与计量），
> **不会自动清理** —— 管理 API 里没有删除日志的接口。若希望面板干净，
> 可自行删除 `model` 以 `mock-` / `smoke-` 开头的记录。

## 五分钟上手

1. 登录面板 → **上游渠道** → 新建：填 `https://api.openai.com/v1` 与上游 Key
2. 点该行「测试」确认连通（会拉取 `/models`）
3. **API 密钥** → 派发密钥：设置限速、配额、可选模型白名单
4. **复制弹窗里的明文密钥**（只出现这一次）
5. 用它调用：

```bash
curl http://127.0.0.1:52740/v1/chat/completions \
  -H "Authorization: Bearer sk-portara-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"你好"}]}'
```

6. **请求日志** 里查看 token、耗时与状态
7. **对话测试**（管理员）里选一把 Key 直接聊两句 —— 走的是真实 `/v1` 链路
8. **上游渠道** 点「测试」即刷新该行的延迟显示
9. **概览** 顶部可切换 今日 / 近 7 天 / 近一个月 / 自定义
10. 渠道若要求特殊请求头（如 OpenCode 的 `x-opencode-session`），
    在渠道弹窗里选「厂商兼容」或在「固定请求头」里自行填写
11. **模型映射**：点「批量映射」选渠道、填前缀 `opencode-go`，
    即可生成 `opencode-go/deepseek-flash` 这样的网关模型 ID；
    同一个网关 ID 再批量挂上别的渠道，就形成多渠道负载均衡
12. 映射多起来后，同一前缀的别名会**折叠成组**；也可以点「JSON 编辑」
    整体编辑映射表（渠道用名称引用，改错会提示可用渠道名）

## 对外端点

### 数据面（OpenAI 兼容）

| 端点 | 说明 |
| --- | --- |
| `POST /v1/chat/completions` | 对话补全，支持 `stream: true`（SSE 字节级透传） |
| `POST /v1/completions` | 文本补全 |
| `POST /v1/embeddings` | 向量化 |
| `POST /v1/responses` | Responses API 透传 |
| `GET /v1/models` | 聚合各启用渠道声明的模型；`?filter=mirror-only\|origin-only` |
| `GET /v1/usage` | 全部渠道的余额/用量（需该 Key 开启「可读取余额」） |
| `GET /v1/usage/{渠道 id}` | 单个渠道；`?refresh=1` 需另开「可强制刷新」 |
| 其他 `/v1/*` | 通用透传（同样经过鉴权、限流、计量） |

### 控制面（管理面板使用，`/api/*`）

| 领域 | 端点 |
| --- | --- |
| 会话 | `POST /api/auth/{login,refresh,logout,password}` · `GET /api/auth/me` |
| 用户 | `GET/POST/PATCH/DELETE /api/users[/:id]` |
| 渠道 | `GET/POST/PATCH/DELETE /api/channels[/:id]` · `POST /:id/test` · `POST /:id/chat`（直连上游）· `GET /:id/reveal` · `GET /:id/usage` · `POST /fetch-models`、`POST /:id/fetch-models` |
| 密钥 | `GET/POST/PATCH/DELETE /api/keys[/:id]` · `POST /:id/rotate` · `GET /:id/reveal` |
| 模型映射 | `GET/POST/PATCH/DELETE /api/model-routes[/:id]` · `POST /batch` · `POST /purge` · `POST /import` |
| 代理 | `GET/POST/PATCH/DELETE /api/proxies[/:id]` · `GET /:id/reveal` · `POST /latency-test` |
| 余额 | `GET /api/usage` · `GET /api/usage/adapters` · `POST /api/usage/{refresh,invalidate,invalidate-all}` |
| 设置 | `GET/PATCH /api/settings` · `POST /api/settings/purge-logs` |
| 日志与统计 | `GET /api/logs` · `GET /api/stats/{overview,series}?range=today\|7d\|30d\|custom[&from=&to=][&channelId=][&tz=]` |
| 审计 | `GET /api/audit`（仅管理员） |
| 运维 | `GET /healthz` · `GET /readyz`（就绪会检查 PG 与 Redis） |

写操作按领域各自要求管理员或归属校验，详见各路由文件。

## 架构

```
浏览器 ──► Hono (52740)
              ├── /              前端产物（SPA）
              ├── /api/*         控制面（JWT Cookie）
              └── /v1/*          数据面（sk-portara-*）
                                    └──► 上游 OpenAI 兼容服务
                          PostgreSQL（用户/渠道/密钥/日志）
                          Redis（限流计数、路由轮转）
```

**转发路径上的纪律**（Node 单线程，任何同步重活都会变成延迟）：

- 不在转发路径上反序列化整个 SSE 流 —— 用 `TransformStream` 旁路扫描 `data:` 行
- 仅对疑似含 `usage` 的行做 `JSON.parse`
- 计量与日志异步落库，不阻塞响应
- 客户端断开即取消上游请求（`AbortSignal` 串联），避免幽灵计费
- 上游未返回 `usage` 时按字节量估算，并**显式标记 `estimated`**，不假装精确

## 目录结构

```
Portara/
├── server/src/
│   ├── routes/            # auth / users / channels / keys / modelRoutes /
│   │                      # proxies / settings / usage(+usageAdmin) / logs / audit / v1
│   ├── services/          # routing 选路 · limits 限流配额 · relay 协议规划 ·
│   │                      # anthropic 翻译 · proxy 请求头 · proxyAgent 代理连接 ·
│   │                      # vendorRules 厂商规则 · usage 余额适配器 · sessions 会话 ·
│   │                      # channels 渠道密钥 · settings / logger / audit / models
│   ├── lib/               # crypto · http · dotenv
│   └── tests/             # node:test 单元测试
├── web/src/
│   ├── views/             # 每个页面一个 .vue（概览 / 渠道 / 详情 / 密钥 / 日志 / 余额 …）
│   ├── components/        # PSelect · PCombobox · PCheckbox · PInfo · Modal · LogoMark
│   ├── i18n/              # 中英文案（zh.ts / en.ts）
│   └── styles.css         # 手写 CSS（无 UI 框架）
├── scripts/
│   ├── smoke.mjs          # 端到端冒烟（独立 schema + 伪上游）
│   └── brand.mjs          # 由 web/src/logo.json 生成站点图标
├── docker-compose.yml / Dockerfile
└── .develop/docs/         # 愿景、技术选型、开发路线
```

## 安全约定

| 对象 | 处理 |
| --- | --- |
| 登录口令 | `scrypt` + 随机盐 + `timingSafeEqual` |
| 客户端 API Key | SHA-256 哈希（鉴权用）+ AES-256-GCM 密文（供管理员查看，见下）+ 展示前缀 |
| 上游渠道密钥 | AES-256-GCM 信封加密，主密钥来自 `PORTARA_MASTER_KEY` |
| 管理会话 | access：HS256 JWT（15 分钟）；refresh：32 字节随机串（30 天），两者均为 HttpOnly + SameSite=Lax。refresh 存哈希、每次刷新轮换、可撤销，详见 D-051 |
| 日志 | 密钥一律不落日志；请求/响应**正文默认不留存** |

> **关于「查看 Key」的权衡（DECISIONS D-013）**：为了支持管理员在面板上查看并
> 复制完整 Key，服务端在哈希之外额外存了一份可解密的密文。这意味着
> **若数据库与 `PORTARA_MASTER_KEY` 同时泄漏，客户端 Key 可被解密** ——
> 这是明确接受的代价。补偿措施：查看接口仅管理员可用、每次查看写入审计日志
> （fail-closed）、列表接口只返回前缀、旧 Key 无密文时明确报错而不假装可恢复。
> 若要回到「只存哈希」，清空 `api_keys.key_cipher` 即可。

生产必须显式设置 `PORTARA_MASTER_KEY` 与 `PORTARA_SESSION_SECRET`
（`openssl rand -base64 32` / `openssl rand -hex 32`）；未设置时开发模式会回退到
内置弱密钥并**在启动日志中高声告警**。

## 文档

| 文档 | 内容 |
| --- | --- |
| [愿景与边界](.develop/docs/00-vision.md) | 做什么、不做什么 |
| [技术选型](.develop/docs/01-tech-selection.md) | 选型结论、架构、工程纪律 |
| [开发路线](.develop/docs/02-roadmap.md) | M1 验收门与后续里程碑 |

## 许可证

[AGPL-3.0](LICENSE)。

**注意**：以网络服务形式对外提供本软件（含私有化交付）时，
必须向使用者提供完整对应源码。

---

版权所有 © 2025-2026 云矩数阁网络科技（贵州省）有限责任公司
