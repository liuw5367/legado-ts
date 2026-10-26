import { APP_NAME, APP_TAGLINE } from '../lib/app-config.ts'
import { PageHeader } from '../components/page-header.tsx'
import { useId, useState } from 'react'
import { BookOpen, ExternalLink, Share2 } from 'lucide-react'
import { Link } from 'react-router-dom'

const buildTimestamp = process.env.BUILD_TIME ?? new Date(0).toISOString()
const buildTime = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(buildTimestamp))
const repositoryUrl = 'https://github.com/liuw5367/legado-ts'

export function AboutAppPage() {
  const titleId = useId()
  const [message, setMessage] = useState('')
  const [sharing, setSharing] = useState(false)
  async function share(title: string, url: string) {
    if (sharing) return
    setSharing(true); setMessage('')
    try {
      if (navigator.share) await navigator.share({ title, url })
      else { await navigator.clipboard.writeText(url); setMessage('当前浏览器不支持系统分享，链接已复制。') }
    } catch (reason) {
      if (!(reason instanceof Error && reason.name === 'AbortError')) setMessage('分享失败，请重试。')
    } finally { setSharing(false) }
  }
  return <section className="page-stack page-narrow about-app-page">
    <PageHeader backTo="/account/settings" title="关于应用" />
    <section className="about-app-brand" aria-labelledby={titleId}>
      <img className="about-app-logo" src="/static/pwa/icon-512.png" alt="" width="112" height="112" />
      <h2 id={titleId}>{APP_NAME}</h2>
      <p className="muted">{APP_TAGLINE}</p>
      <p className="muted small">更新时间</p>
      <time className="about-app-build-time" dateTime={buildTimestamp}>{buildTime}</time>
    </section>
    <nav className="settings-entry-list" aria-label="关于应用链接">
      <Link className="settings-entry" to="/onboarding" state={{ returnTo: '/account/settings/about' }}>
        <span className="settings-entry-copy"><strong>新手引导</strong><span className="muted small">重新查看书源导入和搜索流程</span></span>
        <BookOpen aria-hidden="true" />
      </Link>
      <a className="settings-entry" href={repositoryUrl} target="_blank" rel="noreferrer">
        <span className="settings-entry-copy"><strong>GitHub 仓库</strong><span className="muted small">查看源代码与项目动态</span></span>
        <ExternalLink aria-hidden="true" />
      </a>
      <button className="settings-entry settings-entry-action" type="button" disabled={sharing} onClick={() => void share(`${APP_NAME} 仓库`, repositoryUrl)}><span className="settings-entry-copy"><strong>分享仓库</strong><span className="muted small">分享 GitHub 项目地址</span></span><Share2 aria-hidden="true" /></button>
      <button className="settings-entry settings-entry-action" type="button" disabled={sharing} onClick={() => void share(APP_NAME, window.location.origin)}><span className="settings-entry-copy"><strong>分享应用</strong><span className="muted small">分享当前应用地址</span></span><Share2 aria-hidden="true" /></button>
    </nav>
    {message ? <p className="muted small" role="status">{message}</p> : null}
  </section>
}
