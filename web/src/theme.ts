/**
 * 主题：默认跟随系统，可手动锁定浅色 / 深色。
 * 实现方式是在 <html> 上写 data-theme，CSS 变量随之切换。
 */
import { computed, ref } from 'vue'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'portara.theme'

export const THEME_MODES: { value: ThemeMode; labelKey: string }[] = [
  { value: 'system', labelKey: 'theme.system' },
  { value: 'light', labelKey: 'theme.light' },
  { value: 'dark', labelKey: 'theme.dark' }
]

function detect(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'system' || saved === 'light' || saved === 'dark') return saved
  } catch {
    /* 忽略 */
  }
  return 'system'
}

export const themeMode = ref<ThemeMode>(detect())

const systemDark = ref(
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true
)

export const resolvedTheme = computed<ResolvedTheme>(() =>
  themeMode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : themeMode.value
)

function apply(): void {
  const root = document.documentElement
  root.setAttribute('data-theme', resolvedTheme.value)
  root.setAttribute('data-theme-mode', themeMode.value)
  // 让原生控件（滚动条、日期选择器）跟随
  root.style.colorScheme = resolvedTheme.value
}

export function setThemeMode(next: ThemeMode): void {
  themeMode.value = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* 忽略 */
  }
  apply()
}

/** 在应用启动时调用一次 */
export function initTheme(): void {
  if (typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    systemDark.value = mq.matches
    mq.addEventListener('change', (e) => {
      systemDark.value = e.matches
      apply()
    })
  }
  apply()
}
