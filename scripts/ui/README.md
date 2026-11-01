# scripts/ui —— 浏览器端 UI 检查

这些脚本原先散在 `/tmp/uicheck/`（不在版本库、重启即失），现在按用途收进这里。
它们**不是** `pnpm test` 的一部分：需要一个**已在运行**的 Portara 实例，
用真实管理员会话把页面走一遍，抓「页面没报错但已经坏了」的问题。

| 文件 | 检查什么 | 读/写 |
| --- | --- | --- |
| `lib.mjs` | 公共工具：启动 chromium、登录、收集控制台错误、断言汇总 | — |
| `sweep.mjs` | 全页控制台错误：9 个导航页 + 渠道详情/表单子页 + 负载均衡页签，每页断言渲染、内容非空、无错误提示、无控制台报错 | 只读 |
| `keys-leak.mjs` | 文案键泄漏：页面上不该原样出现 `usage.adapterField` 这类 i18n 键；**中文、英文各扫一遍** | 只读 |
| `balance-graph.mjs` | 负载均衡节点图版式：单源节点 / 3 目标 / 3 连线 / 备用梯队虚线 / 权重徽章 / 画布高度，以及新建与编辑弹窗的行数与回填 | **写**（临时 alias，结束即 purge） |
| `settings-routing.mjs` | 设置页路由行为：两个路由策略项回填服务端值、改动可保存、复原后可回读 | **写**（临时改冷却时长，结束即复原） |

## 依赖

脚本只依赖 `playwright-core`（浏览器内核另装）：

```bash
pnpm add -D playwright-core
npx playwright-core install chromium-headless-shell
```

**不装依赖也能跑** —— 复用已有的安装与浏览器缓存：

```bash
export PLAYWRIGHT_CORE_PATH=/path/to/node_modules/playwright-core   # 任意一份已有的安装
# 浏览器：脚本会自动在 ~/.cache/ms-playwright 里找最新一份 chromium_headless_shell-*，
# 找不到时可用 CHROME_HEADLESS_SHELL 显式指定：
# export CHROME_HEADLESS_SHELL=~/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell
```

浏览器缓存路径也可用 `PLAYWRIGHT_BROWSERS_PATH` 覆盖。

## 登录

口令**只从环境变量读**，仓库里不留明文：

```bash
export PORTARA_ADMIN_USERNAME=admin          # 缺省 admin，与服务端 env.ts 一致
export PORTARA_ADMIN_PASSWORD='…'            # 取自 .env 的 PORTARA_ADMIN_PASSWORD，必填
export BASE_URL=http://127.0.0.1:52740       # 可选，默认就是它
```

`BASE_URL` 指向 Hono 单端口（`pnpm dev` / `pnpm start` 的 52740）。
也可以用 vite dev 端口（52741）—— 那边 `/api` 已代理到 52740。

## 运行

```bash
pnpm ui:check                     # = node scripts/ui/sweep.mjs
pnpm ui:keys                      # = node scripts/ui/keys-leak.mjs
node scripts/ui/balance-graph.mjs
node scripts/ui/settings-routing.mjs
```

**前置**：实例已启动，且管理员口令正确。脚本自己**不会**启服务、不会装依赖。

## 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 通过：全部断言成立，且没有控制台 / 页面错误 |
| `1` | 失败：断言不成立、出现控制台 / 页面错误、登录失败、页面打不开，或缺少 `playwright-core` / `chrome-headless-shell` |

失败时会逐条打印 `✖` 的断言（含选择器、实际值）与控制台错误原文；
最后一行汇总「断言 N 项 / 控制台错误 N 条」，够定位到页面与字段。
`⚠` 开头的行是**环境不满足**（如库里没有渠道、下拉里没有某个适配器），
只提示、不计失败。

## 需要人工确认的地方

这些断言依赖具体文案或 DOM 类名，改动前端时要一起看：

1. **settings-routing** 依赖中文文案：「失败后的冷却时长」「额度窗口打满即跳过」
   「保存设置」，以及 `PCheckbox` 的 `role=checkbox` + `aria-checked`。
2. **keys-leak** 的英文那一遍依赖 `Balance adapter` 标签与 `CommandCode`
   适配器选项；找不到时会 `⚠` 跳过条件字段（不会失败，但覆盖变少）。
3. **所有脚本** 依赖 `.content`、`.card`、`.sidebar`、`.form-page`、
   `.toast-error` 这些类名，以及渠道页内页签按钮的文案（`负载均衡` /
   `Model mapping` 等）。类名或文案一改就要同步改脚本。
4. **balance-graph** 的「虚线 = 备用梯队」断言要求样本恰好两个梯队
   （priority 100 / 200）；样本由脚本自建，改动建样本逻辑要同步改断言。
5. **环境假设**：库里至少要有 1 个 active 渠道（balance-graph 硬性要求），
   sweep / keys-leak 在无渠道时会跳过详情页。

## 约定

- 只用 `BASE_URL` 换环境，不写死站点地址，更不写内网 IP。
- 会写库的两个脚本（balance-graph / settings-routing）都必须在 `finally` 里自清；
  新增脚本如果写库，照抄这个模式。
- 断言口径统一走 `lib.mjs` 的 `createChecker()` 与 `summarize()`，
  不要在脚本里各写一份退出码逻辑。
