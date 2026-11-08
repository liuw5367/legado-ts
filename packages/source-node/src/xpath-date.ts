/** Parse the SimpleDateFormat fields used by JsoupXpath format-date(). */
type PatternToken =
  | { kind: 'literal'; value: string }
  | { kind: 'field'; symbol: string; width: number; capture: number }

type WeekInfo = { firstDay: number; minimalDays: number }

const numericFields = new Set(['y', 'Y', 'w', 'W', 'D', 'd', 'F', 'u', 'H', 'k', 'K', 'h', 'm', 's', 'S'])
const supportedFields = new Set(['G', 'y', 'Y', 'M', 'w', 'W', 'D', 'd', 'F', 'E', 'u', 'a', 'H', 'k', 'K', 'h', 'm', 's', 'S', 'z', 'Z', 'X'])

/**
 * JsoupXpath returns the parsed java.util.Date through XValue.asString(), which
 * is Date.toString() rather than the input or a formatted value.
 */
export function androidXPathFormatDate(dateValue: unknown, patternValue: unknown, localeValue?: unknown): string {
  const value = xpathString(dateValue)
  const pattern = xpathString(patternValue)
  const simpleDateFormatOverload = localeValue !== undefined && localeValue !== null
    && !(Array.isArray(localeValue) && localeValue.length === 0)
  const locale = resolveLocale(localeValue)
  const parsed = parseDate(value, pattern, locale, simpleDateFormatOverload)
  if (parsed === null) throw new Error('date format exception!')
  return javaDateToString(parsed)
}

function xpathString(value: unknown): string {
  if (Array.isArray(value)) return value.map(xpathString).join(',')
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function resolveLocale(value: unknown): string {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
    return Intl.DateTimeFormat().resolvedOptions().locale
  }
  const tag = xpathString(value).replaceAll('_', '-')
  try { return new Intl.Locale(tag).toString() } catch { return 'en-US' }
}

