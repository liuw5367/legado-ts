const DISPLAY_TIME_ZONE = 'Asia/Shanghai'

const displayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_TIME_ZONE,
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** Convert a stored ISO timestamp to the single user-facing time format. */
export function formatDisplayTime(value: string | undefined | null): string {
  if (value === undefined || value === null || value.trim().length === 0) return '未知'
  const trimmed = value.trim()
  const date = hasExplicitTimezone(trimmed) ? parseTimestamp(trimmed) : parseShanghaiLocal(trimmed) ?? parseTimestamp(trimmed)
  if (date === undefined) return '未知'
  const parts = Object.fromEntries(displayFormatter.formatToParts(date).map((part) => [part.type, part.value]))
  const year = parts.year
  const month = parts.month
  const day = parts.day
  const hour = parts.hour
  const minute = parts.minute
  const second = parts.second
  if ([year, month, day, hour, minute, second].some((part) => part === undefined)) return '未知'
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

/**
 * Source update times are not guaranteed to carry a timezone. Standard
 * date/time text is interpreted in the product's fixed Shanghai timezone;
 * other source-specific text is preserved rather than guessed.
 */
export function formatSourceTime(value: string | undefined | null): string {
  if (value === undefined || value === null || value.trim().length === 0) return '未知'
  const trimmed = value.trim()
  if (hasExplicitTimezone(trimmed)) return formatDisplayTime(trimmed)
  const local = parseShanghaiLocal(trimmed)
  return local === undefined ? trimmed : formatDate(local)
}

function parseTimestamp(value: string): Date | undefined {
  const timestamp = Date.parse(value.trim())
  if (!Number.isFinite(timestamp)) return undefined
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function parseShanghaiLocal(value: string): Date | undefined {
  const match = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/u.exec(value)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4] ?? 0)
  const minute = Number(match[5] ?? 0)
  const second = Number(match[6] ?? 0)
  const timestamp = Date.UTC(year, month - 1, day, hour - 8, minute, second)
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function formatDate(date: Date): string {
  const parts = Object.fromEntries(displayFormatter.formatToParts(date).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

function hasExplicitTimezone(value: string): boolean {
  return /(?:[zZ]|[+-]\d{2}:?\d{2}|\b(?:GMT|UTC)\b)$/iu.test(value)
}
