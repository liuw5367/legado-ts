import { applyOrganizationCommand } from '../../server/domain/book-organization.ts'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const HOST = 'localhost'
const PORT = 8787
const USER_ID = '11111111-1111-4111-8111-111111111111'
const BOOK_ID = '00000000-0000-0000-0000-000000000002'
const FIXTURE_EMAIL = 'reader@example.test'
const FIXTURE_PASSWORD = 'fixture-password'
const ACCESS_TOKEN = 'reader-web-page-fixture-token'
const REFRESH_TOKEN = 'reader-web-page-fixture-refresh-token'
const now = () => new Date().toISOString()

function longBookUrl(index) {
  const path = 'long-book-address-segment-'.repeat(18)
  return `https://source-${String(index + 1).padStart(2, '0')}.example.test/book/${path}star-sea-traveler`
}

const sources = Array.from({ length: 65 }, (_, index) => ({
  sourceId: `https://source-${String(index + 1).padStart(2, '0')}.example.test`,
  name: `示例书源 ${String(index + 1).padStart(2, '0')}`,
  group: index < 20 ? '公开示例' : '更多示例',
  fingerprint: `fixture-fingerprint-${index + 1}`,
  enabled: true,
  customOrder: index,
  sourceRevision: `fixture-revision-${index + 1}`,
  lastUpdateTime: Date.UTC(2026, 0, 1) + index * 60_000,
  origin: 'account',
}))

const books = new Map()
const editions = new Map()
const positions = new Map()
const bookshelf = new Set()
const organizations = new Map()
const shelfGroups = new Map()
const searches = new Map()
let discoveryFailure = true
let discoveryBookFailure = true
const searchHistory = []
const refreshCounts = new Map()
let searchSequence = 0

const initialBook = {
  id: BOOK_ID,
  userId: USER_ID,
  name: '星海旅人',
  author: '林简',
  intro: '一段关于远行、旧星图与归途的测试简介，用于核对详情页的多行文案布局。',
  coverUrl: '',
  activeEditionKey: 'edition-a',
  createdAt: now(),
  updatedAt: now(),
}
books.set(initialBook.id, initialBook)
bookshelf.add(initialBook.id)

for (const [index, editionKey] of ['edition-a', 'edition-b'].entries()) {
  const source = sources[index]
  if (source === undefined) continue
  const edition = {
    id: `fixture-${editionKey}`,
    userId: USER_ID,
    bookId: BOOK_ID,
    editionKey,
    sourceId: source.sourceId,
    sourceFingerprint: source.fingerprint,
    bookUrl: longBookUrl(index),
    metadata: {
      name: initialBook.name,
      author: initialBook.author,
      intro: initialBook.intro,
      kind: '科幻 · 示例',
      lastChapter: '第三十章 归航',
      updateTime: '2026-10-20 10:00',
      wordCount: '128 万字',
      searchDurationMs: 86,
      coverUrl: '',
    },
  }
  editions.set(editionKey, edition)
}

function chaptersFor(editionKey) {
  const edition = editions.get(editionKey)
  if (edition === undefined) return []
  return Array.from({ length: 30 }, (_, index) => {
    const chapterId = `${editionKey}-chapter-${index + 1}`
    const chapterUrl = `${edition.bookUrl}/chapter/${index + 1}?source-preview=${'long-url-'.repeat(16)}`
    return {
      chapterId,
      sourceId: edition.sourceId,
      bookUrl: edition.bookUrl,
      chapterUrl,
      index,
      title: `第${index + 1}章 ${['远方来信', '越过群星', '旧日航线', '漫长归途'][index % 4]}`,
      url: chapterUrl,
      isVolume: false,
      isVip: false,
      isPay: false,
    }
  })
}

for (const editionKey of editions.keys()) {
  const chapter = chaptersFor(editionKey)[editionKey === 'edition-a' ? 1 : 3]
  if (chapter === undefined) continue
  positions.set(`${BOOK_ID}:${editionKey}`, {
    userId: USER_ID,
    bookId: BOOK_ID,
    editionKey,
    chapterId: chapter.chapterId,
    chapterUrl: chapter.chapterUrl,
    chapterIndex: chapter.index,
    title: chapter.title,
    tocRevision: `fixture-toc-${editionKey}-1`,
    paragraphIndex: 2,
    offset: 18,
    version: 1,
    lastReadAt: now(),
  })
}

const settings = {
  userId: USER_ID,
  theme: 'system',
  readingMode: 'scroll',
  fontSize: 18,
  lineHeight: 1.9,
  marginTop: 16,
  marginRight: 16,
  marginBottom: 16,
  marginLeft: 16,
  general: { bookshelfSort: 'addedAt' },
  pageTapZones: { leftWidthPercent: 33, centerWidthPercent: 34, centerTopHeightPercent: 33, centerMiddleHeightPercent: 34, centerTopAction: 'previous', centerBottomAction: 'next' },
  updatedAt: now(),
}

