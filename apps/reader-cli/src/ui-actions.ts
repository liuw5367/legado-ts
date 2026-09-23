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
    const keyToken = /^\[[^\]]*\]$/u.test(entry.action.keys) ? entry.action.keys : `[${entry.action.keys}]`
    const token = `${keyToken} ${entry.action.label}`
    const currentLength = terminalWidth(tokens.join('  '))
    const nextLength = tokens.length === 0 ? terminalWidth(token) : currentLength + 2 + terminalWidth(token)
    if (nextLength > width) continue
    tokens.push(token)
  }
  return tokens.join('  ')
}

export function layoutContextLine(left: string, right: string, columns: number): string {
  const width = Math.max(1, columns)
  const rightLimit = Math.min(terminalWidth(right), Math.floor(width * 0.55))
  const segments = right.split(' · ')
  let rightText = ''
  for (const segment of segments) {
    const candidate = rightText.length === 0 ? segment : `${rightText} · ${segment}`
    if (terminalWidth(candidate) > rightLimit) break
    rightText = candidate
  }
  if (rightText.length === 0) rightText = clipTerminalText(right, rightLimit)
  const rightWidth = terminalWidth(rightText)
  const leftWidth = Math.max(0, width - rightWidth - (rightText.length > 0 ? 1 : 0))
  const leftText = clipTerminalText(left, leftWidth)
  return rightText.length === 0 ? leftText : `${leftText}${' '.repeat(Math.max(1, width - terminalWidth(leftText) - rightWidth))}${rightText}`
}

/** Keep complete footer actions visible and use only the remaining cells for command input. */
export function layoutCommandLine(left: string, right: string, columns: number): string {
  const width = Math.max(1, columns)
  const rightWidth = terminalWidth(right)
  const leftWidth = Math.max(0, width - rightWidth - (right.length > 0 ? 1 : 0))
  const leftText = clipTerminalText(left, leftWidth)
  return right.length === 0 ? leftText : `${leftText}${' '.repeat(Math.max(1, width - terminalWidth(leftText) - rightWidth))}${right}`
}

export function clipTerminalText(value: string, width: number): string {
  const safeWidth = Math.max(0, width)
  let used = 0
  let result = ''
  for (const character of terminalSegments(value)) {
    const next = terminalWidth(character)
    if (used + next > safeWidth) break
    result += character
    used += next
  }
  return result
}

export function tailTerminalText(value: string, width: number): string {
  const safeWidth = Math.max(0, width)
  let used = 0
  const result: string[] = []
  const segments = terminalSegments(value)
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!
    const next = terminalWidth(segment)
    if (used + next > safeWidth) break
    result.unshift(segment)
    used += next
  }
  return result.join('')
}

/** Conservative terminal width for footer labels; CJK/full-width code points occupy two cells. */
export function terminalWidth(value: string): number {
  let width = 0
  for (const segment of terminalSegments(value)) {
    if (segment.length === 0) continue
    if (/\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u20e3/u.test(segment)) {
      width += 2
      continue
    }
    for (const character of segment) {
      const codePoint = character.codePointAt(0) ?? 0
      if (codePoint === 0x200d || codePoint === 0xfe0e || codePoint === 0xfe0f || codePoint >= 0x1f3fb && codePoint <= 0x1f3ff || isCombining(codePoint)) continue
      width += isFullWidth(codePoint) ? 2 : 1
    }
  }
  return width
}

const terminalSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function terminalSegments(value: string): string[] {
  return Array.from(terminalSegmenter.segment(value), (segment) => segment.segment)
}

function isCombining(codePoint: number): boolean {
  return codePoint >= 0x0300 && codePoint <= 0x036f || codePoint >= 0x1ab0 && codePoint <= 0x1aff || codePoint >= 0x1dc0 && codePoint <= 0x1dff || codePoint >= 0x20d0 && codePoint <= 0x20ff || codePoint >= 0xfe20 && codePoint <= 0xfe2f
}

function isFullWidth(codePoint: number): boolean {
  return codePoint >= 0x1100 && codePoint <= 0x115f || codePoint >= 0x2329 && codePoint <= 0x232a || codePoint >= 0x2e80 && codePoint <= 0xa4cf || codePoint >= 0xac00 && codePoint <= 0xd7a3 || codePoint >= 0xf900 && codePoint <= 0xfaff || codePoint >= 0xfe10 && codePoint <= 0xfe19 || codePoint >= 0xfe30 && codePoint <= 0xfe6f || codePoint >= 0xff00 && codePoint <= 0xff60 || codePoint >= 0xffe0 && codePoint <= 0xffe6 || codePoint >= 0x1f300 && codePoint <= 0x1faff
}
