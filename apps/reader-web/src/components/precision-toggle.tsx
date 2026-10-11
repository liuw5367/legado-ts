import { Check } from 'lucide-react'

export function PrecisionToggle({ checked, disabled = false, onChange }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <button className="precision-toggle" type="button" aria-label="精确搜索" aria-pressed={checked} disabled={disabled} onClick={() => onChange(!checked)}>
    {checked ? <Check aria-hidden="true" /> : null}
    <span>精确</span>
  </button>
}