function parseDate(value: string, pattern: string, locale: string, simpleDateFormatOverload: boolean): Date | null {
  const tokens = tokenize(pattern)
  // The locked FastDateFormat parser used by JsoupXpath 2.5.3 rejects `a` while
  // the three argument SimpleDateFormat overload accepts it.
  if (!simpleDateFormatOverload && tokens.some((token) => token.kind === 'field' && token.symbol === 'a')) return null
  const groups: Array<{ token: Extract<PatternToken, { kind: 'field' }>; index: number }> = []
  let groupIndex = 1
  let expression = '^\\s*'

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.kind === 'literal') {
      expression += escapeRegex(token.value)
      continue
    }
    const previous = tokens[index - 1]
    const next = tokens[index + 1]
    const textualMonth = token.symbol === 'M' && token.width >= 3
    const numeric = numericFields.has(token.symbol) || (token.symbol === 'M' && !textualMonth)
    if (numeric) {
      const adjacentNumeric = (previous?.kind === 'field' && isNumericField(previous))
        || (next?.kind === 'field' && isNumericField(next))
      const digitPattern = adjacentNumeric
        ? `\\d{${token.width}}`
        : token.symbol === 'M' ? '\\d{1,2}' : '\\d{1,9}'
      expression += `(${digitPattern})`
    } else {
      expression += `(${fieldPattern(token, locale)})`
    }
    groups.push({ token: { ...token, capture: groupIndex }, index: groupIndex })
    groupIndex += 1
  }

  let match: RegExpExecArray | null
  try { match = new RegExp(expression, 'iu').exec(value) } catch { return null }
  if (match === null) return null

  const state: Record<string, string> = {}
  let parsedYear: { value: number; twoDigits: boolean } | undefined
  let parsedWeekday: number | undefined
  let parsedDayPeriod: 'am' | 'pm' | undefined
  let parsedEra: 'ad' | 'bc' | undefined
  let parsedTimeZone: { value: string; symbol: string; width: number } | undefined
  for (const { token, index } of groups) {
    const raw = match[index] ?? ''
    const { symbol, width } = token
    if (symbol === 'y' || symbol === 'Y') {
      parsedYear = { value: Number(raw), twoDigits: width === 2 && /^\d{2}$/u.test(raw) }
    } else if (symbol === 'M') {
      const month = /^\d+$/u.test(raw) ? Number(raw) : monthNumber(raw, locale, width)
      if (month === null) return null
      state.M = String(month)
    } else if (symbol === 'E') {
      const weekday = weekdayNumber(raw, locale, width)
      if (weekday === null) return null
      parsedWeekday = weekday
    } else if (symbol === 'a') {
      const period = dayPeriod(raw, locale)
      if (period === null) return null
      parsedDayPeriod = period
    } else if (symbol === 'G') {
      const parsed = era(raw, locale, width)
      if (parsed === null) return null
      parsedEra = parsed
    } else if (symbol === 'z' || symbol === 'Z' || symbol === 'X') {
      parsedTimeZone = { value: raw, symbol, width }
    } else {
      state[symbol] = raw
    }
  }

  let year = parsedYear?.value ?? 1970
  let month = Number(state.M ?? 1)
  let day = Number(state.d ?? 1)
  const hourKind = state.H !== undefined ? 'H' : state.k !== undefined ? 'k' : state.K !== undefined ? 'K' : state.h !== undefined ? 'h' : 'H'
  let hour = Number(state.H ?? state.k ?? state.K ?? state.h ?? 0)
  const minute = Number(state.m ?? 0)
  const second = Number(state.s ?? 0)
  const millisecond = Number(state.S ?? 0)

  if (parsedEra === 'bc') year = 1 - year
  if (parsedYear?.twoDigits === true) year = expandTwoDigitYear(year, month, day)
  if (hourKind === 'h' && hour === 12) hour = 0
  if (hourKind === 'k' && hour === 24) hour = 0
  if (parsedDayPeriod === 'pm' && (hourKind === 'h' || hourKind === 'K')) hour += 12

  if (state.D !== undefined && state.d === undefined && state.M === undefined) {
    month = 1
    day = Number(state.D)
  } else if (state.d === undefined && state.D === undefined) {
    const weekday = weekdayNumberFromFields(parsedWeekday, state.u)
    if (state.F !== undefined && state.M !== undefined && weekday !== undefined) {
      day = firstWeekdayOfMonth(year, month, weekday) + (Number(state.F) - 1) * 7
    } else if (state.w !== undefined && weekday !== undefined) {
      const start = firstWeekStart(year, weekInfo(locale))
      return makeDate(year, month, day, hour, minute, second, millisecond, parsedTimeZone, locale, start + (Number(state.w) - 1) * 7 + weekdayOffset(utcDayOfWeekFromSerial(start), weekday))
    } else if (state.W !== undefined && state.M !== undefined && weekday !== undefined) {
      const start = firstWeekStartOfMonth(year, month, weekInfo(locale))
      return makeDate(year, month, day, hour, minute, second, millisecond, parsedTimeZone, locale, start + (Number(state.W) - 1) * 7 + weekdayOffset(utcDayOfWeekFromSerial(start), weekday))
    } else if (weekday !== undefined && state.M === undefined && state.w === undefined && state.W === undefined && parsedYear === undefined) {
      day = 1 + weekdayOffset(utcDayOfWeek(year, month, day), weekday)
    }
  }

  return makeDate(year, month, day, hour, minute, second, millisecond, parsedTimeZone, locale)
}

function tokenize(pattern: string): PatternToken[] {
  const tokens: PatternToken[] = []
  let literal = ''
  const flushLiteral = (): void => {
    if (literal.length > 0) tokens.push({ kind: 'literal', value: literal })
    literal = ''
  }

  for (let index = 0; index < pattern.length;) {
    const character = pattern[index]!
    if (character === "'") {
      if (pattern[index + 1] === "'") {
        literal += "'"
        index += 2
        continue
      }
      index += 1
      let closed = false
      while (index < pattern.length) {
        if (pattern[index] === "'") {
          if (pattern[index + 1] === "'") {
            literal += "'"
            index += 2
          } else {
            index += 1
            closed = true
            break
          }
        } else {
          literal += pattern[index]!
          index += 1
        }
      }
      if (!closed) throw new RangeError(`Illegal SimpleDateFormat pattern: ${pattern}`)
      continue
    }
    if (/[A-Za-z]/u.test(character)) {
      flushLiteral()
      let end = index + 1
      while (pattern[end] === character) end += 1
      if (!supportedFields.has(character)) throw new RangeError(`Illegal SimpleDateFormat field: ${character}`)
      tokens.push({ kind: 'field', symbol: character, width: end - index, capture: 0 })
      index = end
      continue
    }
    literal += character
    index += 1
  }
  flushLiteral()
  return tokens
}

