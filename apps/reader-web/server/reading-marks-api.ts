import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { ReaderRepository } from './db/repository.ts'
import { MarkError, markInputSchema, type CachedChapter, type MarkAnchor, type MarkQuery } from '../shared/reading-annotations.ts'
import { chapterIdFor } from './runtime/reader-runtime.ts'
import { XPathParserAdapter } from '@legado/source-node'
import { createCachedChapter, REMOVED_CHAPTER_TAGS, validTextAnchor, textFingerprint } from '../shared/reading-text.ts'

type Variables = { userId: string }
export function registerReadingMarksApi(app: Hono<{ Variables: Variables }>, repository: () => ReaderRepository, requireUser: (c: Context<{ Variables: Variables }>) => Promise<Response | undefined>) {
  const guard = (action: (c: Context<{ Variables: Variables }>) => Promise<Response>) => async (c: Context<{ Variables: Variables }>) => {
    try { const denied = await requireUser(c); return denied ?? await action(c) } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: { code: 'invalid-input', message: error instanceof z.ZodError ? error.issues[0]?.message ?? '参数无效' : '请求格式无效' } }, 400)
      if (error instanceof MarkError) return c.json({ error: { code: 'reading-mark-error', message: error.message } }, error.status)
      console.error('笔记操作失败', error instanceof Error ? error.name : 'unknown')
      return c.json({ error: { code: 'server-error', message: '笔记操作失败，请重试' } }, 500)
    }
  }
  const querySchema = z.object({ q: z.string().max(200).optional(), bookId: z.uuid().optional(), editionKey: z.string().max(2048).optional(), chapterUrl: z.string().max(8192).optional(), cursor: z.string().max(12000).optional(), deleted: z.enum(['true', 'false']).optional() })
  const query = (c: Context): MarkQuery => { const q = querySchema.parse(c.req.query()); return { ...Object.fromEntries(Object.entries(q).filter(([key, value]) => key !== 'deleted' && value !== undefined)), kind: 'annotations', deleted: q.deleted === 'true' } }
  app.get('/api/annotations/books', guard(async (c) => {
    const books = await repository().listReadingMarkBooks(c.get('userId'))
    return c.json({ books })
  }))
  app.get('/api/annotations', guard(async (c) => c.json(await repository().listReadingMarks(c.get('userId'), { ...query(c), order: 'created' }))))
  for (const kind of ['bookmarks', 'annotations'] as const) {
    app.get('/api/books/:bookId/' + kind, guard(async (c) => {
      const bookId = z.uuid().parse(c.req.param('bookId')); const repo = repository(); const userId = c.get('userId')
      if (!await repo.getBook(userId, bookId)) throw new MarkError(404, '书籍不存在')
      return c.json(await repo.listReadingMarks(userId, { ...query(c), bookId, kind }))
    }))
    app.put('/api/books/:bookId/' + kind + '/:id', guard(async (c) => {
      const bookId = z.uuid().parse(c.req.param('bookId')); const id = z.uuid().parse(c.req.param('id')); const input = markInputSchema.parse(await c.req.json()); const repo = repository(); const userId = c.get('userId')
      const book = await repo.getBook(userId, bookId)
      if (!book) throw new MarkError(404, '书籍不存在')
      // 已有笔记的文字身份不可被编辑请求替换；原文失效后仍允许修改想法和颜色。
      const current = input.expectedVersion === undefined ? undefined : (await repo.listReadingMarks(userId, { kind, bookId, id, all: true })).items.find((r) => r.id === id)
      let sourceName = current?.sourceName
      let cachedChapter: CachedChapter | null = current?.cachedChapter ?? null
      if (current) {
        if (!sameAnchor(current.anchor, input.anchor) || (['editionKey', 'chapterUrl', 'sourceFingerprint', 'chapterId', 'chapterIndex', 'chapterTitle', 'tocRevision'] as const).some((key) => current[key] !== input[key])) throw new MarkError(409, '不能修改原文位置，请重新选择')
      } else {
        const edition = await repo.getEdition(userId, bookId, input.editionKey)
        const toc = edition ? await repo.getToc(userId, bookId, input.editionKey) : null
        const chapter = toc?.chapters.find((r) => chapterIdFor(r) === input.chapterId && r.chapterUrl === input.chapterUrl)
        const content = toc && chapter ? await repo.getContent(userId, input.editionKey, toc.revision, input.chapterId) : null
        if (!edition || edition.sourceFingerprint !== input.sourceFingerprint || !toc || toc.revision !== input.tocRevision || !chapter || chapter.index !== input.chapterIndex || !content || textFingerprint(content.content.cleaned) !== input.anchor.contentHash) throw new MarkError(409, '正文已变化，请重新加载后选择')
        input.chapterTitle = chapter.title ?? ''
        let texts: string[]
        let paragraphBreaks: number[] = []
        if (content.content.contentType === 'text') {
          // 与阅读页一致：只以非空换行划分段落，缩进属于样式。
          texts = content.content.cleaned.split(/\n+/u).map((p) => p.trim()).filter(Boolean)
        } else {
          const parser = new XPathParserAdapter(); const doc = parser.parse('<div>' + content.content.cleaned + '</div>')
          for (const node of doc.select(REMOVED_CHAPTER_TAGS.join(','))) doc.mutate?.(node, { operation: 'remove' })
          texts = [String(parser.evaluate(doc, 'string(.)') ?? '')]
          paragraphBreaks = chapterParagraphBreaks(doc)
        }
        if (!validTextAnchor(texts, input.anchor, textFingerprint(content.content.cleaned))) throw new MarkError(400, '文字范围与正文不一致，请重新选择')
        cachedChapter = kind === 'annotations' ? createCachedChapter(texts, input.anchor, 2000, paragraphBreaks) : null

      }
      if (!sourceName) {
        const edition = await repo.getEdition(userId, bookId, input.editionKey)
        if (!edition) throw new MarkError(409, '书源已变化，请重新加载后选择')
        sourceName = (await repo.getSourceDisplayName(userId, edition.sourceId) ?? edition.sourceId).trim().slice(0, 256) || edition.sourceId.slice(0, 256)
      }
      return c.json({ item: await repo.mutateReadingMark(userId, { action: 'save', kind, id, bookId, input, bookName: book.name, author: book.author ?? null, sourceName, cachedChapter }) })
    }))
    for (const action of ['delete', 'restore'] as const) {
      const handler = guard(async (c) => {
        const bookId = z.uuid().parse(c.req.param('bookId')); const id = z.uuid().parse(c.req.param('id')); const input = z.object({ expectedVersion: z.number().int().min(0) }).strict().parse(await c.req.json()); const repo = repository(); const userId = c.get('userId')
        if (!await repo.getBook(userId, bookId)) throw new MarkError(404, '书籍不存在')
        return c.json({ item: await repo.mutateReadingMark(userId, { action, kind, id, bookId, expectedVersion: input.expectedVersion }) })
      })
      if (action === 'delete') app.delete('/api/books/:bookId/' + kind + '/:id', handler)
      else app.post('/api/books/:bookId/' + kind + '/:id/restore', handler)
    }
  }
  app.delete('/api/books/:bookId/annotations/:id/permanent', guard(async (c) => {
    const bookId = z.uuid().parse(c.req.param('bookId')); const id = z.uuid().parse(c.req.param('id')); const input = z.object({ expectedVersion: z.number().int().min(0) }).strict().parse(await c.req.json()); const repo = repository(); const userId = c.get('userId')
    if (!await repo.getBook(userId, bookId)) throw new MarkError(404, '书籍不存在')
    await repo.purgeReadingMark(userId, 'annotations', bookId, id, input.expectedVersion)
    return c.body(null, 204)
  }))
}

