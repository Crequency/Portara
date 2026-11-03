/**
 * 产品版本号（`/healthz`、`/readyz`、`/api/meta` 与启动日志都报它）。
 *
 * 单独放一个模块，是为了让**它不带上整个应用**：`app.ts` 一被 import 就会
 * 建 pg 连接池与 Redis 客户端，测试如果为了读一个常量去 import 它，
 * 进程会卡在重连上退不出来（本轮就踩了：单测从 0.3 秒变成挂死）。
 */
export const VERSION = '0.2.1'
