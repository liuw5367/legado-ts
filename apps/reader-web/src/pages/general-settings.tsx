import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { PageHeader } from '../components/page-header.tsx'
import { useId } from 'react'
import { Select } from '../components/ui/select.tsx'
import { useReaderSettings } from '../lib/settings-context.tsx'
import type { ApiBookshelfSortMode } from '../lib/api.ts'
import { DEFAULT_SEARCH_CONCURRENCY, MAX_SEARCH_CONCURRENCY, MIN_SEARCH_CONCURRENCY } from '../../shared/search-settings.ts'

export function GeneralSettingsPage() {
  const titleId = useId()
  const searchTitleId = useId()
  const { settings, saving, error, updateSettings } = useReaderSettings()

  return <section className="page-stack page-narrow general-settings-page">
    <PageHeader backTo="/account/settings" title="通用设置" description="调整书架和应用的通用偏好。" />
    <section className="settings-detail-section" aria-labelledby={titleId}>
      <h2 id={titleId}>书架</h2>
      <div className="reader-setting-row general-setting-row">
        <div><strong>书架排序</strong><p className="muted small">按最近加入或阅读时间排列，未读书籍排在末尾。</p></div>
        <label className="general-setting-select"><span className="sr-only">书架排序</span><Select value={settings.general.bookshelfSort} onChange={(event) => void updateSettings({ general: { bookshelfSort: event.target.value as ApiBookshelfSortMode } }).catch(() => undefined)}><option value="addedAt">加入时间</option><option value="lastReadAt">阅读时间</option></Select></label>
      </div>
    </section>
    <section className="settings-detail-section" aria-labelledby={searchTitleId}>
      <h2 id={searchTitleId}>书源搜索</h2>
      <div className="reader-setting-row general-setting-row">
        <div><strong>搜索并发数</strong><p className="muted small">同时搜索 5–20 个书源，默认 10 个。每个请求结束后等待 1 秒再补充下一个。</p></div>
        <label className="general-setting-select"><span className="sr-only">搜索并发数</span><Select value={settings.general.searchConcurrency ?? DEFAULT_SEARCH_CONCURRENCY} onChange={(event) => void updateSettings({ general: { searchConcurrency: Number(event.target.value) } }).catch(() => undefined)}>{Array.from({ length: MAX_SEARCH_CONCURRENCY - MIN_SEARCH_CONCURRENCY + 1 }, (_, index) => MIN_SEARCH_CONCURRENCY + index).map((value) => <option key={value} value={value}>{value} 个</option>)}</Select></label>
      </div>
    </section>
    {saving ? <p className="muted small" role="status">正在保存…</p> : null}
    {error === undefined ? null : <DismissibleMessage className="error compact-message" role="alert">{error}</DismissibleMessage>}
  </section>
}
