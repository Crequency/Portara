/**
 * 由 web/src/logo.ts 生成站点图标。
 *
 * 为什么要有这个脚本：favicon 是静态文件，而 logo 画在组件里 ——
 * 两边各写一份必然会漂移（本项目此前就有三份同样的图形）。
 * 这里让 favicon 成为 logo.ts 的**产物**，`pnpm build` 会重新生成。
 *
 * PNG 需要光栅化器，故为**尽力而为**：找不到 playwright-core 就跳过并提示，
 * SVG 部分始终生成（现代浏览器都支持 SVG favicon）。
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import logo from '../web/src/logo.json' with { type: 'json' }

/** 由 logo.json 生成带渐变底的方形图标（与组件同源） */
function brandSquareSvg({ size, radiusRatio = 0.22 }) {
  const radius = Math.round(size * radiusRatio * 100) / 100
  const mark = Math.round(size * logo.markRatio * 100) / 100
  const offset = Math.round(((size - mark) / 2) * 100) / 100
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `  <defs>`,
    `    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`,
    `      <stop offset="0" stop-color="${logo.gradientFrom}"/>`,
    `      <stop offset="1" stop-color="${logo.gradientTo}"/>`,
    `    </linearGradient>`,
    `  </defs>`,
    `  <rect width="${size}" height="${size}" rx="${radius}" fill="url(#g)"/>`,
    `  <g transform="translate(${offset} ${offset}) scale(${mark / logo.viewBox})">`,
    `    <path d="${logo.path}" fill="#fff" fill-rule="evenodd"/>`,
    `  </g>`,
    `</svg>`,
    ''
  ].join('\n')
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = resolve(root, 'web/public')
const checkOnly = process.argv.includes('--check')

const SVG_PATH = resolve(publicDir, 'favicon.svg')
/** 圆角版 favicon.svg：用 32 的设计尺寸，浏览器自己缩放 */
const svg = brandSquareSvg({ size: 32 })

if (checkOnly) {
  const current = existsSync(SVG_PATH) ? await readFile(SVG_PATH, 'utf8') : ''
  if (current !== svg) {
    console.error('[brand] favicon.svg 与 web/src/logo.ts 不一致，请运行 pnpm brand 重新生成')
    process.exit(1)
  }
  console.log('[brand] favicon.svg 与 logo.ts 一致 ✓')
  process.exit(0)
}

await mkdir(publicDir, { recursive: true })
await writeFile(SVG_PATH, svg, 'utf8')
console.log('[brand] 已生成 web/public/favicon.svg')

// ---- PNG（尽力而为）----
const targets = [
  { file: 'favicon-32.png', size: 32, radiusRatio: 0.22 },
  { file: 'favicon-16.png', size: 16, radiusRatio: 0.22 },
  // iOS 自己会加圆角蒙版，故满幅不留透明
  { file: 'apple-touch-icon.png', size: 180, radiusRatio: 0 }
]

let chromium = null
// 允许从任意位置加载 playwright-core（它通常不作为本项目的依赖安装）
const pwCandidates = ['playwright-core', process.env.PLAYWRIGHT_CORE_PATH].filter(Boolean)
for (const spec of pwCandidates) {
  try {
    ;({ chromium } = await import(spec))
    break
  } catch {
    /* 试下一个 */
  }
}
if (!chromium) {
  console.warn('[brand] 未找到 playwright-core，跳过 PNG 生成（SVG 已就绪，浏览器可正常显示）')
  process.exit(0)
}

const candidates = [
  process.env.CHROME_HEADLESS_SHELL,
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`
].filter(Boolean)
const executablePath = candidates.find((p) => existsSync(p))
if (!executablePath) {
  console.warn('[brand] 未找到 chrome-headless-shell，跳过 PNG 生成')
  process.exit(0)
}

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })
for (const t of targets) {
  const page = await browser.newPage({
    viewport: { width: t.size, height: t.size },
    deviceScaleFactor: 1
  })
  const html = `<!doctype html><style>html,body{margin:0;padding:0;background:transparent}
    svg{display:block;width:${t.size}px;height:${t.size}px}</style>${brandSquareSvg(t)}`
  await page.setContent(html)
  await page.waitForTimeout(120)
  await page.screenshot({
    path: resolve(publicDir, t.file),
    omitBackground: t.radiusRatio === 0 ? false : true
  })
  await page.close()
  console.log(`[brand] 已生成 web/public/${t.file}`)
}
await browser.close()