function sameAnchor(a: MarkAnchor, b: MarkAnchor) {
  return a.start.paragraphIndex === b.start.paragraphIndex && a.start.offset === b.start.offset &&
    a.end.paragraphIndex === b.end.paragraphIndex && a.end.offset === b.end.offset &&
    a.exact === b.exact && a.prefix === b.prefix && a.suffix === b.suffix && a.contentHash === b.contentHash
}

type ChapterHtmlNode = { nodeType: number; nodeName?: string; nodeValue?: string | null; textContent?: string | null; childNodes?: { length: number; item(index: number): ChapterHtmlNode | null } }
const chapterBlockTags = new Set(['blockquote', 'div', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ol', 'p', 'pre', 'ul'])
// 块级节点边界用于缓存预览排段；字符偏移仍来自正文 textContent。
function chapterParagraphBreaks(document: ReturnType<XPathParserAdapter['parse']>) {
  const root = document.children()[0]
  if (!root) return []
  const rootNode = document.raw(root) as ChapterHtmlNode
  const textLength = rootNode.textContent?.length ?? 0
  const breaks: number[] = []
  let offset = 0
  let lastBreak = 0
  const addBreak = () => {
    if (offset > lastBreak && offset < textLength) { breaks.push(offset); lastBreak = offset }
  }
  const visit = (node: ChapterHtmlNode) => {
    if (node.nodeType === 3 || node.nodeType === 4) { offset += node.nodeValue?.length ?? 0; return }
    const tag = (node.nodeName ?? '').toLowerCase()
    if (tag === 'br') { addBreak(); return }
    const block = chapterBlockTags.has(tag)
    if (block) addBreak()
    for (let index = 0; index < (node.childNodes?.length ?? 0); index++) {
      const child = node.childNodes?.item(index)
      if (child) visit(child)
    }
    if (block) addBreak()
  }
  visit(rootNode)
  return breaks
}
