import { createInterface } from 'node:readline'
import { FlowFixtureError } from '../ts/book-flow.ts'
import { execute, ObservedError, UnsupportedOperation } from '../ts/adapter.ts'

for await (const line of createInterface({ input: process.stdin })) {
  const item = JSON.parse(line)
  let result
  try {
    const value = await execute(item)
    result = { id: item.id, execution: 'completed', outcome: 'return', value: value === undefined ? { type: 'undefined' } : value }
  } catch (error) {
    result = error instanceof UnsupportedOperation
      ? { id: item.id, execution: 'unsupported', reason: error.message }
      : item.operation === 'flow.book' || error instanceof FlowFixtureError
      ? { id: item.id, execution: 'runner-failed', reason: error.message }
      : { id: item.id, execution: 'completed', outcome: 'throw', error: { class: error instanceof ObservedError ? error.rawClass : error.name, message: error.message } }
  }
  console.log(JSON.stringify(result))
}
