const SHANGHAI_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** 与 CLI 一致，以东八区完整显示搜索和阅读数据的时间。 */
export function formatShanghaiDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  const parts = SHANGHAI_TIME_FORMATTER.formatToParts(date)
  const values = new Map(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${values.get('year')}-${values.get('month')}-${values.get('day')} ${values.get('hour')}:${values.get('minute')}:${values.get('second')}`
}