function json(response, body, status = 200, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  response.end(JSON.stringify(body))
}

function noContent(response, headers = {}) {
  response.writeHead(204, { 'Cache-Control': 'no-store', ...headers })
  response.end()
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('请求体超过 1 MiB 测试限制')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function session(second = false) {
  const expiresIn = 60 * 60
  return {
    access_token: second ? ACCESS_TOKEN + '-second' : ACCESS_TOKEN,
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    refresh_token: second ? REFRESH_TOKEN + '-second' : REFRESH_TOKEN,
    user: {
      id: second ? '22222222-2222-4222-8222-222222222222' : USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: second ? 'reader2@example.test' : FIXTURE_EMAIL,
      email_confirmed_at: now(),
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      created_at: now(),
      updated_at: now(),
    },
  }
}

function corsHeaders(origin) {
  const allowed = origin === 'http://localhost:3000' || origin === 'http://127.0.0.1:3000'
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info, x-supabase-api-version',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  }
}

function displayBook(book) {
  const edition = editions.get(book.activeEditionKey)
  return edition === undefined ? undefined : { book, edition }
}

function positionFor(bookId, editionKey) {
  return positions.get(`${bookId}:${editionKey}`) ?? null
}

function editionKeyForSource(sourceId) {
  const index = sources.findIndex((source) => source.sourceId === sourceId)
  if (index === 0) return 'edition-a'
  if (index === 1) return 'edition-b'
  return `fixture-edition-${String(index + 1).padStart(2, '0')}`
}

function detailFor(bookId, editionKey) {
  const book = books.get(bookId)
  const edition = editions.get(editionKey || book?.activeEditionKey)
  if (book === undefined || edition === undefined || edition.bookId !== bookId) return null
  const source = sources.find((item) => item.sourceId === edition.sourceId)
  const position = positionFor(bookId, edition.editionKey)
  return {
    book,
    edition: {
      editionKey: edition.editionKey,
      sourceId: edition.sourceId,
      sourceFingerprint: edition.sourceFingerprint,
      bookUrl: edition.bookUrl,
      metadata: edition.metadata,
    },
    sourceName: source?.name ?? edition.sourceId,
    onBookshelf: bookshelf.has(bookId),
    reading: position === null ? null : {
      editionKey: position.editionKey,
      chapterId: position.chapterId,
      chapterUrl: position.chapterUrl,
      chapterIndex: position.chapterIndex,
      title: position.title,
      tocRevision: position.tocRevision,
      paragraphIndex: position.paragraphIndex,
      offset: position.offset,
      version: position.version,
      lastReadAt: position.lastReadAt,
    },
  }
}

function managedSourcePage(url) {
  const query = (url.searchParams.get('query') ?? '').trim().toLocaleLowerCase()
  const status = url.searchParams.get('status') ?? 'all'
  const filtered = sources.filter((source) => {
    const matchesQuery = query.length === 0 || `${source.name} ${source.group ?? ''} ${source.sourceId}`.toLocaleLowerCase().includes(query)
    const matchesStatus = status === 'all' || (status === 'enabled' ? source.enabled : !source.enabled)
    return matchesQuery && matchesStatus
  })
  const all = url.searchParams.get('all') === 'true'
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1))
  const pageSize = Math.max(1, Math.min(50, Number(url.searchParams.get('pageSize') ?? 50)))
  const pageSources = all ? filtered : filtered.slice((page - 1) * pageSize, page * pageSize)
  return { sources: pageSources, page: all ? 1 : page, pageSize: all ? filtered.length : pageSize, total: filtered.length, enabledCount: filtered.filter((source) => source.enabled).length }
}

function homeSnapshot() {
  const visibleBooks = [...books.values()].map(displayBook).filter((value) => value !== undefined)
  const shelfItems = visibleBooks.filter(({ book }) => bookshelf.has(book.id)).map(({ book, edition }) => {
    const position = positionFor(book.id, edition.editionKey)
    return position === null ? { book, edition, groupId: shelfGroups.get(book.id) ?? null } : { book, edition, position, groupId: shelfGroups.get(book.id) ?? null }
  })
  const seenReadingBooks = new Set()
  const readingItems = [...positions.values()].sort((left, right) => right.lastReadAt.localeCompare(left.lastReadAt)).flatMap((position) => {
    const book = books.get(position.bookId)
    const edition = editions.get(position.editionKey)
    if (book === undefined || edition === undefined || seenReadingBooks.has(book.id)) return []
    seenReadingBooks.add(book.id)
    return [{ book, edition, position }]
  })
  return {
    bookshelf: shelfItems,
    reading: readingItems,
    searchHistory: [...searchHistory].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 50),
  }
}

