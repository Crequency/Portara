import { createApp } from 'vue'
import App from './App.vue'
import { locale, setLocale } from './i18n'
import { initTheme } from './theme'
import './styles.css'

// 主题与语言要在挂载前落定，避免首屏闪一下再变色
initTheme()
setLocale(locale.value)

createApp(App).mount('#app')
