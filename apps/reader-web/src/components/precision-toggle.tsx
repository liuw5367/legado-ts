import { Check } from 'lucide-react'

export function PrecisionToggle({ checked, disabled = false, onChange }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <button className="precision-toggle" type="button" aria-label="精确搜索" aria-pressed={checked} disabled={disabled} onClick={() => onChange(!checked)}>
    <span className="precision-toggle-copy">
      <span className="precision-toggle-title">精确匹配</span>
      <span className="precision-toggle-description">仅显示书名、作者或分类命中的结果</span>
    </span>
    <span className="precision-toggle-state">{checked ? '已开启' : '已关闭'}</span>
    {checked ? <Check aria-hidden="true" /> : null}
  </button>
}