function candidateFor(source, keyword) {
  const index = sources.indexOf(source)
  return {
    sourceId: source.sourceId,
    sourceFingerprint: source.fingerprint,
    searchDurationMs: 80 + index * 7,
    candidate: {
      sourceId: source.sourceId,
      bookUrl: longBookUrl(index),
      name: '星海旅人',
      author: '林简',
      intro: `本地页面测试数据：${keyword}。详情简介较长，用于检查按钮、卡片和窄屏布局。`.repeat(2),
      kind: '科幻 · 示例',
      lastChapter: '第三十章 归航',
      updateTime: '2026-10-20 10:00',
      wordCount: '128 万字',
    },
  }
}

function addSearchHistory(search, resultCount) {
  const timestamp = now()
  const row = {
    id: randomUUID(),
    searchId: search.id,
    keyword: search.keyword,
    sourceIds: search.sourceIds,
    status: search.cancelled ? 'cancelled' : 'completed',
    resultCount,
    summary: search.cancelled ? '搜索已取消，保留已有结果' : `${resultCount} 个来源返回结果`,
    createdAt: search.createdAt,
    updatedAt: timestamp,
  }
  const previousIndex = searchHistory.findIndex((item) => item.searchId === search.id)
  if (previousIndex < 0) searchHistory.unshift(row)
  else searchHistory[previousIndex] = row
}

function safeRouteLabel(pathname) {
  return pathname
    .replace(/^\/api\/books\/[^/]+/u, '/api/books/:bookId')
    .replace(/^\/api\/searches\/[^/]+/u, '/api/searches/:searchId')
    .replace(/^\/api\/search-history\/[^/]+/u, '/api/search-history/:historyId')
}

function logRequest(request, url) {
  const safeQuery = url.searchParams.get('refresh') === 'true' ? ' refresh=true' : url.searchParams.get('all') === 'true' ? ' all=true' : ''
  console.log(`${request.method} ${safeRouteLabel(url.pathname)}${safeQuery}`)
}

function writeSse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function startSearchStream(request, response, search) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const candidates = []
  const sourceIds = search.sourceIds.length > 0 ? search.sourceIds : sources.filter((source) => source.enabled).map((source) => source.sourceId)
  const selectedSources = sourceIds.map((sourceId) => sources.find((source) => source.sourceId === sourceId)).filter((source) => source !== undefined).slice(0, 5)
  const sourceStates = selectedSources.map((source) => ({ sourceId: source.sourceId, status: 'completed' }))
  let index = 0
  let timer
  let closed = false
  const close = () => { closed = true; clearTimeout(timer) }
  request.on('aborted', close)
  response.on('close', close)

  const sendNext = () => {
    if (closed || response.destroyed) return
    if (search.cancelled) {
      writeSse(response, 'done', { search: { cancelled: true, candidates, progress: { completed: index, total: selectedSources.length } } })
      addSearchHistory(search, candidates.length)
      response.end()
      return
    }
    const source = selectedSources[index]
    if (source !== undefined) {
      candidates.push(candidateFor(source, search.keyword))
      index += 1
      writeSse(response, 'source-result', {
        source: { sourceId: source.sourceId, status: 'completed', candidates: [candidates.at(-1)] },
        search: { candidates, sourceStates, progress: { completed: index, total: selectedSources.length } },
      })
      timer = setTimeout(sendNext, 80)
      return
    }
    writeSse(response, 'batch-end', { search: { candidates, sourceStates, progress: { completed: index, total: selectedSources.length } } })
    writeSse(response, 'done', { search: { candidates, sourceStates, progress: { completed: index, total: selectedSources.length } } })
    addSearchHistory(search, candidates.length)
    response.end()
  }
  sendNext()
}

async function handleAuth(request, response, url) {
  const cors = corsHeaders(request.headers.origin ?? '')
  if (request.method === 'OPTIONS') { response.writeHead(204, cors); response.end(); return true }
  if (!url.pathname.startsWith('/auth/v1/')) return false
  if (request.method === 'POST' && url.pathname === '/auth/v1/token') {
    const body = await readJson(request)
    if (url.searchParams.get('grant_type') === 'refresh_token' && [REFRESH_TOKEN, REFRESH_TOKEN + '-second'].includes(body.refresh_token)) {
      json(response, session(body.refresh_token.endsWith('-second')), 200, cors)
      return true
    }
    if (![FIXTURE_EMAIL, 'reader2@example.test'].includes(body.email) || body.password !== FIXTURE_PASSWORD) {
      json(response, { code: 400, error_code: 'invalid_credentials', msg: '测试账号或密码不正确' }, 400, cors)
      return true
    }
    json(response, session(body.email === 'reader2@example.test'), 200, cors)
    return true
  }
  if (request.method === 'GET' && url.pathname === '/auth/v1/user') {
    if (![ACCESS_TOKEN, ACCESS_TOKEN + '-second'].some((token) => request.headers.authorization === `Bearer ${token}`)) json(response, { message: '测试会话无效' }, 401, cors)
    else json(response, session(request.headers.authorization === `Bearer ${ACCESS_TOKEN}-second`).user, 200, cors)
    return true
  }
  if (request.method === 'POST' && url.pathname === '/auth/v1/logout') { noContent(response, cors); return true }
  json(response, { message: '页面验收服务未实现此认证端点' }, 404, cors)
  return true
}

