# 贡献指南

本项目以 AGPL-3.0-only 发布。提交 PR 即表示同意以同一许可证分发你的改动。

## 本地准备

```bash
cp .env.example .env      # 把 PORTARA_MASTER_KEY / PORTARA_SESSION_SECRET 换掉
docker compose up -d postgres redis
pnpm install
```

## 四条验收命令

提交前请依次跑通，CI（`.github/workflows/ci.yml`）跑的是同一组：

```bash
pnpm typecheck   # server (tsc --noEmit) + web (vue-tsc --noEmit)
pnpm build       # 先 pnpm brand 生成图标，再构建 web/dist 与 server/dist
pnpm test        # 单元测试（node --test，不依赖 PG / Redis）
pnpm smoke       # 端到端冒烟：真实起服务 + 伪上游，跑在独立 schema 里
```

冒烟自带伪上游与伪正向代理，不需要外网；但**必须**先 `pnpm build`（它跑产物 `server/dist/index.js`）。

## 迁移铁律（摘要）

涉及数据库结构或数据格式的改动，**必须同时交付迁移**：

1. **只做加法**：`add column if not exists` / `create table if not exists`；没有迁移就不得重命名或删除既有列。
2. **幂等**：重复执行不报错、无副作用；**语义变更要在同一批里回填历史行**。
3. **已发布的迁移永不修改**，修正靠新增一条；迁移写在 `server/src/migrations.ts`，id 递增。
4. **破坏性操作**要在审计日志里留快照，并有显式确认门槛（见 `AGENTS.md` 铁律 2）。
5. **测试绝不碰开发/生产数据**：端到端测试用 `PORTARA_DB_SCHEMA` 跑独立 schema，名字须含 `smoke`。

完整约束见 [AGENTS.md](AGENTS.md)，架构决策记录不随仓库分发，编号（D-xxx）仍出现在代码注释里，供维护者对照。

## 代码风格

注释与界面文案用中文，对外 JSON 字段用 camelCase；手写 CSS，不引入 UI 框架。不重排、不重格式化无关代码。
