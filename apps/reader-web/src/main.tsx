import { APP_NAME } from './lib/app-config.ts'
// 应用及其 CSS 作为异步资源加载，让 HTML 启动占位先于全站样式显示。
void import('./app.tsx').catch(() => {
  const root = document.getElementById('root')!
  const state = document.createElement('main')
  state.className = 'boot-loading'
  const message = document.createElement('p')
  message.setAttribute('role', 'alert')
  message.textContent = `${APP_NAME}加载失败，请刷新页面后重试。`
  const refresh = document.createElement('button')
  refresh.className = 'boot-loading-refresh'
  refresh.type = 'button'
  refresh.textContent = '刷新页面'
  refresh.addEventListener('click', () => window.location.reload())
  state.append(message, refresh)
  root.replaceChildren(state)
})