function isNumericField(token: Extract<PatternToken, { kind: 'field' }>): boolean {
  return numericFields.has(token.symbol) || (token.symbol === 'M' && token.width < 3)
}

function fieldPattern(
  token: Extract<PatternToken, { kind: 'field' }>,
  locale: string,
): string {
  const { symbol, width } = token
  if (symbol === 'M') {
    const names = monthNames(locale, width)
    return `(?:\\d{1,2}|${alternation(names)}|[\\p{L}\\p{M}\\p{N}.]+)`
  }
  if (symbol === 'E') return alternation(weekdayNames(locale, width))
  if (symbol === 'a') return alternation(dayPeriodNames(locale))
  if (symbol === 'G') return alternation(eraNames(locale, width))
  if (symbol === 'X') return width === 1
    ? '(?:Z|[+-]\\d{2})'
    : width === 2 ? '(?:Z|[+-]\\d{4})' : '(?:Z|[+-]\\d{2}:\\d{2})'
  if (symbol === 'Z') return '(?:GMT(?:[+-]\\d{1,2}:?\\d{0,2})?|UTC|[+-]\\d{4})'
  if (symbol === 'z') return '[\\p{L}\\p{M}\\p{N}./:_+-]+(?:\\s+[\\p{L}\\p{M}\\p{N}./:_+-]+)*'
  return '.+'
}

function monthNames(locale: string, width: number): string[] {
  const style = width === 3 ? 'short' : width === 5 ? 'narrow' : 'long'
  return Array.from({ length: 12 }, (_, month) => new Intl.DateTimeFormat(locale, { month: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2020, month, 1))))
}

function monthNumber(value: string, locale: string, width: number): number | null {
  const normalized = normalizeName(value, locale)
  const numeric = /^(\d{1,2})/u.exec(normalized)
  if (numeric !== null) return Number(numeric[1])
  return monthNames(locale, width).findIndex((name) => normalizeName(name, locale) === normalized) + 1 || null
}

function weekdayNames(locale: string, width: number): string[] {
  const style = width >= 5 ? 'narrow' : width >= 4 ? 'long' : 'short'
  return Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2020, 5, 7 + day))))
}

function weekdayNumber(value: string, locale: string, width: number): number | null {
  const normalized = normalizeName(value, locale)
  const index = weekdayNames(locale, width).findIndex((name) => normalizeName(name, locale) === normalized)
  return index < 0 ? null : index
}

function dayPeriodNames(locale: string): string[] {
  return ['am', 'pm'].map((period) => {
    const hour = period === 'am' ? 1 : 13
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true, timeZone: 'UTC' })
      .formatToParts(new Date(Date.UTC(2020, 0, 1, hour)))
      .find((part) => part.type === 'dayPeriod')?.value ?? period.toUpperCase()
  })
}

function dayPeriod(value: string, locale: string): 'am' | 'pm' | null {
  const normalized = normalizeName(value, locale)
  const names = dayPeriodNames(locale)
  if (normalizeName(names[0]!, locale) === normalized) return 'am'
  if (normalizeName(names[1]!, locale) === normalized) return 'pm'
  return null
}

function eraNames(locale: string, width: number): string[] {
  const style = width >= 4 ? 'long' : width === 5 ? 'narrow' : 'short'
  return [-1, 1].map((year) => new Intl.DateTimeFormat(locale, { calendar: 'gregory', era: style, timeZone: 'UTC' })
    .formatToParts(new Date(Date.UTC(year < 0 ? 0 : 1, 0, 1)))
    .find((part) => part.type === 'era')?.value ?? (year < 0 ? 'BC' : 'AD'))
}

function era(value: string, locale: string, width: number): 'ad' | 'bc' | null {
  const normalized = normalizeName(value, locale)
  const names = eraNames(locale, width)
  if (normalizeName(names[0]!, locale) === normalized || /^(?:bc|bce)$/iu.test(value)) return 'bc'
  if (normalizeName(names[1]!, locale) === normalized || /^(?:ad|ce)$/iu.test(value)) return 'ad'
  return null
}

