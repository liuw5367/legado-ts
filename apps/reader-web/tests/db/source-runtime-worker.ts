import { closeReaderDb } from '../../server/db/client.ts'
import { PostgresReaderRepository } from '../../server/db/repository.ts'

interface WorkerInput {
  operation: 'acquire' | 'acquire-save'
  userId: string
  sourceId: string
  sourceFingerprint: string
  leaseToken: string
  leaseMs: number
  snapshot?: Record<string, unknown>
}

const input = JSON.parse(process.argv[2] ?? '{}') as WorkerInput
const repository = new PostgresReaderRepository()

try {
  const lease = await repository.acquireSourceRuntimeLease(input.userId, input.sourceId, input.sourceFingerprint, input.leaseToken, input.leaseMs)
  if (lease === null) {
    process.stdout.write(JSON.stringify({ acquired: false, leaseVersion: null, savedVersion: null }))
  } else if (input.operation === 'acquire') {
    process.stdout.write(JSON.stringify({ acquired: true, leaseVersion: lease.version, savedVersion: null }))
  } else {
    const saved = await repository.saveSourceRuntimeState(input.userId, input.sourceId, input.sourceFingerprint, lease.leaseToken, lease.version, input.snapshot ?? {})
    process.stdout.write(JSON.stringify({ acquired: true, leaseVersion: lease.version, savedVersion: saved?.version ?? null }))
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await closeReaderDb()
}
