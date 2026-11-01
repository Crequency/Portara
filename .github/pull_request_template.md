## 改了什么

<!-- 一两句话说明动机与结果，不要只贴文件名 -->

## 关联

- 决策编号：D-___（若无，说明为什么不需要）
- 修复的 issue / 讨论：

## 验收

本地已跑通的命令（CI 跑同一组，见 `.github/workflows/ci.yml`）：

- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] `pnpm smoke`（独立 schema，`PORTARA_DB_SCHEMA` 含 `smoke`）

## 检查清单

- [ ] 涉及数据库改动时**附带了幂等迁移**（只做加法，已发布的迁移未修改）
- [ ] 破坏性操作有审计快照与确认门槛
- [ ] 改了 API 形状时同步更新了 `web/src/api.ts`、i18n 文案与 `README.md` 端点表
- [ ] diff 里没有无关的重排 / 重格式化，没有提交 `.env` 或真实密钥
