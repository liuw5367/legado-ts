export interface FooterAction {
  keys: string
  label: string
  /** Lower values are retained first when a narrow terminal cannot fit all actions. */
  priority: number
}

/** Pack complete shortcut tokens into at most two lines without splitting a token. */
export function layoutFooter(actions: readonly FooterAction[], columns: number, maxLines = 2): string[] {
  const width = Math.max(20, columns)
  const ordered = actions
    .map((action, index) => ({ action, index }))
    .sort((left, right) => left.action.priority - right.action.priority || left.index - right.index)
  const selected: FooterAction[] = []
  const budget = width * maxLines
  let used = 0
  for (const entry of ordered) {
    const token = `[${entry.action.keys}] ${entry.action.label}`
    const cost = token.length + (selected.length === 0 ? 0 : 2)
    if (used + cost > budget && selected.length > 0) continue
    selected.push(entry.action)
    used += cost
  }
  const lines: string[] = []
  for (const action of selected) {
    const token = `[${action.keys}] ${action.label}`
    const current = lines.at(-1)
    if (current === undefined) {
      lines.push(token)
    } else if (current.length + 2 + token.length <= width) {
      lines[lines.length - 1] = `${current}  ${token}`
    } else if (lines.length < maxLines) {
      lines.push(token)
    }
  }
  return lines.length === 0 ? [''] : lines
}
