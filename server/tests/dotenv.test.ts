import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadDotEnv } from '../src/lib/dotenv.js'

function withEnvFile(content: string, fn: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'portara-dotenv-'))
  const file = path.join(dir, '.env')
  writeFileSync(file, content, 'utf8')
  try {
    fn(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('加载 .env 中的键值', () => {
  withEnvFile('PORTARA_TEST_A=hello\nPORTARA_TEST_B=world', (file) => {
    delete process.env.PORTARA_TEST_A
    delete process.env.PORTARA_TEST_B
    loadDotEnv(file)
    assert.equal(process.env.PORTARA_TEST_A, 'hello')
    assert.equal(process.env.PORTARA_TEST_B, 'world')
  })
})

test('已存在的环境变量优先，绝不被 .env 覆盖', () => {
  process.env.PORTARA_TEST_KEEP = 'from-process'
  withEnvFile('PORTARA_TEST_KEEP=from-file', (file) => {
    loadDotEnv(file)
    assert.equal(process.env.PORTARA_TEST_KEEP, 'from-process')
  })
  delete process.env.PORTARA_TEST_KEEP
})

test('忽略注释、空行与非法行，支持 export 与引号', () => {
  withEnvFile(
    [
      '# 注释',
      '',
      '   ',
      'not a valid line',
      'export PORTARA_TEST_C=exported',
      'PORTARA_TEST_D="quoted value"',
      "PORTARA_TEST_E='single'",
      'PORTARA_TEST_F=with=equals'
    ].join('\n'),
    (file) => {
      for (const k of ['C', 'D', 'E', 'F']) delete process.env[`PORTARA_TEST_${k}`]
      loadDotEnv(file)
      assert.equal(process.env.PORTARA_TEST_C, 'exported')
      assert.equal(process.env.PORTARA_TEST_D, 'quoted value')
      assert.equal(process.env.PORTARA_TEST_E, 'single')
      assert.equal(process.env.PORTARA_TEST_F, 'with=equals')
    }
  )
})

test('文件不存在时静默跳过，不抛错', () => {
  assert.doesNotThrow(() => loadDotEnv('/definitely/not/here/.env'))
})

test('空值也能被载入（用于清空默认行为）', () => {
  withEnvFile('PORTARA_TEST_EMPTY=', (file) => {
    delete process.env.PORTARA_TEST_EMPTY
    loadDotEnv(file)
    assert.equal(process.env.PORTARA_TEST_EMPTY, '')
  })
})