function alternation(values: string[]): string {
  return [...new Set(values)].sort((left, right) => right.length - left.length).map(escapeRegex).join('|')
}

function normalizeName(value: string, locale: string): string {
  return value.toLocaleLowerCase(locale).replace(/\.$/u, '').normalize('NFC')
}

function weekdayNumberFromFields(parsed: number | undefined, numeric: string | undefined): number | undefined {
  if (numeric !== undefined) {
    const value = Number(numeric)
    return value >= 1 && value <= 7 ? value % 7 : undefined
  }
  return parsed
}

function weekInfo(locale: string): WeekInfo {
  try {
    const info = (new Intl.Locale(locale) as unknown as { weekInfo?: { firstDay: number; minimalDays: number } }).weekInfo
    if (info !== undefined) return { firstDay: info.firstDay % 7, minimalDays: info.minimalDays }
  } catch { /* fall back to the common JDK locale defaults */ }
  return /(?:^|-)US(?:-|$)/iu.test(locale) ? { firstDay: 0, minimalDays: 1 } : { firstDay: 1, minimalDays: 4 }
}

function firstWeekStart(year: number, info: WeekInfo): number {
  const januaryFirst = utcDayNumber(year, 0, 1)
  let start = januaryFirst - ((utcDayOfWeek(year, 1, 1) - info.firstDay + 7) % 7)
  if (7 - (januaryFirst - start) < info.minimalDays) start += 7
  return start
}

function firstWeekStartOfMonth(year: number, month: number, info: WeekInfo): number {
  const first = utcDayNumber(year, month - 1, 1)
  let start = first - ((utcDayOfWeek(year, month, 1) - info.firstDay + 7) % 7)
  if (7 - (first - start) < info.minimalDays) start += 7
  return start
}

function firstWeekdayOfMonth(year: number, month: number, weekday: number): number {
  return 1 + (weekday - utcDayOfWeek(year, month, 1) + 7) % 7
}

function weekdayOffset(startDay: number, weekday: number): number {
  return (weekday - startDay + 7) % 7
}

function utcDayNumber(year: number, monthIndex: number, day: number): number {
  const date = new Date(0)
  date.setUTCFullYear(year, monthIndex, day)
  date.setUTCHours(0, 0, 0, 0)
  return Math.floor(date.getTime() / 86_400_000)
}

function utcDayOfWeek(year: number, month: number, day: number): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  return date.getUTCDay()
}

function utcDayOfWeekFromSerial(serial: number): number {
  return new Date(serial * 86_400_000).getUTCDay()
}

function makeDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  timeZone: { value: string; symbol: string; width: number } | undefined,
  locale: string,
  utcDay?: number,
): Date | null {
  let result: Date
  if (utcDay !== undefined) {
    const civilDate = new Date(utcDay * 86_400_000)
    const actualYear = civilDate.getUTCFullYear()
    const actualMonth = civilDate.getUTCMonth()
    const actualDay = civilDate.getUTCDate()
    if (timeZone === undefined) {
      result = new Date(0)
      result.setFullYear(actualYear, actualMonth, actualDay)
      result.setHours(hour, minute, second, millisecond)
    } else {
      const wall = new Date(0)
      wall.setUTCFullYear(actualYear, actualMonth, actualDay)
      wall.setUTCHours(hour, minute, second, millisecond)
      const offset = parseTimeZoneOffset(timeZone.value, timeZone.symbol, locale, wall.getTime())
      if (offset === null) return null
      result = new Date(wall.getTime() - offset * 60_000)
    }
  } else if (timeZone === undefined) {
    result = new Date(0)
    result.setFullYear(year, month - 1, day)
    result.setHours(hour, minute, second, millisecond)
  } else {
    const wall = new Date(0)
    wall.setUTCFullYear(year, month - 1, day)
    wall.setUTCHours(hour, minute, second, millisecond)
    const offset = parseTimeZoneOffset(timeZone.value, timeZone.symbol, locale, wall.getTime())
    if (offset === null) return null
    result = new Date(wall.getTime() - offset * 60_000)
  }
  return Number.isNaN(result.getTime()) ? null : result
}

