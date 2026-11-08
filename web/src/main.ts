import { createApp } from 'vue'
import App from './App.vue'
import { setDiagLine } from './diag'
import { locale, setLocale } from './i18n'
import { initTheme } from './theme'
import './styles.css'

// 主题与语言要在挂载前落定，避免首屏闪一下再变色
initTheme()
setLocale(locale.value)

const app = createApp(App)

/*
 * Vue 的 errorHandler 默认只 console.error —— 事件处理函数里的异常会被它吞掉，
 * window.onerror 收不到，所以在诊断模式下同时写进顶部浮条（见 diag.ts）。
 */
app.config.errorHandler = (err, _instance, info) => {
  console.error(err)
  setDiagLine('Vue error (' + info + ') → ' + String(err).slice(0, 140))
}

app.mount('#app')
