import { computed, ref } from 'vue'
import { en } from './en'
import { zh } from './zh'

export type Locale = 'zh' | 'en'

export const LOCALES: { value: Locale; label: string; short: string }[] = [
  { value: 'zh', label: '中文', short: '中文' },
  { value: 'en', label: 'English', short: 'EN' }
]

const STORAGE_KEY = 'portara.locale'

type Dict = Record<string, unknown>

const catalogs: Record<Locale, Dict> = { zh, en }

function detect(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') return saved
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export const locale = ref<Locale>(detect())

export function setLocale(next: Locale): void {
  locale.value = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* 忽略 */
  }
  document.documentElement.setAttribute('lang', next === 'zh' ? 'zh-CN' : 'en')
}

/** 按 "a.b.c" 取值；缺失时回退到中文，再回退到键名本身（便于发现漏翻） */
function lookup(dict: Dict, path: string): string | undefined {
  let node: unknown = dict
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Dict)[part]
  }
  return typeof node === 'string' ? node : undefined
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    params[key] === undefined ? `{${key}}` : String(params[key])
  )
}

export function translate(
  key: string,
  params?: Record<string, string | number>,
  overrideLocale?: Locale
): string {
  const loc = overrideLocale ?? locale.value
  const text = lookup(catalogs[loc], key) ?? lookup(catalogs.zh, key) ?? key
  return interpolate(text, params)
}

/** 组件里用这个：locale 变化时自动重算 */
export function useI18n() {
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(key, params)
  return { t, locale: computed(() => locale.value), setLocale, locales: LOCALES }
}

export function currentLocale(): Locale {
  return locale.value
}
