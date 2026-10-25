import { useLayoutEffect, useRef, useState } from 'react'
import { Check, MessageSquare, Trash2 } from 'lucide-react'
import { MARK_COLORS, type ReadingMark } from '../../shared/reading-annotations.ts'

export function ReaderSelectionToolbar({ rect, mark, busy, onColor, onThought, onDelete, onClose }: { rect: DOMRect; mark: ReadingMark | null; busy: boolean; onColor: (color: ReadingMark['color']) => void; onThought: () => void; onDelete: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null); const [position, setPosition] = useState({ left: 12, top: 12 })
  useLayoutEffect(() => {
    function place() {
      const box = ref.current?.getBoundingClientRect(); const v = window.visualViewport; const left = v?.offsetLeft ?? 0; const top = v?.offsetTop ?? 0; const width = v?.width ?? window.innerWidth; const height = v?.height ?? window.innerHeight
      if (!box) return
      setPosition({ left: Math.max(left + 8, Math.min(rect.left + rect.width / 2 - box.width / 2, left + width - box.width - 8)), top: Math.max(top + 8, Math.min(rect.top - box.height - 8 >= top + 8 ? rect.top - box.height - 8 : rect.bottom + 8, top + height - box.height - 8)) })
    }
    place(); window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place)
    return () => { window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place) }
  }, [rect])
  return <div ref={ref} className="reader-selection-popover" style={position} onPointerDown={(event) => event.preventDefault()} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <div className="reader-selection-toolbar" role="toolbar" aria-label="文字标记操作">
      {MARK_COLORS.map((color) => <button type="button" className="mark-color-button" key={color.value} aria-label={color.label} title={color.label} aria-pressed={mark?.color === color.value} disabled={busy} onClick={() => onColor(color.value)}><span style={{ background: color.hex }}>{mark?.color === color.value ? <Check aria-hidden="true" /> : null}</span></button>)}
      <button type="button" className="mark-thought-button" disabled={busy} onClick={onThought}><MessageSquare aria-hidden="true" /><span>{mark?.note ? '编辑' : '想法'}</span></button>
      {mark ? <button type="button" className="mark-delete-button" aria-label="删除标记" title="删除标记" disabled={busy} onClick={onDelete}><Trash2 aria-hidden="true" /></button> : null}
    </div>
    {mark?.note ? <div className="reader-mark-thought"><span className="muted small">我的想法</span><p>{mark.note}</p></div> : null}
  </div>
}
