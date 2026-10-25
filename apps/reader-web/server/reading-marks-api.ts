import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { ReaderRepository } from './db/repository.ts'
import { MarkError, markInputSchema, type MarkQuery } from '../shared/reading-annotations.ts'
import { chapterIdFor } from './runtime/reader-runtime.ts'
import { textFingerprint } from '../shared/reading-text.ts'

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
    const rows = await repository().listReadingMarks(c.get('userId'), { kind: 'annotations', all: true })
    const books = [...new Map(rows.items.map((r) => [r.bookId, { id: r.bookId, name: r.bookName, author: r.author }])).values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    return c.json({ books })
  }))
  app.get('/api/annotations', guard(async (c) => c.json(await repository().listReadingMarks(c.get('userId'), query(c)))))
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
      const current = input.expectedVersion === undefined ? undefined : (await repo.listReadingMarks(userId, { kind, bookId, all: true })).items.find((r) => r.id === id)
      if (current) {
        if (JSON.stringify({ ...current.anchor }) !== JSON.stringify(input.anchor) || current.editionKey !== input.editionKey || current.chapterUrl !== input.chapterUrl || current.sourceFingerprint !== input.sourceFingerprint) throw new MarkError(409, '不能修改原文位置，请重新选择')
      } else {
        const edition = await repo.getEdition(userId, bookId, input.editionKey)
        const toc = edition ? await repo.getToc(userId, bookId, input.editionKey) : null
        const chapter = toc?.chapters.find((r) => chapterIdFor(r) === input.chapterId && r.chapterUrl === input.chapterUrl)
        const content = toc && chapter ? await repo.getContent(userId, input.editionKey, toc.revision, input.chapterId) : null
        if (!edition || edition.sourceFingerprint !== input.sourceFingerprint || !toc || toc.revision !== input.tocRevision || !chapter || chapter.index !== input.chapterIndex || !content || textFingerprint(content.content.cleaned) !== input.anchor.contentHash) throw new MarkError(409, '正文已变化，请重新加载后选择')
      }
      return c.json({ item: await repo.mutateReadingMark(userId, { action: 'save', kind, id, bookId, input, bookName: book.name, author: book.author ?? null }) })
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
}
