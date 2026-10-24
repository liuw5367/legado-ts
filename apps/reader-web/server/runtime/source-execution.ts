import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { withUser } from '../db/client.ts'
import { sourceExecutionSlots } from '../db/schema.ts'

export const SOURCE_CONCURRENCY = 4
export const GLOBAL_SOURCE_CONCURRENCY = 8
export const SOURCE_EXECUTION_MS = 5_000
export const SEARCH_BATCH_SIZE = 8
export const SEARCH_BATCH_MS = 25_000
export interface ExecutionLease { token: string; slotId: number }

export async function acquireExecutionSlot(userId: string, operationId: string): Promise<ExecutionLease | null> {
  return withUser(userId, async (tx) => {
    // 账号锁保证并发领取时统计一致，槽位行锁保证多个实例不能领取同一额度。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId + ':execution'}, 0))`)
    const [active] = await tx.select({ value: sql<number>`count(*)::int` }).from(sourceExecutionSlots).where(and(eq(sourceExecutionSlots.userId, userId), sql`${sourceExecutionSlots.leaseUntil} > now()`))
    if ((active?.value ?? 0) >= SOURCE_CONCURRENCY) return null
    const [free] = await tx.select().from(sourceExecutionSlots).where(sql`${sourceExecutionSlots.leaseUntil} is null or ${sourceExecutionSlots.leaseUntil} <= now()`).orderBy(sourceExecutionSlots.slotId).limit(1).for('update', { skipLocked: true })
    if (!free) return null
    const token = randomUUID()
    await tx.update(sourceExecutionSlots).set({ userId, operationId, leaseToken: token, leaseUntil: sql`now() + interval '20 seconds'` }).where(eq(sourceExecutionSlots.slotId, free.slotId))
    return { token, slotId: free.slotId }
  })
}
export async function releaseExecutionSlot(userId: string, lease: ExecutionLease): Promise<void> {
  await withUser(userId, async (tx) => { await tx.update(sourceExecutionSlots).set({ userId: null, operationId: null, leaseToken: null, leaseUntil: null }).where(and(eq(sourceExecutionSlots.slotId, lease.slotId), eq(sourceExecutionSlots.userId, userId), eq(sourceExecutionSlots.leaseToken, lease.token))) })
}

const memorySlots = new Map<number, { userId: string; token: string; expiresAt: number }>()
export function acquireMemoryExecutionSlot(userId: string): ExecutionLease | null {
  for (const [id, slot] of memorySlots) if (slot.expiresAt <= Date.now()) memorySlots.delete(id)
  if ([...memorySlots.values()].filter((slot) => slot.userId === userId).length >= SOURCE_CONCURRENCY) return null
  for (let id = 1; id <= GLOBAL_SOURCE_CONCURRENCY; id++) if (!memorySlots.has(id)) {
    const token = randomUUID(); memorySlots.set(id, { userId, token, expiresAt: Date.now() + 20_000 }); return { token, slotId: id }
  }
  return null
}
export function releaseMemoryExecutionSlot(userId: string, lease: ExecutionLease): void {
  const slot = memorySlots.get(lease.slotId)
  if (slot?.userId === userId && slot.token === lease.token) memorySlots.delete(lease.slotId)
}
