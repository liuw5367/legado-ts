import { ExternalLink } from 'lucide-react'
import { PageBackButton } from '../components/page-back-button.tsx'

const buildTimestamp = process.env.BUILD_TIME
const buildTime = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(buildTimestamp))
const repositoryUrl = 'https://github.com/liuw5367/legado-ts'

export function AboutAppPage() {
  return <section className="page-stack page-narrow about-app-page">
    <div className="toc-heading"><PageBackButton fallback="/account/settings" /><div className="toc-heading-main"><h1>关于应用</h1></div></div>
    <section className="about-app-brand" aria-labelledby="about-app-name">
      <img className="about-app-logo" src="/static/pwa/icon-512.png" alt="" width="112" height="112" />
      <h2 id="about-app-name">Legado Reader</h2>
      <p className="muted small">编译时间</p>
      <time className="about-app-build-time" dateTime={buildTimestamp}>{buildTime}</time>
    </section>
    <nav className="settings-entry-list" aria-label="关于应用链接">
      <a className="settings-entry" href={repositoryUrl} target="_blank" rel="noreferrer">
        <span className="settings-entry-copy"><strong>GitHub 仓库</strong><span className="muted small">查看源代码与项目动态</span></span>
        <ExternalLink aria-hidden="true" />
      </a>
    </nav>
  </section>
}