async function handleOrganization(request, response, url) {
  const path = url.pathname; const method = request.method ?? 'GET'
  if (!path.startsWith('/api/book-lists') && !path.startsWith('/api/bookshelf-groups') && !path.endsWith('/bookshelf/group')) return false
  if (![ACCESS_TOKEN, ACCESS_TOKEN + '-second'].some((token) => request.headers.authorization === `Bearer ${token}`)) { json(response, { error: { message: '需要登录' } }, 401); return true }
  const second = request.headers.authorization === `Bearer ${ACCESS_TOKEN}-second`
  const userId = second ? session(true).user.id : USER_ID
  const organization = organizations.get(userId) ?? { lists: [], items: [] }
  const state = { ...structuredClone(organization), shelf: new Map(second ? [] : [...bookshelf].map((id) => [id, shelfGroups.get(id) ?? null])), bookIds: new Set(second ? [] : books.keys()) }
  const parts = path.split('/'); const isGroups = parts[2] === 'bookshelf-groups'
  const type = isGroups ? 'shelf_group' : 'booklist'
  const members = (listId) => state.items.filter((row) => row.bookListId === listId).sort((a, b) => b.addedAt.localeCompare(a.addedAt))
  const groupRows = () => state.lists.filter((row) => row.type === 'shelf_group').sort((a, b) => a.customOrder - b.customOrder).map((row) => ({ ...row, bookCount: [...state.shelf.values()].filter((id) => id === row.id).length }))
  if (method === 'GET') {
    if (isGroups) json(response, { groups: groupRows(), ungroupedCount: [...state.shelf.values()].filter((id) => id === null).length })
    else if (parts.length === 3) json(response, { lists: state.lists.filter((row) => row.type === 'booklist').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((row) => ({ ...row, bookCount: members(row.id).length, coverBooks: members(row.id).slice(0, 4).map((item) => books.get(item.bookId)), containsBook: members(row.id).some((item) => item.bookId === url.searchParams.get('bookId')) })) })
    else { const list = state.lists.find((row) => row.id === parts[3] && row.type === 'booklist'); if (!list) { json(response, { error: { message: '书单不存在' } }, 404); return true } json(response, { list, items: members(list.id).map((row) => ({ ...row, book: books.get(row.bookId), edition: editions.get(books.get(row.bookId)?.activeEditionKey), position: positions.get(row.bookId) })) }) }
    return true
  }
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readJson(request) : {}
  const createdId = randomUUID()
  let command
  if (path.endsWith('/bookshelf/group')) command = { kind: 'assign', bookId: parts[3], groupId: body.groupId }
  else if (parts[3] === 'order') command = { kind: 'order', groupIds: body.groupIds }
  else if (parts[4] === 'books') command = { kind: method === 'PUT' ? 'add' : method === 'DELETE' ? 'remove' : method === 'PATCH' ? 'review' : 'move', id: parts[3], bookId: parts[5], ...body }
  else if (method === 'POST') command = { kind: 'create', id: createdId, type, ...body }
  else command = { kind: method === 'DELETE' ? 'delete' : 'edit', type, id: parts[3], ...body }
  try { applyOrganizationCommand(state, userId, command) } catch (error) { json(response, { error: { message: error.message } }, error.status ?? 400); return true }
  organizations.set(userId, { lists: state.lists, items: state.items })
  if (!second) { bookshelf.clear(); shelfGroups.clear(); for (const [id, group] of state.shelf) { bookshelf.add(id); shelfGroups.set(id, group) } }
  const currentSettings = second ? secondSettings : settings
  if (command.kind === 'delete' && currentSettings.general.bookshelfInitialGroup === command.id) currentSettings.general.bookshelfInitialGroup = 'all'
  const created = state.lists.find((row) => row.id === createdId)
  json(response, { ok: true, list: created ?? state.lists.find((row) => row.id === parts[3]), group: created, groups: groupRows(), listUpdatedAt: state.lists.find((row) => row.id === parts[3])?.updatedAt }, method === 'POST' && created ? 201 : 200)
  return true
}

