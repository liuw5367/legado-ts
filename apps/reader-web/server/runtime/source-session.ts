import { randomUUID } from 'node:crypto'
import { NodeCookieStore, createNodeSourceSession } from '@legado/source-node'
import type { SourceSession } from '@legado/source-core'
import type { ReaderRepository, StoredSourceRecord } from '../db/repository.ts'
import type { RuntimeStateSnapshot } from '../domain/types.ts'

const SOURCE_RUNTIME_LEASE_MS = 5 * 60 * 1000

export interface PersistentSourceState {
  /** Android InfoMap 的当前快照；仅在本次租约内向书源脚本暴露。 */
  infoMap: Record<string, string>
  replaceInfoMap(value: unknown): void
  /** 已解析分类的不可变快照，避免分页请求重新执行动态分类脚本。 */
  discovery?: NonNullable<RuntimeStateSnapshot['discovery']>
  replaceDiscovery(value: NonNullable<RuntimeStateSnapshot['discovery']>): void
}

export class ReaderRuntimeError extends Error {
  public readonly code: 'not-found' | 'invalid-input' | 'source-failed' | 'configuration' | 'source-busy'
  public constructor(code: 'not-found' | 'invalid-input' | 'source-failed' | 'configuration' | 'source-busy', message: string) { super(message); this.code = code }
}

export async function requireSource(repository: ReaderRepository, userId: string, sourceId: string): Promise<StoredSourceRecord> {
  const source = await repository.getSourceForUser(userId, sourceId)
  if (source === null) throw new ReaderRuntimeError('configuration', `书源不可用：${sourceId}`)
  return source
}

/** 搜索、发现和阅读共用同一书源租约；无论业务操作成功与否均结算状态并关闭会话。 */
export async function withPersistentSourceSession<T>(repository: ReaderRepository, userId: string, source: StoredSourceRecord, operation: (session: SourceSession, state: PersistentSourceState) => Promise<T>): Promise<T> {
  const leaseToken = randomUUID()
  const lease = await repository.acquireSourceRuntimeLease(userId, source.sourceId, source.fingerprint, leaseToken, SOURCE_RUNTIME_LEASE_MS)
  if (lease === null) throw new ReaderRuntimeError('source-busy', '该书源正在被其他请求使用，请稍后重试')
  let session: SourceSession | undefined
  let result!: T
  let primaryError: unknown
  let stateSaved = false
  try {
    const cookieStore = lease.snapshot.cookies === undefined ? new NodeCookieStore() : NodeCookieStore.fromSerialized(lease.snapshot.cookies)
    const infoMap: Record<string, string> = { ...(lease.snapshot.infoMap ?? {}) }
    const state: PersistentSourceState = {
      infoMap,
      ...(lease.snapshot.discovery?.fingerprint === source.fingerprint ? { discovery: structuredClone(lease.snapshot.discovery) } : {}),
      replaceInfoMap(value) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return
        for (const key of Object.keys(infoMap)) delete infoMap[key]
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (typeof item === 'string') infoMap[key] = item
      },
      replaceDiscovery(value) {
        state.discovery = structuredClone(value)
      },
    }
    session = createNodeSourceSession(source.normalizedSource, { cookieStore, ...(lease.snapshot.variables === undefined ? {} : { initialVariables: lease.snapshot.variables }) })
    try {
      result = await operation(session, state)
    } catch (error) {
      primaryError = error
    }
    const snapshot = snapshotRuntimeState(session, cookieStore, state)
    const saved = await repository.saveSourceRuntimeState(userId, source.sourceId, source.fingerprint, lease.leaseToken, lease.version, snapshot)
    if (saved === null) throw new ReaderRuntimeError('source-busy', '书源运行状态已被其他请求更新，请稍后重试')
    stateSaved = true
  } catch (error) {
    if (primaryError === undefined) primaryError = error
  } finally {
    session?.close()
    if (!stateSaved) {
      try {
        await repository.releaseSourceRuntimeLease(userId, source.sourceId, source.fingerprint, lease.leaseToken)
      } catch (releaseError) {
        if (primaryError === undefined) primaryError = releaseError
      }
    }
  }
  if (primaryError !== undefined) throw primaryError
  return result
}

function snapshotRuntimeState(session: SourceSession, cookieStore: NodeCookieStore, state: PersistentSourceState): RuntimeStateSnapshot {
  const variables = session.snapshotVariables()
  return {
    cookies: cookieStore.serialize(),
    ...(Object.keys(variables).length === 0 ? {} : { variables: { ...variables } }),
    ...(Object.keys(state.infoMap).length === 0 ? {} : { infoMap: { ...state.infoMap } }),
    ...(state.discovery === undefined ? {} : { discovery: structuredClone(state.discovery) }),
  }
}
