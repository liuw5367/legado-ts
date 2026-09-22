export interface FooterAction {
  keys: string
  label: string
  /** Lower values are retained first when a narrow terminal cannot fit all actions. */
  priority: number
}

/** Pack complete shortcut tokens into one line; lower-priority actions are omitted when it is full. */
export function layoutFooter(actions: readonly FooterAction[], columns: number): string {
  const width = Math.max(1, columns)
  const ordered = actions
    .map((action, index) => ({ action, index }))
    .sort((left, right) => left.action.priority - right.action.priority || left.index - right.index)
  const tokens: string[] = []
  for (const entry of ordered) {
    const token = `[${entry.action.keys}] ${entry.action.label}`
    const currentLength = terminalWidth(tokens.join('  '))
    const nextLength = tokens.length === 0 ? terminalWidth(token) : currentLength + 2 + terminalWidth(token)
    if (nextLength > width) continue
    tokens.push(token)
  }
  return tokens.join('  ')
}

/** Conservative terminal width for footer labels; CJK/full-width code points occupy two cells. */
function terminalWidth(value: string): number {
  let width = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint === 0) continue
    if (isCombining(codePoint)) continue
    width += isFullWidth(codePoint) ? 2 : 1
  }
  return width
}

function isCombining(codePoint: number): boolean {
  return codePoint >= 0x0300 && codePoint <= 0x036f || codePoint >= 0x1ab0 && codePoint <= 0x1aff || codePoint >= 0x1dc0 && codePoint <= 0x1dff || codePoint >= 0x20d0 && codePoint <= 0x20ff || codePoint >= 0xfe20 && codePoint <= 0xfe2f
}

function isFullWidth(codePoint: number): boolean {
  return codePoint >= 0x1100 && codePoint <= 0x115f || codePoint >= 0x2329 && codePoint <= 0x232a || codePoint >= 0x2e80 && codePoint <= 0xa4cf || codePoint >= 0xac00 && codePoint <= 0xd7a3 || codePoint >= 0xf900 && codePoint <= 0xfaff || codePoint >= 0xfe10 && codePoint <= 0xfe19 || codePoint >= 0xfe30 && codePoint <= 0xfe6f || codePoint >= 0xff00 && codePoint <= 0xff60 || codePoint >= 0xffe0 && codePoint <= 0xffe6 || codePoint >= 0x1f300 && codePoint <= 0x1faff
}
