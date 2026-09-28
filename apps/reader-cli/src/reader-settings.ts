import type { ReaderSettings } from './storage-model.ts'

export const READER_SETTINGS_DEFAULTS: ReaderSettings = {
  searchConcurrency: 4,
  sourceSearchConcurrency: 4,
  sourceCheckConcurrency: 4,
}

export const READER_SETTINGS_MIN = 1
export const READER_SETTINGS_MAX = 32

export type ReaderSettingKey = keyof ReaderSettings

export const READER_SETTING_FIELDS: readonly { key: ReaderSettingKey; label: string; description: string }[] = [
  { key: 'searchConcurrency', label: '搜索并发数', description: '搜索书源时同时处理的书源数' },
  { key: 'sourceSearchConcurrency', label: '换源搜索并发数', description: '搜索更多书源时同时处理的书源数' },
  { key: 'sourceCheckConcurrency', label: '书源检测并发数', description: '批量检测时同时处理的书源数' },
]

/** 将用户设置限制为有界的正整数，避免配置文件或输入框放大 worker 数。 */
export function normalizeReaderSettings(value: Partial<ReaderSettings> | undefined): ReaderSettings {
  return {
    searchConcurrency: normalizeField(value?.searchConcurrency, READER_SETTINGS_DEFAULTS.searchConcurrency),
    sourceSearchConcurrency: normalizeField(value?.sourceSearchConcurrency, READER_SETTINGS_DEFAULTS.sourceSearchConcurrency),
    sourceCheckConcurrency: normalizeField(value?.sourceCheckConcurrency, READER_SETTINGS_DEFAULTS.sourceCheckConcurrency),
  }
}

export function isReaderSettingValue(value: number): boolean {
  return Number.isSafeInteger(value) && value >= READER_SETTINGS_MIN && value <= READER_SETTINGS_MAX
}

function normalizeField(value: unknown, fallback: number): number {
  return typeof value === 'number' && isReaderSettingValue(value) ? value : fallback
}