function parseTimeZoneOffset(value: string, symbol: string, locale: string, instant: number): number | null {
  const trimmed = value.trim()
  if (/^(?:Z|UTC|GMT|UT|UCT)$/iu.test(trimmed)) return 0
  const numeric = /^(?:GMT|UTC)?([+-])(\d{1,2})(?::?(\d{2}))?$/iu.exec(trimmed)
  if (numeric !== null) {
    const hours = Number(numeric[2])
    const minutes = Number(numeric[3] ?? 0)
    if (hours > 23 || minutes > 59) return null
    return (numeric[1] === '+' ? 1 : -1) * (hours * 60 + minutes)
  }
  if (symbol === 'X' && /^Z$/iu.test(trimmed)) return 0

  const zoneAliases: Record<string, number> = {
    EST: -300, EDT: -240, CST: /(?:^|-)CN(?:-|$)/iu.test(locale) ? 480 : -360,
    CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420,
    JST: 540, KST: 540, HKT: 480, SGT: 480, ICT: 420,
    CET: 60, CEST: 120, EET: 120, EEST: 180, BST: 60,
    IST: /(?:^|-)IN(?:-|$)/iu.test(locale) ? 330 : 60,
  }
  const alias = zoneAliases[trimmed.toUpperCase()]
  if (alias !== undefined) return alias
  if (trimmed.includes('/')) return timeZoneOffsetForIana(trimmed, instant)
  const namedAliases: Record<string, string> = {
    'PACIFIC STANDARD TIME': 'America/Los_Angeles',
    'PACIFIC DAYLIGHT TIME': 'America/Los_Angeles',
    'CENTRAL STANDARD TIME': 'America/Chicago',
    'CENTRAL DAYLIGHT TIME': 'America/Chicago',
    'EASTERN STANDARD TIME': 'America/New_York',
    'EASTERN DAYLIGHT TIME': 'America/New_York',
    'CHINA STANDARD TIME': 'Asia/Shanghai',
    'JAPAN STANDARD TIME': 'Asia/Tokyo',
    'INDIA STANDARD TIME': 'Asia/Kolkata',
  }
  const named = namedAliases[trimmed.toUpperCase()]
  return named === undefined ? null : timeZoneOffsetForIana(named, instant)
}

function timeZoneOffsetForIana(timeZone: string, instant: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(instant))
    const part = (type: string): number => Number(parts.find((value) => value.type === type)?.value)
    const localAsUtc = utcDayNumber(part('year'), part('month') - 1, part('day')) * 86_400_000
      + part('hour') * 3_600_000 + part('minute') * 60_000 + part('second') * 1_000
    return Math.round((localAsUtc - instant) / 60_000)
  } catch { return null }
}

function expandTwoDigitYear(year: number, month: number, day: number): number {
  const start = new Date()
  start.setFullYear(start.getFullYear() - 80)
  const century = Math.floor(start.getFullYear() / 100) * 100
  let expanded = century + year
  const candidate = new Date(0)
  candidate.setFullYear(expanded, month - 1, day)
  candidate.setHours(0, 0, 0, 0)
  if (candidate.getTime() < start.getTime()) expanded += 100
  return expanded
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function javaDateToString(date: Date): string {
  const shortZone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT'
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const zoneAliases: Record<string, string> = {
    'Asia/Shanghai': 'CST',
    'Asia/Chongqing': 'CST',
    'Asia/Tokyo': 'JST',
    'Asia/Seoul': 'KST',
    'Asia/Kolkata': 'IST',
    'Asia/Singapore': 'SGT',
    'Asia/Bangkok': 'ICT',
  }
  const zone = zoneAliases[timeZone] ?? shortZone.replace(/^GMT([+-])(\d{1,2})$/u, (_value, sign: string, hour: string) => `GMT${sign}${hour.padStart(2, '0')}:00`)
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const twoDigits = (value: number): string => String(value).padStart(2, '0')
  return `${weekdays[date.getDay()]} ${months[date.getMonth()]} ${String(date.getDate()).padStart(2, '0')} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())} ${zone} ${date.getFullYear()}`
}
