# 路由信息（客户端可见的负载均衡状态）

> 面向客户端 / 插件作者。网关实现的源码位置见文末。

## 这是什么

网关会告诉调用方**这次请求最终落在哪个渠道、哪个上游账户**，以及**重试过程中有没有切换过**。

两条通道，互不依赖：

| 通道 | 位置 | 适用场景 |
| --- | --- | --- |
| 响应头 | 每次 `/v1/*` 响应 | 一次请求结束后马上知道结果，零额外成本 |
| 查询接口 | `GET /v1/route-info` | 会话级「当前路由 + 切换历史」，适合插件轮询 |

## 一、会话键：先对齐，再谈查询

网关按**会话键**聚合路由信息。取值优先级（高 → 低）：

1. `x-portara-client-session` —— 本网关约定的显式会话键
2. `x-deepseek-harness-session-id` —— DSH 适配器默认就会发，无需改动
3. 请求体的 `prompt_cache_key`
4. 「system + 首条 user」的上下文指纹（仅在 `PORTARA_AFFINITY_CONTEXT=1` 时启用）

**同一个会话键必须在请求与查询里保持一致**，否则会看到空结果。

```bash
# 发一次请求
curl -s http://<gateway>/v1/chat/completions \
  -H "authorization: Bearer <key>" \
  -H 'x-portara-client-session: my-session-1' \
  -H 'content-type: application/json' \
  -d '{"model":"balance/deepseek-flash","messages":[{"role":"user","content":"hi"}]}'

# 查这个会话的路由
curl -s http://<gateway>/v1/route-info \
  -H "authorization: Bearer <key>" \
  -H 'x-portara-client-session: my-session-1'
```

## 二、响应头

| 头 | 何时出现 | 含义 |
| --- | --- | --- |
| `x-portara-request-id` | **总是** | 请求级 uuid，排查锚点；不含拓扑信息 |
| `x-portara-route` | 开启路由信息时 | `别名[/渠道][/账户]/上游模型`，随档位变化 |
| `x-portara-route-attempts` | 开启时 | 第几次尝试才成功（`1` = 首击成功） |
| `x-portara-route-switch` | 发生切换时 | 切换原因：`quota` / `concurrency` / `auth` / `upstream` / `rate_limit` / `error` / `retry` |
| `x-portara-concurrency-wait-ms` | 排过队时 | 等并发槽位花了多少毫秒 |
| `x-portara-session` | 注入了厂商会话头时 | 实际发给上游的会话头值 |

`x-portara-route` 的三档形态（由 `exposeRoutingDetail` 决定）：

```text
off      balance/deepseek-flash
alias    balance/deepseek-flash
channel  balance/deepseek-flash/OpenDesign/ACP-003/deepseek-v4.1-flash
```

> 值里只允许可见 ASCII；空格折叠成 `-`，引号/逗号/中文名会被剥掉（所以渠道名可能变空、被跳过）。

## 三、查询接口

```http
GET /v1/route-info
authorization: Bearer <api key>
x-portara-client-session: <会话键>
```

响应：

```json
{
  "object": "route.info",
  "sessionKey": "8ff4d582",
  "updatedAt": "2026-11-11T16:22:39.250Z",
  "route": {
    "alias": "balance/deepseek-flash",
    "channel": "OpenDesign",
    "account": "ACP-003",
    "upstreamModel": "deepseek-v4.1-flash"
  },
  "history": [
    {
      "attempt": 1,
      "channel": "CommandCode",
      "account": "ACP-002",
      "outcome": "quota_cooldown",
      "statusCode": 429,
      "reason": "...",
      "at": "2026-11-11T16:22:31.000Z"
    }
  ]
}
```

字段说明：

- `route` —— **当前**路由。数据来自 Redis 里 15 分钟有效期的「最近一次成功路由」，因此**首击成功也能查到**（`lb_events` 表只在失败/切换时写）。
- `history` —— 最近 `routeInfoWindowMin` 分钟内的失败/切换事件，按时间正序，最多 50 条。首击成功不会出现在这里。
- `history[].outcome` —— `attempt_failed` / `failover_success` / `quota_cooldown`
- 没有记录时返回**结构一致的空对象**（`history: []`、`route` 各字段 `null`），客户端不需要写两套分支。

## 四、隐私与开关

路由信息暴露的是**上游拓扑**，默认关闭。设置项（`/api/settings`，分组 `gateway`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `exposeRoutingInfo` | `false` | 关闭时响应头只含 `x-portara-request-id`，`/v1/route-info` 返回空结构 |
| `exposeRoutingDetail` | `alias` | `off` 只回别名与"是否切换"；`alias` 同；`channel` 才回渠道与账户 |
| `routeInfoWindowMin` | `60` | 查询回溯窗口（分钟，1–1440） |

脱敏规则：

- `off` —— 渠道/账户置空；`history[].reason` 退化成 `ok` / `switched`
- `alias` —— 渠道/账户置空，其余照常
- `channel` —— 完整

## 五、给插件作者的实现建议

推荐做法（DSH 插件模式，不改内核）：

1. **host 侧**：请求时带上会话头（`x-portara-client-session`，或直接复用 DSH 已发的 `x-deepseek-harness-session-id`）
2. **host 侧**：请求结束后调 `GET /v1/route-info`，把结果 `agent.session.append('portara/route', data)` 写进会话流
3. **client 侧**：`uiConversation.events.register({ kind: 'portara-route', ... })` 注册节点，渲染成卡片
4. 需要「请求进行中」的状态，就每 2 秒轮询一次；`history` 变长说明发生了切换

注意：

- 会话键**不要**用会变的值（时间戳、随机数），否则每次都是一条新会话
- 轮询要节流；`/v1/route-info` 是数据面接口，按 API Key 认证
- 渠道/账户名属于上游拓扑，展示前确认受众（这正是默认脱敏的原因）

## 六、实现位置

| 关注点 | 文件 |
| --- | --- |
| 响应头组装 / 脱敏纯逻辑 | `server/src/services/routingInfo.ts` |
| 当前路由的短期缓存 | `server/src/services/routeCache.ts` |
| 切换历史查询 | `server/src/services/lbEvents.ts` |
| 端点与头接线 | `server/src/routes/v1.ts` |
| 开关定义 | `server/src/services/settings.ts` |
| 索引迁移 | `server/src/migrations.ts`（`030_lb_events_session_index`） |
| 单测 | `server/tests/routingInfo.test.ts`、`server/tests/streamRelease.test.ts` |
