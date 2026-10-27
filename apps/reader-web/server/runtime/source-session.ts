import { randomUUID } from 'node:crypto'
import { KeyedConcurrencyHost, NodeCookieStore, createNodeSourceSession } from '@legado/source-node'
import type { NodeSourceSession, NodeSourceRuntimeSnapshot } from '@legado/source-node'
import type { InfoMapSaveRequest, SourceSession } from '@legado/source-core'
import type { ReaderRepository, StoredSourceRecord } from '../db/repository.ts'
import type { RuntimeStateSnapshot } from '../domain/types.ts'
import { sourceFileRoot } from '../db/runtime-state-crypto.ts'

const SOURCE_RUNTIME_LEASE_MS = 5 * 60 * 1000
/**
 * 目录/正文并行分页的并发上限。Android 用 threadCount（默认 32）并行抓取，
 * Web 部署在单个 Vercel 函数内，必须给外连扇出设硬上限，避免一个书源把
 * 200 个分页请求同时打出去。
 */
const SOURCE_PAGE_CONCURRENCY = 6

export interface PersistentSourceState {
  /** Android InfoMap 的当前快照；仅在本次租约内向书源脚本暴露。 */
  infoMap: Record<string, string>
  /** Last map explicitly committed by InfoMap.save/saveNow or an application control update. */
  savedInfoMap: Record<string, string>
  infoMapSaveTime: number
  infoMapNeedsSave: boolean
  savedInfoMapExpiresAt: number | undefined
  replaceInfoMap(value: unknown): void
  applyInfoMapSave(request: InfoMapSaveRequest): void
  snapshotInfoMap(): { infoMap?: Record<string, string>; infoMapExpiresAt?: number }
  /** 已解析分类的不可变快照，避免分页请求重新执行动态分类脚本。 */
  discovery?: NonNullable<RuntimeStateSnapshot['discovery']> | undefined
  /** 已签发发现游标使用的单调代次；刷新后递增，防止迟到游标写回新筛选。 */
  discoveryGeneration: number
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
    const infoMapExpired = lease.snapshot.infoMapExpiresAt !== undefined && lease.snapshot.infoMapExpiresAt <= Date.now()
    const infoMap: Record<string, string> = infoMapExpired ? {} : { ...(lease.snapshot.infoMap ?? {}) }
    const savedInfoMap: Record<string, string> = { ...infoMap }
    const state: PersistentSourceState = {
      infoMap,
      savedInfoMap,
      infoMapSaveTime: 0,
      infoMapNeedsSave: false,
      savedInfoMapExpiresAt: infoMapExpired ? undefined : lease.snapshot.infoMapExpiresAt,
      ...(lease.snapshot.discovery?.fingerprint === source.fingerprint ? { discovery: structuredClone(lease.snapshot.discovery) } : {}),
      discoveryGeneration: lease.snapshot.discovery?.fingerprint === source.fingerprint ? lease.snapshot.discovery.generation ?? 0 : 0,
      replaceInfoMap(value) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return
        for (const key of Object.keys(infoMap)) delete infoMap[key]
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (typeof item === 'string') infoMap[key] = item
      },
      applyInfoMapSave(request) {
        if (!request.now) {
          state.infoMapSaveTime = request.time
          state.infoMapNeedsSave = request.need
          return
        }
        state.infoMapNeedsSave = false
        state.infoMapSaveTime = request.time
        if (request.need) {
          for (const key of Object.keys(savedInfoMap)) delete savedInfoMap[key]
          Object.assign(savedInfoMap, request.infoMap)
          state.savedInfoMapExpiresAt = request.time > 0 ? Date.now() + request.time * 1000 : undefined
        }
      },
      snapshotInfoMap() {
        if (!state.infoMapNeedsSave && Object.keys(savedInfoMap).length === 0) return {}
        if (state.infoMapNeedsSave) {
          for (const key of Object.keys(savedInfoMap)) delete savedInfoMap[key]
          Object.assign(savedInfoMap, state.infoMap)
          state.savedInfoMapExpiresAt = state.infoMapSaveTime > 0 ? Date.now() + state.infoMapSaveTime * 1000 : undefined
        }
        const entries = Object.keys(savedInfoMap)
        return {
          ...(entries.length === 0 ? {} : { infoMap: { ...savedInfoMap } }),
          ...(state.savedInfoMapExpiresAt === undefined ? {} : { infoMapExpiresAt: state.savedInfoMapExpiresAt }),
        }
      },
      replaceDiscovery(value) {
        const next = structuredClone(value)
        const previous = state.discovery
        const same = previous !== undefined && JSON.stringify({ ...previous, generation: undefined }) === JSON.stringify({ ...next, generation: undefined })
        if (!same) state.discoveryGeneration = Math.max(state.discoveryGeneration + 1, value.generation ?? 0)
        state.discovery = { ...next, generation: state.discoveryGeneration }
      },
    }
    session = createNodeSourceSession(source.normalizedSource, {
      cookieStore,
      concurrency: new KeyedConcurrencyHost({ maxConcurrent: SOURCE_PAGE_CONCURRENCY }),
      ...(lease.snapshot.variables === undefined ? {} : { initialVariables: lease.snapshot.variables }),
      ...(lease.snapshot.nodeRuntime === undefined ? {} : { initialRuntimeState: lease.snapshot.nodeRuntime as NodeSourceRuntimeSnapshot }),
      fileRoot: sourceFileRoot(userId, source.sourceId, source.fingerprint),
    })
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
  const nodeRuntime = (session as Partial<NodeSourceSession>).snapshotRuntimeState?.()
  return {
    cookies: cookieStore.serialize(),
    ...(Object.keys(variables).length === 0 ? {} : { variables: { ...variables } }),
    ...state.snapshotInfoMap(),
    ...(state.discovery === undefined ? {} : { discovery: structuredClone(state.discovery) }),
    ...(nodeRuntime === undefined ? {} : { nodeRuntime }),
  }
}