async function handleApi(request, response, url) {
  if (await handleOrganization(request, response, url)) return
  // 第二账号使用空账号数据，绝不读取或修改第一账号的书籍与书源。
  if (request.headers.authorization === `Bearer ${ACCESS_TOKEN}-second`) {
    const path = url.pathname
    if (path === '/api/home') { json(response, { bookshelf: [], reading: [], searchHistory: [] }); return }
    if (path === '/api/me') { json(response, { user: session(true).user }); return }
    if (path === '/api/books') { json(response, { books: [] }); return }
    if (path === '/api/sources' || path === '/api/source-management' || path === '/api/discovery/sources') { json(response, { sources: [] }); return }
    if (path === '/api/settings') {
      if (request.method === 'PUT') Object.assign(secondSettings, await readJson(request))
      json(response, { settings: secondSettings }); return
    }
    json(response, { error: { code: 'not-found', message: '第二测试账号没有此资源' } }, 404); return
  }
  if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
    json(response, { error: { code: 'unauthorized', message: '请使用页面验收账号登录' } }, 401)
    return
  }
  const path = url.pathname
  const method = request.method ?? 'GET'

  if (method === 'GET' && path === '/api/me') { json(response, { user: { id: USER_ID } }); return }
  if (method === 'GET' && path === '/api/home') { json(response, homeSnapshot()); return }
  if (method === 'GET' && path === '/api/discovery/sources') {
    json(response, { sources: sources.filter((source) => source.enabled).map(({ sourceId, name, group, fingerprint }) => ({ sourceId, name, group, fingerprint })) }); return
  }
  if (method === 'GET' && path === '/api/discovery/categories') {
    const source = sources.find((item) => item.sourceId === url.searchParams.get('sourceId'))
    if (source === undefined) { json(response, { error: { code: 'not-found', message: '书源不存在' } }, 404); return }
    const dynamic = source === sources[3]
    json(response, { source, categories: dynamic ? [] : ['热门', '新书', '完结', '玄幻', '都市', '科幻', '历史', '轻小说'].map((title, index) => ({ id: `category-${index}`, title })), ...(dynamic ? { message: '此书源使用动态发现分类，暂不支持，请切换书源或使用搜索。' } : {}) }); return
  }
  if (method === 'POST' && (path === '/api/discovery/page' || path === '/api/discovery/books')) {
    const body = await readJson(request)
    const source = sources.find((item) => item.sourceId === body.sourceId)
    if (source === undefined) { json(response, { error: { code: 'not-found', message: '书源不存在' } }, 404); return }
    const index = body.cursor?.index ?? 1
    const fixtureCursor = (page) => ({ index: page, signature: `fixture-${source.fingerprint}-${body.categoryId}-${page}` })
    const names = ['星海旅人', '长安夜行', '山河之间', '春日来信', '无人知晓的远方与漫长归途：一位旅人的星际见闻录', '旧城拾光', '雨落之前', '浮生小记', '人间烟火', '一叶知秋', '雪山来客', '群星之外']
    const items = source === sources[1] ? [] : names.map((name, offset) => ({ sourceId: source.sourceId, bookUrl: `${source.sourceId}/discover/${body.categoryId}/${index}/${offset}`, name: index > 1 ? name + ' · 续篇' : name, author: ['林简', '江南客', '陈一'][offset % 3], intro: '在平凡生活与远方之间，寻找属于自己的故事。此处为本地页面验收数据。', kind: body.categoryId === 'category-1' ? '新书 · 连载' : '热门 · 完结', lastChapter: '最新章节：第三十章 归航', coverUrl: '' }))
    if (path === '/api/discovery/page') {
      if (source === sources[2] && index === 2 && discoveryFailure) { discoveryFailure = false; json(response, { error: { code: 'source-failed', message: '分页请求暂时失败，请重试' } }, 500); return }
      json(response, { items, cursor: fixtureCursor(index), ...(items.length > 0 && index < 3 ? { nextCursor: fixtureCursor(index + 1) } : {}), status: items.length === 0 ? 'empty' : 'success' }); return
    }
    if (source === sources[4] && discoveryBookFailure) { discoveryBookFailure = false; json(response, { error: { code: 'source-failed', message: '书籍详情暂时失败，请重试' } }, 500); return }
    const selected = items.find((item) => item.bookUrl === body.bookUrl)
    if (selected === undefined) { json(response, { error: { code: 'invalid-input', message: '列表已更新，请刷新后重试' } }, 400); return }
    const existing = [...editions.values()].find((edition) => edition.bookUrl === selected.bookUrl)
    const bookId = existing?.bookId ?? randomUUID()
    const editionKey = existing?.editionKey ?? randomUUID()
    if (existing === undefined) {
      books.set(bookId, { ...initialBook, id: bookId, name: selected.name, author: selected.author, intro: selected.intro, activeEditionKey: editionKey })
      editions.set(editionKey, { id: randomUUID(), userId: USER_ID, bookId, editionKey, sourceId: source.sourceId, sourceFingerprint: source.fingerprint, bookUrl: selected.bookUrl, metadata: { ...selected, tocUrl: '/toc' } })
    }
    json(response, { book: { id: bookId }, edition: { editionKey } }, 201); return
  }
  if (method === 'GET' && path === '/api/sources') {
    json(response, { sources: sources.filter((source) => source.enabled).map(({ sourceId, name, group, fingerprint, enabled }) => ({ sourceId, name, group, fingerprint, enabled })) })
    return
  }
  if (method === 'GET' && path === '/api/source-management') { json(response, managedSourcePage(url)); return }
  if (method === 'POST' && path === '/api/source-management/actions') {
    const body = await readJson(request)
    let affected = 0
    for (const item of body.items ?? []) {
      const source = sources.find((candidate) => candidate.sourceId === item.sourceId)
      if (source === undefined) continue
      if (body.action === 'enable') {
        const host = new URL(source.sourceId).host
        for (const sibling of sources) if (new URL(sibling.sourceId).host === host) sibling.enabled = false
        source.enabled = true
      } else if (body.action === 'disable') source.enabled = false
      else if (body.action === 'delete') sources.splice(sources.indexOf(source), 1)
      affected += 1
    }
    json(response, { affected })
    return
  }
  if (method === 'GET' && path === '/api/settings') { json(response, { settings }); return }
  if (method === 'PUT' && path === '/api/settings') {
    const patch = await readJson(request)
    Object.assign(settings, patch, { general: { ...settings.general, ...patch.general }, updatedAt: now() })
    json(response, { settings })
    return
  }
  if (method === 'POST' && path === '/api/searches') {
    const body = await readJson(request)
    const id = `fixture-search-${++searchSequence}`
    const search = { id, keyword: String(body.keyword ?? ''), sourceIds: Array.isArray(body.sourceIds) ? body.sourceIds : [], precision: body.precision === true, cancelled: false, createdAt: now() }
    searches.set(id, search)
    json(response, { search: { id } }, 201)
    return
  }
  const searchMatch = path.match(/^\/api\/searches\/([^/]+)(?:\/(stream|cancel))?$/u)
  if (searchMatch !== null) {
    const search = searches.get(decodeURIComponent(searchMatch[1] ?? ''))
    if (search === undefined) { json(response, { error: { code: 'not-found', message: '测试搜索任务不存在' } }, 404); return }
    if (method === 'POST' && searchMatch[2] === 'cancel') { search.cancelled = true; json(response, { search: { id: search.id, cancelled: true } }); return }
    if (method === 'GET' && searchMatch[2] === 'stream') { startSearchStream(request, response, search); return }
    if (method === 'GET' && searchMatch[2] === undefined) { json(response, { search: { id: search.id, keyword: search.keyword, status: search.cancelled ? 'cancelled' : 'completed', candidates: [] } }); return }
  }
  if (method === 'GET' && path === '/api/books') {
    const listed = [...books.values()].map(displayBook).filter((item) => item !== undefined)
    json(response, { books: listed })
    return
  }
  if (method === 'POST' && path === '/api/books') {
    const body = await readJson(request)
    const search = searches.get(body.searchId)
    const selected = search === undefined ? undefined : (Array.isArray(search.sourceIds) && search.sourceIds.length > 0 ? search.sourceIds : sources.filter((source) => source.enabled).map((source) => source.sourceId)).map((sourceId) => sources.find((source) => source.sourceId === sourceId)).filter((source) => source !== undefined).slice(0, 5).map((source) => candidateFor(source, search.keyword))[Number(body.candidateIndex ?? 0)]
    if (selected === undefined) { json(response, { error: { code: 'not-found', message: '测试搜索结果不存在' } }, 404); return }
    const targetBookId = typeof body.bookId === 'string' && books.has(body.bookId) ? body.bookId : BOOK_ID
    const editionKey = editionKeyForSource(selected.sourceId)
    const existing = editions.get(editionKey)
    const edition = existing ?? {
      id: randomUUID(), userId: USER_ID, bookId: targetBookId, editionKey, sourceId: selected.sourceId,
      sourceFingerprint: selected.sourceFingerprint, bookUrl: selected.candidate.bookUrl,
      metadata: { ...selected.candidate },
    }
    editions.set(editionKey, edition)
    const book = books.get(targetBookId) ?? { ...initialBook, id: targetBookId, activeEditionKey: editionKey, createdAt: now(), updatedAt: now() }
    books.set(targetBookId, book)
    if (body.addToBookshelf === true) bookshelf.add(targetBookId)
    if (body.activateEdition === true) book.activeEditionKey = editionKey
    book.updatedAt = now()
    if (!positions.has(`${targetBookId}:${editionKey}`)) {
      const chapter = chaptersFor(editionKey)[0]
      if (chapter !== undefined) positions.set(`${targetBookId}:${editionKey}`, { userId: USER_ID, bookId: targetBookId, editionKey, chapterId: chapter.chapterId, chapterUrl: chapter.chapterUrl, chapterIndex: 0, title: chapter.title, tocRevision: `fixture-toc-${editionKey}-1`, paragraphIndex: 0, offset: 0, version: 0, lastReadAt: now() })
    }
    json(response, { book, edition, cacheWarning: undefined }, 201)
    return
  }
  if (method === 'DELETE' && path.startsWith('/api/search-history/')) {
    const historyId = decodeURIComponent(path.slice('/api/search-history/'.length))
    const row = searchHistory.find((item) => item.id === historyId)
    if (row === undefined) { json(response, { error: { code: 'not-found', message: '测试搜索记录不存在' } }, 404); return }
    for (let index = searchHistory.length - 1; index >= 0; index -= 1) if (searchHistory[index]?.keyword.normalize('NFKC').trim().toLocaleLowerCase() === row.keyword.normalize('NFKC').trim().toLocaleLowerCase()) searchHistory.splice(index, 1)
    json(response, { ok: true })
    return
  }

  const bookRoute = path.match(/^\/api\/books\/([^/]+)(?:\/(.*))?$/u)
  if (bookRoute !== null) {
    const bookId = decodeURIComponent(bookRoute[1] ?? '')
    const tail = bookRoute[2] ?? ''
    const book = books.get(bookId)
    if (method === 'GET' && tail === 'details') {
      const details = detailFor(bookId, url.searchParams.get('editionKey') ?? '')
      if (details === null) { json(response, { error: { code: 'not-found', message: '测试书籍不存在' } }, 404); return }
      json(response, details)
      return
    }
    if (method === 'GET' && tail === 'editions') {
      if (book === undefined) { json(response, { error: { code: 'not-found', message: '测试书籍不存在' } }, 404); return }
      json(response, { editions: [...editions.values()].filter((edition) => edition.bookId === bookId), activeEditionKey: book.activeEditionKey })
      return
    }
    if (method === 'GET' && tail === 'sources') {
      const saved = [...editions.values()].filter((edition) => edition.bookId === bookId).map((edition) => ({ status: 'saved', sourceId: edition.sourceId, sourceFingerprint: edition.sourceFingerprint, name: book?.name ?? initialBook.name, bookUrl: edition.bookUrl, sourceEnabled: sources.find((source) => source.sourceId === edition.sourceId)?.enabled ?? false, editionKey: edition.editionKey }))
      json(response, { sources: saved, activeEditionKey: book?.activeEditionKey })
      return
    }
    if (method === 'POST' && /^sources\/[^/]+\/open$/u.test(tail)) {
      const candidateId = decodeURIComponent(tail.split('/')[1] ?? '')
      const candidate = [...searches.values()].flatMap((search) => search.sourceIds.map((sourceId) => sources.find((source) => source.sourceId === sourceId)).filter((source) => source !== undefined).map((source) => candidateFor(source, search.keyword))).find((item) => item.sourceId === candidateId)
      if (candidate === undefined) { json(response, { error: { code: 'not-found', message: '测试候选不存在' } }, 404); return }
      const editionKey = editionKeyForSource(candidate.sourceId)
      const edition = { id: randomUUID(), userId: USER_ID, bookId, editionKey, sourceId: candidate.sourceId, sourceFingerprint: candidate.sourceFingerprint, bookUrl: candidate.candidate.bookUrl, metadata: candidate.candidate }
      editions.set(editionKey, edition)
      json(response, { edition })
      return
    }
    if (method === 'PUT' && tail === 'edition') {
      const body = await readJson(request)
      if (book === undefined || editions.get(body.editionKey)?.bookId !== bookId) { json(response, { error: { code: 'not-found', message: '测试书籍版本不存在' } }, 404); return }
      book.activeEditionKey = body.editionKey
      book.updatedAt = now()
      json(response, { edition: editions.get(body.editionKey) })
      return
    }
    if ((method === 'PUT' || method === 'DELETE') && tail === 'bookshelf') {
      if (book === undefined) { json(response, { error: { code: 'not-found', message: '测试书籍不存在' } }, 404); return }
      if (method === 'PUT') bookshelf.add(bookId)
      else { bookshelf.delete(bookId); shelfGroups.delete(bookId) }
      json(response, { ok: true })
      return
    }
    if (method === 'GET' && tail === 'position') {
      json(response, { position: positionFor(bookId, url.searchParams.get('editionKey') ?? '') })
      return
    }
    if (method === 'POST' && tail === 'position') {
      const body = await readJson(request)
      const saved = { ...body, userId: USER_ID, bookId, lastReadAt: now() }
      positions.set(`${bookId}:${body.editionKey}`, saved)
      json(response, { position: saved })
      return
    }
    if (method === 'GET' && tail === 'toc') {
      const editionKey = url.searchParams.get('editionKey') ?? ''
      if (editions.get(editionKey)?.bookId !== bookId) { json(response, { error: { code: 'not-found', message: '测试书籍目录不存在' } }, 404); return }
      const refresh = url.searchParams.get('refresh') === 'true'
      if (refresh) refreshCounts.set(editionKey, (refreshCounts.get(editionKey) ?? 0) + 1)
      const revision = `fixture-toc-${editionKey}-${(refreshCounts.get(editionKey) ?? 0) + 1}`
      json(response, { toc: { userId: USER_ID, bookId, editionKey, sourceFingerprint: editions.get(editionKey).sourceFingerprint, revision, chapters: chaptersFor(editionKey), bookPatch: { name: book?.name ?? initialBook.name } } })
      return
    }
    const chapterMatch = tail.match(/^chapters\/([^/]+)$/u)
    if (method === 'GET' && chapterMatch !== null) {
      const editionKey = url.searchParams.get('editionKey') ?? ''
      const chapterId = decodeURIComponent(chapterMatch[1] ?? '')
      const chapter = chaptersFor(editionKey).find((item) => item.chapterId === chapterId)
      if (chapter === undefined) { json(response, { error: { code: 'not-found', message: '测试章节不存在' } }, 404); return }
      const refresh = url.searchParams.get('refresh') === 'true'
      if (refresh) refreshCounts.set(`content:${chapterId}`, (refreshCounts.get(`content:${chapterId}`) ?? 0) + 1)
      const revision = refreshCounts.get(`content:${chapterId}`) ?? 0
      const paragraphs = Array.from({ length: 28 }, (_, index) => `这是第 ${index + 1} 段模拟正文。用于检查阅读排版、字号、行距、翻章和章节刷新行为。${refresh && index === 0 ? `（刷新版本 ${revision}）` : ''}`)
      const content = { chapter, contentType: 'text', raw: paragraphs.join('\n\n'), cleaned: paragraphs.join('\n\n'), pages: paragraphs, resources: [], title: chapter.title }
      json(response, { content: { content, tocRevision: `fixture-toc-${editionKey}-${(refreshCounts.get(editionKey) ?? 0) + 1}` } })
      return
    }
  }

  json(response, { error: { code: 'not-found', message: `页面验收 API 未实现：${method} ${safeRouteLabel(path)}` } }, 404)
}

