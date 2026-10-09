import type { ReaderHeaderSeparator, ReaderSettings } from './storage-model.ts'

export const READER_SETTINGS_DEFAULTS: ReaderSettings = {
  searchConcurrency: 4,
  sourceSearchConcurrency: 4,
  sourceCheckConcurrency: 4,
  showReaderBookTitle: true,
  showReaderChapterTitle: true,
  showReaderChapterIndex: true,
  showReaderPageProgress: true,
  showReaderWordCount: true,
  showReaderStatus: true,
  readerHeaderSeparator: 'dot',
}

export const READER_SETTINGS_MIN = 1
export const READER_SETTINGS_MAX = 32

export type NumericReaderSettingKey = 'searchConcurrency' | 'sourceSearchConcurrency' | 'sourceCheckConcurrency'
export type BooleanReaderSettingKey = 'showReaderBookTitle' | 'showReaderChapterTitle' | 'showReaderChapterIndex' | 'showReaderPageProgress' | 'showReaderWordCount' | 'showReaderStatus'
export type ReaderSettingKey = NumericReaderSettingKey | BooleanReaderSettingKey | 'readerHeaderSeparator'

export type ReaderSettingField =
  | { key: NumericReaderSettingKey; kind: 'number'; label: string; description: string }
  | { key: BooleanReaderSettingKey; kind: 'boolean'; label: string; description: string }
  | { key: 'readerHeaderSeparator'; kind: 'separator'; label: string; description: string }

export const READER_SETTING_FIELDS: readonly ReaderSettingField[] = [
  { key: 'searchConcurrency', kind: 'number', label: '搜索并发数', description: '搜索书源时同时处理的书源数' },
  { key: 'sourceSearchConcurrency', kind: 'number', label: '换源搜索并发数', description: '搜索更多书源时同时处理的书源数' },
  { key: 'sourceCheckConcurrency', kind: 'number', label: '书源检测并发数', description: '批量检测时同时处理的书源数' },
  { key: 'showReaderBookTitle', kind: 'boolean', label: '阅读页书名', description: '显示阅读页顶部左侧的书名' },
  { key: 'showReaderChapterTitle', kind: 'boolean', label: '阅读页章节名', description: '显示阅读页顶部左侧的章节名' },
  { key: 'showReaderChapterIndex', kind: 'boolean', label: '阅读页章节序号', description: '显示当前章节序号和总章节数' },
  { key: 'showReaderPageProgress', kind: 'boolean', label: '阅读页页码', description: '显示当前页和总页数' },
  { key: 'showReaderWordCount', kind: 'boolean', label: '阅读页字数', description: '显示当前章节的正文非空白字数' },
  { key: 'showReaderStatus', kind: 'boolean', label: '阅读页状态', description: '显示加载、刷新或保存状态' },
  { key: 'readerHeaderSeparator', kind: 'separator', label: '顶部连接符', description: '阅读页各项目之间的分隔方式' },
]

/** 将用户设置限制为有界的正整数，避免配置文件或输入框放大 worker 数。 */
export function normalizeReaderSettings(value: Partial<ReaderSettings> | undefined): ReaderSettings {
  return {
    searchConcurrency: normalizeField(value?.searchConcurrency, READER_SETTINGS_DEFAULTS.searchConcurrency),
    sourceSearchConcurrency: normalizeField(value?.sourceSearchConcurrency, READER_SETTINGS_DEFAULTS.sourceSearchConcurrency),
    sourceCheckConcurrency: normalizeField(value?.sourceCheckConcurrency, READER_SETTINGS_DEFAULTS.sourceCheckConcurrency),
    showReaderBookTitle: normalizeBoolean(value?.showReaderBookTitle, READER_SETTINGS_DEFAULTS.showReaderBookTitle),
    showReaderChapterTitle: normalizeBoolean(value?.showReaderChapterTitle, READER_SETTINGS_DEFAULTS.showReaderChapterTitle),
    showReaderChapterIndex: normalizeBoolean(value?.showReaderChapterIndex, READER_SETTINGS_DEFAULTS.showReaderChapterIndex),
    showReaderPageProgress: normalizeBoolean(value?.showReaderPageProgress, READER_SETTINGS_DEFAULTS.showReaderPageProgress),
    showReaderWordCount: normalizeBoolean(value?.showReaderWordCount, READER_SETTINGS_DEFAULTS.showReaderWordCount),
    showReaderStatus: normalizeBoolean(value?.showReaderStatus, READER_SETTINGS_DEFAULTS.showReaderStatus),
    readerHeaderSeparator: normalizeSeparator(value?.readerHeaderSeparator, READER_SETTINGS_DEFAULTS.readerHeaderSeparator),
  }
}

export function isReaderSettingValue(value: number): boolean {
  return Number.isSafeInteger(value) && value >= READER_SETTINGS_MIN && value <= READER_SETTINGS_MAX
}

function normalizeField(value: unknown, fallback: number): number {
  return typeof value === 'number' && isReaderSettingValue(value) ? value : fallback
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function isReaderHeaderSeparator(value: unknown): value is ReaderHeaderSeparator {
  return value === 'hidden' || value === 'dot' || value === 'dash'
}

function normalizeSeparator(value: unknown, fallback: ReaderHeaderSeparator): ReaderHeaderSeparator {
  return isReaderHeaderSeparator(value) ? value : fallback
}

export function readerSettingRawValue(settings: ReaderSettings, field: ReaderSettingField): string {
  return String(settings[field.key])
}

export function readerSettingDisplayValue(field: ReaderSettingField, rawValue: string): string {
  if (field.kind === 'boolean') return rawValue === 'true' ? '显示' : '隐藏'
  if (field.kind === 'separator') return rawValue === 'hidden' ? '隐藏' : rawValue === 'dot' ? '·' : rawValue === 'dash' ? '—' : '隐藏'
  return rawValue
}

export function updateReaderSetting(settings: ReaderSettings, field: ReaderSettingField, rawValue: string): ReaderSettings | undefined {
  if (field.kind === 'number') {
    const value = Number(rawValue)
    return isReaderSettingValue(value) ? { ...settings, [field.key]: value } : undefined
  }
  if (field.kind === 'boolean') {
    if (rawValue !== 'true' && rawValue !== 'false') return undefined
    return { ...settings, [field.key]: rawValue === 'true' }
  }
  return isReaderHeaderSeparator(rawValue) ? { ...settings, readerHeaderSeparator: rawValue } : undefined
}
