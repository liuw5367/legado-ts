import { BookOpen, Check, ChevronLeft, ChevronRight, CircleCheck, ExternalLink, LibraryBig, Search, X } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth-context.tsx'
import { markOnboardingSeen, onboardingReturnTo, onboardingSteps } from '../lib/onboarding.ts'

export function OnboardingPage() {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const savedStep = (location.state as { stepIndex?: unknown } | null)?.stepIndex
  const stepIndex = typeof savedStep === 'number' && Number.isInteger(savedStep) && savedStep >= 0 && savedStep < onboardingSteps.length ? savedStep : 0
  function setStepIndex(update: (current: number) => number) {
    navigate(location.pathname, { replace: true, state: { returnTo, stepIndex: update(stepIndex) } })
  }
  const step = onboardingSteps[stepIndex]!
  const returnTo = onboardingReturnTo((location.state as { returnTo?: unknown } | null)?.returnTo)
  const isLastStep = stepIndex === onboardingSteps.length - 1

  function leave(path = returnTo, state?: unknown) {
    if (user?.id) markOnboardingSeen(user.id)
    navigate(path, { replace: true, state })
  }

  function openPage() {
    if (user?.id) markOnboardingSeen(user.id)
    navigate(step.path, { state: { backTo: '/onboarding', backState: { returnTo, stepIndex } } })
  }

  return <main className="onboarding-page" aria-labelledby="onboarding-title">
    <header className="onboarding-topbar">
      <div className="onboarding-brand"><BookOpen aria-hidden="true" /><span>新手引导</span></div>
      <button className="onboarding-exit" type="button" onClick={() => leave()}><span>跳过引导</span><X aria-hidden="true" /></button>
    </header>

    <div className="onboarding-progress" role="group" aria-label={`第 ${stepIndex + 1} 步，共 ${onboardingSteps.length} 步`}>
      {onboardingSteps.map((item, index) => <span className={`onboarding-progress-segment${index <= stepIndex ? ' complete' : ''}`} key={item.title} />)}
    </div>

    <section className="onboarding-content" aria-live="polite">
      <div className="onboarding-copy">
        <p className="onboarding-kicker">第 {String(stepIndex + 1).padStart(2, '0')} 步 / 共 {onboardingSteps.length} 步</p>
        <h1 id="onboarding-title">{step.title}</h1>
        <p className="onboarding-description">{step.description}</p>
        <button className="button secondary onboarding-open-page" type="button" onClick={openPage}>
          {step.action}<ExternalLink aria-hidden="true" />
        </button>
      </div>
      <GuidePreview kind={step.preview} />
    </section>

    <footer className="onboarding-footer">
      <span className="onboarding-step-label">{stepIndex + 1} / {onboardingSteps.length}</span>
      <div className="onboarding-footer-actions">
        {stepIndex > 0 ? <button className="button secondary" type="button" onClick={() => setStepIndex((current) => current - 1)}><ChevronLeft aria-hidden="true" />上一步</button> : null}
        <button className="button" type="button" onClick={() => isLastStep ? leave() : setStepIndex((current) => current + 1)}>
          {isLastStep ? '完成引导' : '下一步'}{isLastStep ? <Check aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        </button>
      </div>
    </footer>
  </main>
}

function GuidePreview({ kind }: { kind: typeof onboardingSteps[number]['preview'] }) {
  return <div className="onboarding-preview" role="img" aria-label="操作界面示意">
    <div className="onboarding-preview-caption"><span className="onboarding-preview-dot" />界面示意</div>
    {kind === 'repository' ? <div className="guide-window">
      <div className="guide-window-heading"><LibraryBig aria-hidden="true" /><strong>书源管理</strong><span className="guide-window-button">导入</span></div>
      <div className="guide-repository">
        <span className="muted small">获取书源</span>
        <div className="guide-repository-row selected"><span><strong>源仓库 · 原网站</strong><small>www.yckceo.com</small></span><ExternalLink aria-hidden="true" /></div>
        <div className="guide-repository-row"><span><strong>源仓库 · yck2026.fun</strong><small>www.yck2026.fun</small></span><ExternalLink aria-hidden="true" /></div>
      </div>
      <p className="guide-window-note">从仓库复制订阅地址</p>
    </div> : null}
    {kind === 'import' ? <div className="guide-window">
      <div className="guide-window-title"><strong>导入书源</strong><span className="guide-mode">链接导入</span></div>
      <span className="guide-field-label">书源或订阅链接</span>
      <div className="guide-input">https://example.com/sources.json</div>
      <div className="guide-preview-status"><CircleCheck aria-hidden="true" /><span><strong>可导入书源 18</strong><small>检查列表后确认导入</small></span></div>
      <div className="guide-confirm">确认导入 18 项</div>
    </div> : null}
    {kind === 'search' ? <div className="guide-window">
      <div className="guide-window-title"><strong>搜索书籍</strong></div>
      <div className="guide-search-field"><Search aria-hidden="true" /><span>三体</span><span className="guide-search-button">搜索</span></div>
      <div className="guide-result"><span className="guide-cover guide-cover-ink">三体</span><span><strong>三体</strong><small>刘慈欣 · 科幻小说</small></span><ChevronRight aria-hidden="true" /></div>
      <div className="guide-result"><span className="guide-cover guide-cover-rust">三体Ⅱ</span><span><strong>三体Ⅱ：黑暗森林</strong><small>刘慈欣 · 科幻小说</small></span><ChevronRight aria-hidden="true" /></div>
    </div> : null}
    {kind === 'shelf' ? <div className="guide-window">
      <div className="guide-window-title"><strong>搜索结果</strong><span className="guide-result-count">12 个版本</span></div>
      <div className="guide-book-result"><span className="guide-cover guide-cover-ink">三体</span><span className="guide-book-copy"><strong>三体</strong><small>刘慈欣 · 科幻小说</small><small>笔趣阁 · 规则更新于今天</small></span></div>
      <div className="guide-book-action"><LibraryBig aria-hidden="true" />加入书架</div>
    </div> : null}
    {kind === 'details' ? <div className="guide-window guide-detail-window">
      <span className="guide-cover guide-cover-ink guide-detail-cover">三体</span>
      <div className="guide-detail-copy"><strong>三体</strong><span>刘慈欣</span><span className="guide-detail-tag">科幻 · 完结</span></div>
      <div className="guide-detail-rule" />
      <strong className="guide-intro-heading">内容简介</strong>
      <p className="guide-intro-copy">文化大革命如火如荼进行的同时，天文学家叶文洁向宇宙发出了讯号……</p>
      <div className="guide-detail-actions"><span><Search aria-hidden="true" />书籍信息</span><span><LibraryBig aria-hidden="true" />加入书架</span></div>
    </div> : null}
  </div>
}
