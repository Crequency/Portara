import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { VERSION } from '../src/version.js'

/**
 * 版本号必须四处一致。
 *
 * 版本散在四个地方：根 / server / web 三个 `package.json`，以及服务端的
 * `VERSION` 常量（`/healthz`、`/readyz`、`/api/meta` 都报它）。
 *
 * 这次 bump 就差点踩到：改了 `package.json` 却忘了常量，于是面板页脚、
 * 健康检查与包版本互相打脸。加一条测试把它们钉在一起 ——
 * 以后只改一处会立刻红。
 */

function pkgVersion(relPath: string): string {
  const raw = readFileSync(new URL(relPath, import.meta.url), 'utf8')
  return (JSON.parse(raw) as { version: string }).version
}

test('版本号在 package.json 与 VERSION 常量之间保持一致', () => {
  const root = pkgVersion('../../package.json')
  const server = pkgVersion('../package.json')
  const web = pkgVersion('../../web/package.json')

  assert.equal(server, root, `server/package.json (${server}) ≠ 根 package.json (${root})`)
  assert.equal(web, root, `web/package.json (${web}) ≠ 根 package.json (${root})`)
  assert.equal(VERSION, root, `VERSION 常量 (${VERSION}) ≠ 根 package.json (${root})`)
})
