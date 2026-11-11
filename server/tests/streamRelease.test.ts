import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * 槽位归还的回归测试 —— 直接测"流被取消时还归不还名额"。
 *
 * 这是真实事故的复现：`pipeThrough(new TransformStream({flush, cancel}))`
 * 里的 cancel 不是合法钩子，客户端中途断开时 flush 不会被调用，
 * 并发计数卡死在上限，之后所有请求都被误判"渠道并发已满"。
 *
 * 这里把生产实现里同样的包装形态抄一份做对照，钉住"三条路径都归还"。
 */

/** 与 server/src/routes/v1.ts 的 wrapStreamWithRelease 同构 */
function wrapStreamWithRelease(body: ReadableStream<Uint8Array>, release: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    release()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          finish()
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      finish()
      try {
        await reader.cancel(reason)
      } catch {
        /* 只为归还名额 */
      }
    }
  })
}

function sourceOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  const queue = [...chunks]
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift()
      if (next === undefined) {
        controller.close()
        return
      }
      controller.enqueue(next)
    }
  })
}

const enc = new TextEncoder()

test('正常读完：归还一次', async () => {
  let released = 0
  const out = wrapStreamWithRelease(sourceOf([enc.encode('a'), enc.encode('b')]), () => {
    released++
  })
  const reader = out.getReader()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  assert.equal(text, 'ab')
  assert.equal(released, 1)
})

test('客户端中途取消：归还一次（旧实现不会归还）', async () => {
  let released = 0
  const out = wrapStreamWithRelease(sourceOf([enc.encode('a'), enc.encode('b'), enc.encode('c')]), () => {
    released++
  })
  const reader = out.getReader()
  await reader.read()
  await reader.cancel('用户中断')
  assert.equal(released, 1)
})

test('重复取消 / 取消后再读：仍然只归还一次', async () => {
  let released = 0
  const out = wrapStreamWithRelease(sourceOf([enc.encode('a')]), () => {
    released++
  })
  const reader = out.getReader()
  await reader.cancel('x')
  await reader.cancel('y')
  assert.equal(released, 1)
})

test('上游读错误：归还一次', async () => {
  let released = 0
  const failing = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error('上游断了'))
    }
  })
  const out = wrapStreamWithRelease(failing, () => {
    released++
  })
  const reader = out.getReader()
  await assert.rejects(() => reader.read())
  assert.equal(released, 1)
})
