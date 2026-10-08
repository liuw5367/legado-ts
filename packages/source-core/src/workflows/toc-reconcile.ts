import type { Chapter } from './types.ts'

export interface TocReconcileBookState {
  /** 刷新前保存的目录数量。 */
  totalChapterNum: number
  /** 当前阅读章节索引。 */
  durChapterIndex: number
  /** 书籍模拟阅读开启时可见的章节数量；缺省使用新目录总数。 */
  simulatedTotalChapterNum?: number
}

export interface TocReconcileInput {
  chapters: readonly Chapter[]
  previousChapters?: readonly Chapter[]
  book: TocReconcileBookState
  /** Android 目录刷新使用的时钟；调用方负责注入当前毫秒时间。 */
  now: number
  /** Android AppConfig.tocCountWords；开启时延续旧章节元数据。 */
  carryMetadata?: boolean
}

export interface TocCarriedMetadata {
  index: number
  fields: Array<'wordCount' | 'variable' | 'imgUrl'>
}

export type TocChangeKind = 'added' | 'removed' | 'moved' | 'updated'

export interface TocChange {
  kind: TocChangeKind
  key: string
  index?: number
  previousIndex?: number
  chapter?: Chapter
  previousChapter?: Chapter
}

export interface TocBookPatch {
  durChapterTitle?: string
  latestChapterTitle?: string
  lastCheckCount?: number
  latestChapterTime?: number
  lastCheckTime: number
  totalChapterNum: number
}

export interface TocReconcileResult {
  chapters: Chapter[]
  bookPatch: TocBookPatch
  carriedMetadata: TocCarriedMetadata[]
  changes: TocChange[]
}

/**
 * 根据 Android BookChapterList 的刷新边界计算目录提交结果。
 *
 * 这里只做确定性的目录投影和差异计算，不读取数据库，也不写入书籍或章节存储。
 * 应用层可以把 `chapters`、`bookPatch` 和 `changes` 放进同一事务提交。
 */
export function reconcileTableOfContents(input: TocReconcileInput): TocReconcileResult {
  const chapters = input.chapters.map((chapter, index) => ({ ...chapter, index }))
  const previous = input.previousChapters ?? []
  const carriedMetadata: TocCarriedMetadata[] = []
  if (input.carryMetadata === true) carryChapterMetadata(chapters, previous, carriedMetadata)

  const previousTotal = finiteNonNegativeInteger(input.book.totalChapterNum)
  const currentTotal = chapters.length
  const hasNewChapters = previousTotal < currentTotal
  const simulatedTotal = finiteNonNegativeInteger(input.book.simulatedTotalChapterNum ?? currentTotal)
  const durationChapter = chapters[clampIndex(input.book.durChapterIndex, currentTotal)]
  const latestChapter = chapters[clampIndex(simulatedTotal - 1, currentTotal)]
  const bookPatch: TocBookPatch = {
    ...(durationChapter === undefined ? {} : { durChapterTitle: durationChapter.title }),
    ...(latestChapter === undefined ? {} : { latestChapterTitle: latestChapter.title }),
    ...(hasNewChapters ? { lastCheckCount: currentTotal - previousTotal, latestChapterTime: input.now } : {}),
    lastCheckTime: input.now,
    totalChapterNum: currentTotal,
  }

  return {
    chapters,
    bookPatch,
    carriedMetadata,
    changes: diffChapters(chapters, previous),
  }
}

function carryChapterMetadata(chapters: Chapter[], previous: readonly Chapter[], carried: TocCarriedMetadata[]): void {
  const oldByKey = new Map(previous.map((chapter) => [metadataKey(chapter), chapter]))
  for (const chapter of chapters) {
    const old = oldByKey.get(metadataKey(chapter))
    if (old === undefined) continue
    const fields: TocCarriedMetadata['fields'] = []
    for (const field of ['wordCount', 'variable', 'imgUrl'] as const) {
      const value = old[field]
      if (value === undefined) continue
      chapter[field] = value
      fields.push(field)
    }
    if (fields.length > 0) carried.push({ index: chapter.index, fields })
  }
}

function diffChapters(chapters: readonly Chapter[], previous: readonly Chapter[]): TocChange[] {
  const changes: TocChange[] = []
  const oldByKey = new Map(previous.map((chapter) => [chapterKey(chapter), chapter]))
  const currentKeys = new Set<string>()
  for (const chapter of chapters) {
    const key = chapterKey(chapter)
    currentKeys.add(key)
    const old = oldByKey.get(key)
    if (old === undefined) {
      changes.push({ kind: 'added', key, index: chapter.index, chapter })
      continue
    }
    if (old.index !== chapter.index) changes.push({ kind: 'moved', key, index: chapter.index, previousIndex: old.index, chapter, previousChapter: old })
    if (chapterFingerprint(old) !== chapterFingerprint(chapter)) changes.push({ kind: 'updated', key, index: chapter.index, previousIndex: old.index, chapter, previousChapter: old })
  }
  for (const old of previous) {
    const key = chapterKey(old)
    if (!currentKeys.has(key)) changes.push({ kind: 'removed', key, previousIndex: old.index, previousChapter: old })
  }
  return changes
}

function chapterKey(chapter: Pick<Chapter, 'url' | 'chapterUrl'>): string {
  return typeof chapter.url === 'string' && chapter.url.length > 0 ? chapter.url : chapter.chapterUrl
}

function metadataKey(chapter: Pick<Chapter, 'index' | 'title'>): string {
  return `${chapter.index}_${chapter.title}`
}

function chapterFingerprint(chapter: Chapter): string {
  return JSON.stringify([
    chapter.title,
    chapter.url,
    chapter.chapterUrl,
    chapter.baseUrl,
    chapter.isVolume,
    chapter.isVip,
    chapter.isPay,
    chapter.updateTime,
    chapter.wordCount,
    chapter.resourceUrl,
    chapter.start,
    chapter.end,
    chapter.startFragmentId,
    chapter.endFragmentId,
    chapter.variable,
    chapter.imgUrl,
  ])
}

function finiteNonNegativeInteger(value: number): number {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0
  return Number.isInteger(index) && index >= 0 && index < length ? index : length - 1
}
