import { PageBackButton } from '../components/page-back-button.tsx'
import { Select } from '../components/ui/select.tsx'
import { useReaderSettings } from '../lib/settings-context.tsx'
import type { ApiBookshelfSortMode } from '../lib/api.ts'

export function GeneralSettingsPage() {
  const { settings, saving, error, updateSettings } = useReaderSettings()

  return <section className="page-stack page-narrow general-settings-page">
    <div className="toc-heading"><PageBackButton fallback="/account/settings" /><div className="toc-heading-main"><h1>通用设置</h1><p className="muted">调整书架和应用的通用偏好。</p></div></div>
    <section className="settings-detail-section" aria-labelledby="general-settings-shelf-title">
      <h2 id="general-settings-shelf-title">书架</h2>
      <div className="reader-setting-row general-setting-row">
        <div><strong>书架排序</strong><p className="muted small">按最近加入或阅读时间排列，未读书籍排在末尾。</p></div>
        <label className="general-setting-select"><span className="sr-only">书架排序</span><Select value={settings.general.bookshelfSort} onChange={(event) => void updateSettings({ general: { bookshelfSort: event.target.value as ApiBookshelfSortMode } }).catch(() => undefined)}><option value="addedAt">加入时间</option><option value="lastReadAt">阅读时间</option></Select></label>
      </div>
      {saving ? <p className="muted small" role="status">正在保存…</p> : null}
      {error === undefined ? null : <p className="error compact-message" role="alert">{error}</p>}
    </section>
  </section>
}