// 只在本地模拟服务提供的验收控制面，不进入生产入口。
const requestCounts = new Map()
const faults = new Map()
const secondSettings = { ...structuredClone(settings), userId: session(true).user.id }
const initialState = structuredClone({ sources, books, editions, positions, bookshelf, settings })
function resetFixture() {
  organizations.clear(); shelfGroups.clear()
  sources.splice(0, sources.length, ...structuredClone(initialState.sources))
  for (const [target, original] of [[books, initialState.books], [editions, initialState.editions], [positions, initialState.positions]]) { target.clear(); for (const [key, value] of structuredClone(original)) target.set(key, value) }
  bookshelf.clear(); for (const id of initialState.bookshelf) bookshelf.add(id)
  Object.assign(settings, structuredClone(initialState.settings)); Object.assign(secondSettings, structuredClone(initialState.settings), { userId: session(true).user.id })
  searches.clear(); searchHistory.splice(0); refreshCounts.clear(); requestCounts.clear(); faults.clear(); searchSequence = 0; discoveryFailure = true; discoveryBookFailure = true
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`)
  if (url.pathname === '/__fixture/status') { json(response, { counts: Object.fromEntries(requestCounts) }); return }
  if (url.pathname === '/__fixture/control' && request.method === 'POST') {
    const control = await readJson(request)
    if (control.reset) resetFixture()
    if (typeof control.route === 'string') faults.set(control.route, { delay: Math.min(10000, Math.max(0, Number(control.delay) || 0)), failures: Math.min(10, Math.max(0, Number(control.failures) || 0)) })
    json(response, { ok: true }); return
  }
  if (url.pathname.startsWith('/auth/v1/')) {
    try { if (await handleAuth(request, response, url)) return }
    catch (error) { json(response, { message: error instanceof Error ? error.message : '测试认证请求失败' }, 400, corsHeaders(request.headers.origin ?? '')); return }
  }
  if (!url.pathname.startsWith('/api/')) { json(response, { message: '此端口只提供页面验收 API，请通过 http://localhost:3000 打开前端' }, 404); return }
  logRequest(request, url)
  const route = `${request.method} ${url.pathname}`
  requestCounts.set(route, (requestCounts.get(route) ?? 0) + 1)
  const fault = faults.get(route)
  if (fault?.delay) await new Promise((resolve) => setTimeout(resolve, fault.delay))
  if (fault?.failures > 0) { fault.failures--; json(response, { error: { code: 'fixture-failure', message: '页面验收注入失败，可重试' } }, 503); return }
  try { await handleApi(request, response, url) }
  catch (error) { json(response, { error: { code: 'fixture-error', message: error instanceof Error ? error.message : '页面验收请求失败' } }, 400) }
})

server.listen(PORT, HOST, () => {
  console.log(`reader-web 页面验收 API 已启动：http://${HOST}:${PORT}`)
  console.log(`测试账号：${FIXTURE_EMAIL} / ${FIXTURE_PASSWORD}`)
  console.log('数据只保存在当前进程内，停止服务后会重置；请求日志不包含请求体、Authorization 或搜索词。')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
