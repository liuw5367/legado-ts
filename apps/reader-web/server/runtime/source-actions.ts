import { executePayAction, executeSourceCallback, type BookMetadata, type ChapterIdentity, type RuntimeResult, type SourceCallbackResult, type SourcePayActionResult, type WorkflowAction } from '@legado/source-core'
import type { SourceCallbackInput, SourcePayActionInput, SourceWorkflowAction } from '../../shared/source-actions.ts'
import type { ReaderRepository } from '../db/repository.ts'
import { ReaderRuntimeError, requireSource, withPersistentSourceSession } from './source-session.ts'

const recentOperations = new Map<string, number>()
const OPERATION_TTL_MS = 10 * 60 * 1000
const MAX_RECENT_OPERATIONS = 10_000

export async function runSourcePayAction(repository: ReaderRepository, userId: string, input: SourcePayActionInput, signal?: AbortSignal): Promise<RuntimeResult<SourcePayActionResult> & { duplicate?: boolean; actions: SourceWorkflowAction[] }> {
  const source = await requireSource(repository, userId, input.sourceId)
  verifySource(source.fingerprint, input.fingerprint)
  if (markOperation(userId, input.sourceId, input.operationId)) return { status: 'empty', value: { kind: 'empty' }, diagnostics: [], trace: [], duplicate: true, actions: [] }
  const actions: SourceWorkflowAction[] = []
  const result = await withPersistentSourceSession(repository, userId, source, async (session) => session.run((ports) => executePayAction(ports, {
    source: source.normalizedSource,
    book: input.book as BookMetadata,
    chapter: input.chapter as ChapterIdentity & { title?: string; variable?: string; rawFields?: Record<string, unknown> },
    ...(input.payAction === undefined ? {} : { payAction: input.payAction }),
    workflowActions: createWorkflowActions(actions),
    ...(signal === undefined ? {} : { signal }),
  })))
  return { ...result, actions }
}

export async function runSourceCallback(repository: ReaderRepository, userId: string, input: SourceCallbackInput, signal?: AbortSignal): Promise<RuntimeResult<SourceCallbackResult> & { duplicate?: boolean; actions: SourceWorkflowAction[] }> {
  const source = await requireSource(repository, userId, input.sourceId)
  verifySource(source.fingerprint, input.fingerprint)
  if (markOperation(userId, input.sourceId, input.operationId)) return { status: 'empty', value: { handled: false }, diagnostics: [], trace: [], duplicate: true, actions: [] }
  const actions: SourceWorkflowAction[] = []
  const result = await withPersistentSourceSession(repository, userId, source, async (session) => session.run((ports) => executeSourceCallback(ports, {
    source: source.normalizedSource,
    event: input.event,
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(input.book === undefined ? {} : { book: input.book as BookMetadata }),
    ...(input.chapter === undefined ? {} : { chapter: input.chapter as ChapterIdentity & { title?: string; variable?: string; rawFields?: Record<string, unknown> } }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    workflowActions: createWorkflowActions(actions),
    ...(signal === undefined ? {} : { signal }),
  })))
  return { ...result, actions }
}

function createWorkflowActions(actions: SourceWorkflowAction[]): Readonly<Record<string, WorkflowAction>> {
  const record = (action: string): WorkflowAction => async () => { actions.push({ action }); return undefined }
  return Object.fromEntries([
    'refreshBookInfo', 'refreshBookToc', 'refreshContent', 'refreshExplore', 'reGetBook', 'refreshTocUrl', 'reUiView', 'upUiData', 'copyText', 'clearTtsCache', 'searchBook', 'addBook', 'showPhoto', 'open', 'saveInfoMap',
  ].map((action) => [action, record(action)]))
}

function verifySource(actual: string, expected: string): void {
  if (actual !== expected) throw new ReaderRuntimeError('invalid-input', '书源已更新，请刷新后重试')
}

function markOperation(userId: string, sourceId: string, operationId: string): boolean {
  const now = Date.now()
  for (const [key, expiresAt] of recentOperations) if (expiresAt <= now) recentOperations.delete(key)
  const key = `${userId}\u0000${sourceId}\u0000${operationId}`
  if (recentOperations.has(key)) return true
  while (recentOperations.size >= MAX_RECENT_OPERATIONS) {
    const oldest = recentOperations.keys().next().value
    if (typeof oldest !== 'string') break
    recentOperations.delete(oldest)
  }
  recentOperations.set(key, now + OPERATION_TTL_MS)
  return false
}
